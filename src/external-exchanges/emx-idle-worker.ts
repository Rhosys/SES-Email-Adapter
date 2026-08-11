import { DateTime } from "luxon";
import { ok } from "../errors.js";
import type { Result } from "../errors.js";
import type { ExternalMailExchange } from "../types/index.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
import type { Logger } from "../logger.js";
import type { ImapAdapter } from "./imap-adapter.js";
import type { JmapAdapter } from "./jmap-adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const JMAP_POLL_INTERVAL_MS = 60_000;   // 60 seconds between queryChanges iterations
const JMAP_POLL_ITERATIONS = 5;
const RECENT_SYNC_THRESHOLD_MS = 5 * 60 * 1000; // skip if synced within 5 minutes

// ---------------------------------------------------------------------------
// EmxIdleWorker
// ---------------------------------------------------------------------------

export interface EmxIdlePayload {
  accountId: string;
}

interface EmxIdleWorkerDeps {
  logger: Logger;
  db: AccountDatabase;
  imapAdapter: ImapAdapter;
  jmapAdapter: JmapAdapter;
  signalQueue: SignalQueue;
}

export class EmxIdleWorker {
  private readonly logger: Logger;
  private readonly db: AccountDatabase;
  private readonly imapAdapter: ImapAdapter;
  private readonly jmapAdapter: JmapAdapter;
  private readonly signalQueue: SignalQueue;

  constructor(deps: EmxIdleWorkerDeps) {
    this.logger = deps.logger;
    this.db = deps.db;
    this.imapAdapter = deps.imapAdapter;
    this.jmapAdapter = deps.jmapAdapter;
    this.signalQueue = deps.signalQueue;
  }

  async process(payload: EmxIdlePayload): Promise<Result<void, never>> {
    const { accountId } = payload;

    // Load all exchanges for this account
    const listResult = await this.db.listExternalExchanges(accountId);
    if (listResult.isErr()) {
      this.logger.error("emx_idle: failed to list exchanges", { code: "emx.idle.list_failed", accountId, error: listResult.error });
      return ok(undefined);
    }

    // Filter to IMAP/JMAP only (gmail/outlook have webhooks)
    const exchanges = listResult.value.filter(emx => emx.status === "active" && (emx.platform === "imap" || emx.platform === "jmap"));

    this.logger.info("emx_idle: starting", { code: "emx.idle.start", accountId, exchangeCount: exchanges.length });

    if (exchanges.length === 0) {
      this.logger.info("emx_idle: no IMAP/JMAP exchanges for account", { code: "emx.idle.no_exchanges", accountId });
      return ok(undefined);
    }

    const now = DateTime.utc();
    const tasks: Array<Promise<{ emxId: string; outcome: string }>> = [];

    for (const emx of exchanges) {
      // Dedup: skip if synced recently (R4.12)
      if (emx.lastSyncAt) {
        const lastSync = DateTime.fromISO(emx.lastSyncAt);
        const elapsedMs = now.diff(lastSync).as("milliseconds");
        if (elapsedMs < RECENT_SYNC_THRESHOLD_MS) {
          const minutesAgo = Math.round(elapsedMs / 60_000);
          this.logger.info("emx_idle: skipping recently synced exchange", { code: "emx.idle.dedup_skip", emxId: emx.id, minutesAgo });
          continue;
        }
      }

      // Skip JMAP exchanges with active push subscription (R1.2)
      if (emx.platform === "jmap" && emx.pushSubscriptionId) {
        this.logger.info("emx_idle: skipping JMAP exchange with active push", { code: "emx.idle.push_skip", emxId: emx.id });
        continue;
      }

      if (emx.platform === "imap") {
        tasks.push(this.processImap(emx));
      } else {
        tasks.push(this.processJmap(emx));
      }
    }

    if (tasks.length === 0) {
      this.logger.info("emx_idle: all exchanges skipped", { code: "emx.idle.all_skipped", accountId });
      return ok(undefined);
    }

    // Run all concurrently (R1.2)
    const results = await Promise.allSettled(tasks);

    const outcomes: Array<{ emxId: string; outcome: string }> = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        outcomes.push(result.value);
      } else {
        outcomes.push({ emxId: "unknown", outcome: `rejected: ${String(result.reason)}` });
      }
    }

    this.logger.info("emx_idle: completed", { code: "emx.idle.done", accountId, outcomes });
    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // IMAP path
  // ---------------------------------------------------------------------------

  private async processImap(emx: ExternalMailExchange): Promise<{ emxId: string; outcome: string }> {
    const result = await this.imapAdapter.idle(emx, IDLE_TIMEOUT_MS);
    if (result.isErr()) {
      this.logger.warn("emx_idle: IMAP connection failed or dropped", { code: "emx.idle.imap_connect_failed", emxId: emx.id, error: result.error });
      return { emxId: emx.id, outcome: `error: ${result.error.reason}` };
    }

    if (result.value === "timeout") {
      this.logger.info("emx_idle: IMAP IDLE timed out, no new mail", { code: "emx.idle.imap_timeout", emxId: emx.id });
      return { emxId: emx.id, outcome: "idle-timeout" };
    }

    // New mail detected — enqueue targeted emx_dispatch
    this.logger.info("emx_idle: IMAP new mail detected", { code: "emx.idle.imap_new_mail", emxId: emx.id });
    const sendResult = await this.signalQueue.send("emx_dispatch", { emxId: emx.id, accountId: emx.accountId });
    if (sendResult.isErr()) {
      this.logger.error("emx_idle: failed to enqueue emx_dispatch after detecting new mail", { code: "emx.idle.enqueue_failed", emxId: emx.id, error: sendResult.error });
      return { emxId: emx.id, outcome: "error: enqueue failed" };
    }

    return { emxId: emx.id, outcome: "new-mail-detected" };
  }

  // ---------------------------------------------------------------------------
  // JMAP path
  // ---------------------------------------------------------------------------

  private async processJmap(emx: ExternalMailExchange): Promise<{ emxId: string; outcome: string }> {
    const result = await this.jmapAdapter.poll(emx, JMAP_POLL_ITERATIONS, JMAP_POLL_INTERVAL_MS);
    if (result.isErr()) {
      const cause = typeof result.error.cause === "string" ? result.error.cause : String(result.error.cause);
      if (cause === "invalid credentials") {
        this.logger.warn("emx_idle: JMAP authentication failed", { code: "emx.idle.jmap_auth_failed", emxId: emx.id });
      } else {
        this.logger.warn("emx_idle: JMAP polling failed", { code: "emx.idle.jmap_session_failed", emxId: emx.id, cause });
      }
      return { emxId: emx.id, outcome: `error: ${cause}` };
    }

    if (result.value === "timeout") {
      this.logger.info("emx_idle: JMAP polling complete, no new mail", { code: "emx.idle.jmap_timeout", emxId: emx.id });
      return { emxId: emx.id, outcome: "idle-timeout" };
    }

    // New mail detected — enqueue targeted emx_dispatch
    this.logger.info("emx_idle: JMAP new mail detected", { code: "emx.idle.jmap_new_mail", emxId: emx.id });
    const sendResult = await this.signalQueue.send("emx_dispatch", { emxId: emx.id, accountId: emx.accountId });
    if (sendResult.isErr()) {
      this.logger.error("emx_idle: failed to enqueue emx_dispatch after detecting changes", { code: "emx.idle.enqueue_failed", emxId: emx.id, error: sendResult.error });
      return { emxId: emx.id, outcome: "error: enqueue failed" };
    }

    return { emxId: emx.id, outcome: "new-mail-detected" };
  }
}
