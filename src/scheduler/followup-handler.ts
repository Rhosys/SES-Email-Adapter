import { ok, err } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { Thread, ThreadStatus, Signal } from "../types/index.js";
import type { Notifier, NotificationReason } from "../notifier/types.js";
import type { Logger } from "../logger.js";
import type { UpdateThreadFields } from "../database/thread-database.js";

// ---------------------------------------------------------------------------
// Message shape (what EventBridge Scheduler sends via SQS)
// ---------------------------------------------------------------------------

export interface FollowupMessage {
  accountId: string;
  signalId: string;
  threadId: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface IFollowupThreadDb {
  getThread(accountId: string, threadId: string): Promise<Result<Thread | null, DbError>>;
  updateThread(accountId: string, id: string, status: ThreadStatus, lastSignalAt: string, update: UpdateThreadFields): Promise<Result<Thread, DbError>>;
  getSignalById(accountId: string, signalId: string, threadId?: string): Promise<Result<Signal | null, DbError>>;
}

export class FollowupHandler {
  private readonly threadDb: IFollowupThreadDb;
  private readonly notifier: Notifier;
  private readonly logger: Logger;

  constructor(deps: {
    threadDb: IFollowupThreadDb;
    notifier: Notifier;
    logger: Logger;
  }) {
    this.threadDb = deps.threadDb;
    this.notifier = deps.notifier;
    this.logger = deps.logger;
  }

  async process(message: FollowupMessage): Promise<Result<void, DbError>> {
    const { accountId, signalId, threadId } = message;

    // 1. Fetch thread
    const threadResult = await this.threadDb.getThread(accountId, threadId);
    if (threadResult.isErr()) return err(threadResult.error);

    const thread = threadResult.value;

    // 2. Stale-fire: thread missing or deleted → discard
    if (!thread || thread.status === "deleted") {
      this.logger.track("Followup stale-fire: thread missing or deleted, discarding.", {
        code: "followup.stale_fire",
        accountId,
        threadId,
        reason: thread ? "deleted" : "missing",
      });
      return ok(undefined);
    }

    // 3. Fetch signal for notification payload
    const signalResult = await this.threadDb.getSignalById(accountId, signalId, threadId);
    if (signalResult.isErr()) return err(signalResult.error);

    const signal = signalResult.value;
    if (!signal) {
      this.logger.track("Followup stale-fire: signal not found, discarding.", {
        code: "followup.signal_missing",
        accountId,
        threadId,
        signalId,
      });
      return ok(undefined);
    }

    const reason: NotificationReason = "followup";

    // 4. Active → notify only (reminder on already-visible thread)
    if (thread.status === "active") {
      return this.notifier.notify(accountId, thread, signal, thread.urgency ?? "normal", reason);
    }

    // 5. Archived → reactivate + notify
    if (thread.status === "archived") {
      const now = new Date().toISOString();
      const updateResult = await this.threadDb.updateThread(accountId, threadId, "active", now, {});
      if (updateResult.isErr()) return err(updateResult.error);

      const reactivatedThread: Thread = { ...thread, status: "active", updatedAt: now };
      return this.notifier.notify(accountId, reactivatedThread, signal, reactivatedThread.urgency ?? "normal", reason);
    }

    // 6. Any other status (e.g. report_violation) → discard without action
    this.logger.track("Followup: thread in unexpected status, discarding.", {
      code: "followup.unexpected_status",
      signal, thread,
    });
    return ok(undefined);
  }
}
