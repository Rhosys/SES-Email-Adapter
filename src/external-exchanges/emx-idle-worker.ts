import { DateTime } from "luxon";
import { ok } from "../errors.js";
import type { Result } from "../errors.js";
import type { ExternalMailExchange } from "../types/index.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { EncryptionManager } from "../secrets/encryption-manager.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
import type { Logger } from "../logger.js";
import { ImapConnection } from "./imap-adapter.js";
import { buildBasicAuth, fetchSession, jmapCall, JMAP_USING } from "./jmap-adapter.js";

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
  encryptionManager: EncryptionManager;
  signalQueue: SignalQueue;
}

export class EmxIdleWorker {
  private readonly logger: Logger;
  private readonly db: AccountDatabase;
  private readonly encryptionManager: EncryptionManager;
  private readonly signalQueue: SignalQueue;

  constructor(deps: EmxIdleWorkerDeps) {
    this.logger = deps.logger;
    this.db = deps.db;
    this.encryptionManager = deps.encryptionManager;
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
    const config = emx.imapConfig;
    if (!config) {
      this.logger.warn("emx_idle: IMAP exchange missing config", { code: "emx.idle.imap_no_config", emxId: emx.id });
      return { emxId: emx.id, outcome: "error: missing imapConfig" };
    }

    let password: string;
    try {
      password = this.encryptionManager.decrypt(config.encryptedPassword);
    } catch (e) {
      this.logger.warn("emx_idle: IMAP password decryption failed", { code: "emx.idle.imap_decrypt_failed", emxId: emx.id, host: config.host, error: e });
      return { emxId: emx.id, outcome: "error: decryption failed" };
    }

    const redactedUser = config.username.slice(0, 3) + "***";
    const conn = new ImapConnection({ host: config.host, tlsConfig: config.tlsConfig, username: config.username, password, timeout: 30_000 });

    const connectResult = await conn.connect();
    if (connectResult.isErr()) {
      this.logger.warn("emx_idle: IMAP connection failed", { code: "emx.idle.imap_connect_failed", emxId: emx.id, host: config.host, username: redactedUser, error: connectResult.error });
      return { emxId: emx.id, outcome: "error: connection failed" };
    }

    this.logger.info("emx_idle: IMAP connected, entering IDLE", { code: "emx.idle.imap_connected", emxId: emx.id, host: config.host, username: redactedUser });

    const idleResult = await conn.idle(IDLE_TIMEOUT_MS);
    await conn.logout();

    if (idleResult.isErr()) {
      // Connection dropped mid-IDLE (R4.14)
      this.logger.warn("emx_idle: IMAP connection dropped during IDLE", { code: "emx.idle.imap_dropped", emxId: emx.id, error: idleResult.error });
      return { emxId: emx.id, outcome: "error: connection dropped during IDLE" };
    }

    if (idleResult.value === "timeout") {
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
    const config = emx.jmapConfig;
    if (!config) {
      this.logger.warn("emx_idle: JMAP exchange missing config", { code: "emx.idle.jmap_no_config", emxId: emx.id });
      return { emxId: emx.id, outcome: "error: missing jmapConfig" };
    }

    let password: string;
    try {
      password = this.encryptionManager.decrypt(config.encryptedPassword);
    } catch (e) {
      this.logger.warn("emx_idle: JMAP password decryption failed", { code: "emx.idle.jmap_decrypt_failed", emxId: emx.id, error: e });
      return { emxId: emx.id, outcome: "error: decryption failed" };
    }

    const auth = buildBasicAuth(config.username, password);

    // Fetch session
    const sessionResult = await fetchSession(config.sessionUrl, auth, 30_000);
    if (sessionResult.isErr()) {
      const cause = sessionResult.error.cause;
      if (cause === "invalid credentials") {
        this.logger.warn("emx_idle: JMAP authentication failed", { code: "emx.idle.jmap_auth_failed", emxId: emx.id });
      } else {
        this.logger.warn("emx_idle: JMAP session fetch failed", { code: "emx.idle.jmap_session_failed", emxId: emx.id, cause });
      }
      return { emxId: emx.id, outcome: `error: ${cause}` };
    }

    const session = sessionResult.value;
    const jmapAccountId = session.primaryAccounts["urn:ietf:params:jmap:mail"]!;
    const sinceQueryState = emx.syncCursor;

    if (!sinceQueryState) {
      this.logger.warn("emx_idle: JMAP exchange has no syncCursor", { code: "emx.idle.jmap_no_cursor", emxId: emx.id });
      return { emxId: emx.id, outcome: "error: no syncCursor" };
    }

    // Poll queryChanges up to 5 times, 60s apart
    for (let i = 0; i < JMAP_POLL_ITERATIONS; i++) {
      this.logger.info("emx_idle: JMAP queryChanges iteration", { code: "emx.idle.jmap_iteration", emxId: emx.id, iteration: i + 1 });

      const changesResult = await jmapCall(session.apiUrl, auth, JMAP_USING, [
        ["Email/queryChanges", {
          accountId: jmapAccountId,
          filter: { inMailbox: config.inboxId },
          sort: [{ property: "receivedAt", isAscending: false }],
          sinceQueryState,
          maxChanges: 1,
        }, "qc0"],
      ], 30_000);

      if (changesResult.isErr()) {
        const cause = changesResult.error.cause;
        if (cause === "invalid credentials") {
          this.logger.warn("emx_idle: JMAP credentials rejected during polling", { code: "emx.idle.jmap_poll_auth_failed", emxId: emx.id });
          return { emxId: emx.id, outcome: "error: credentials rejected" };
        }
        // Transient failure — continue to next iteration
        this.logger.info("emx_idle: JMAP queryChanges failed, will retry", { code: "emx.idle.jmap_poll_transient", emxId: emx.id, iteration: i + 1, cause });
        if (i < JMAP_POLL_ITERATIONS - 1) {
          await new Promise(r => setTimeout(r, JMAP_POLL_INTERVAL_MS));
        }
        continue;
      }

      const response = changesResult.value[0] as [string, Record<string, unknown>, string] | undefined;

      // Check for cannotCalculateChanges error — treat as new mail (state diverged)
      if (response && response[0] === "error") {
        const errorType = (response[1] as { type?: string }).type;
        if (errorType === "cannotCalculateChanges") {
          this.logger.info("emx_idle: JMAP cannotCalculateChanges — treating as new mail", { code: "emx.idle.jmap_cannot_calculate", emxId: emx.id });
          const sendResult = await this.signalQueue.send("emx_dispatch", { emxId: emx.id, accountId: emx.accountId });
          if (sendResult.isErr()) {
            this.logger.error("emx_idle: failed to enqueue emx_dispatch after detecting changes", { code: "emx.idle.enqueue_failed", emxId: emx.id, error: sendResult.error });
            return { emxId: emx.id, outcome: "error: enqueue failed" };
          }
          return { emxId: emx.id, outcome: "new-mail-detected" };
        }
        this.logger.warn("emx_idle: JMAP error response", { code: "emx.idle.jmap_error", emxId: emx.id, errorType });
        return { emxId: emx.id, outcome: `error: JMAP ${errorType}` };
      }

      if (response) {
        const data = response[1] as { added?: unknown[]; removed?: unknown[]; newQueryState?: string };
        const addedCount = data.added?.length ?? 0;

        this.logger.info("emx_idle: JMAP queryChanges result", { code: "emx.idle.jmap_changes", emxId: emx.id, iteration: i + 1, addedCount });

        if (addedCount > 0) {
          const sendResult = await this.signalQueue.send("emx_dispatch", { emxId: emx.id, accountId: emx.accountId });
          if (sendResult.isErr()) {
            this.logger.error("emx_idle: failed to enqueue emx_dispatch after detecting new mail", { code: "emx.idle.enqueue_failed", emxId: emx.id, error: sendResult.error });
            return { emxId: emx.id, outcome: "error: enqueue failed" };
          }
          return { emxId: emx.id, outcome: "new-mail-detected" };
        }
      }

      // Sleep between iterations (not after the last one)
      if (i < JMAP_POLL_ITERATIONS - 1) {
        await new Promise(r => setTimeout(r, JMAP_POLL_INTERVAL_MS));
      }
    }

    this.logger.info("emx_idle: JMAP polling complete, no new mail", { code: "emx.idle.jmap_timeout", emxId: emx.id });
    return { emxId: emx.id, outcome: "idle-timeout" };
  }
}
