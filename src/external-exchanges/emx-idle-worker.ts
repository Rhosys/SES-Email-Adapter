import { DateTime } from "luxon";
import { ok } from "../errors.js";
import type { Result } from "../errors.js";
import type { ExchangesDatabase } from "../database/exchanges-database.js";
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
  db: ExchangesDatabase;
  imapAdapter: ImapAdapter;
  jmapAdapter: JmapAdapter;
}

export class EmxIdleWorker {
  private readonly logger: Logger;
  private readonly db: ExchangesDatabase;
  private readonly imapAdapter: ImapAdapter;
  private readonly jmapAdapter: JmapAdapter;

  constructor(deps: EmxIdleWorkerDeps) {
    this.logger = deps.logger;
    this.db = deps.db;
    this.imapAdapter = deps.imapAdapter;
    this.jmapAdapter = deps.jmapAdapter;
  }

  async process(payload: EmxIdlePayload): Promise<Result<void, never>> {
    const { accountId } = payload;

    // Load all exchanges for this account
    const listResult = await this.db.listExternalExchanges(accountId);
    if (listResult.isErr()) {
      this.logger.error(`emx_idle: failed to list exchanges: ${listResult.error.message}`, { code: "emx.idle.list_failed", accountId, error: listResult.error });
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
    const tasks: Array<{ emxId: string; platform: string; promise: Promise<Result<void, never>> }> = [];

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
        tasks.push({ emxId: emx.id, platform: emx.platform, promise: this.imapAdapter.idleAndDispatch(emx, IDLE_TIMEOUT_MS) });
      } else {
        tasks.push({ emxId: emx.id, platform: emx.platform, promise: this.jmapAdapter.pollAndDispatch(emx, JMAP_POLL_ITERATIONS, JMAP_POLL_INTERVAL_MS) });
      }
    }

    if (tasks.length === 0) {
      this.logger.info("emx_idle: all exchanges skipped", { code: "emx.idle.all_skipped", accountId });
      return ok(undefined);
    }

    // Run all concurrently (R1.2). Each task's own Result errors are already logged by the
    // adapter — this only guards against a task throwing in violation of its Result contract,
    // which allSettled would otherwise swallow with no trace at all.
    const settled = await Promise.allSettled(tasks.map(t => t.promise));
    settled.forEach((outcome, i) => {
      if (outcome.status === "rejected") {
        const task = tasks[i]!;
        this.logger.error(`emx_idle: task rejected unexpectedly: ${outcome.reason instanceof Error ? outcome.reason.message : outcome.reason}`, { code: "emx.idle.task_rejected", accountId, emxId: task.emxId, platform: task.platform, error: outcome.reason });
      }
    });

    this.logger.info("emx_idle: completed", { code: "emx.idle.done", accountId, exchangeCount: tasks.length });
    return ok(undefined);
  }
}
