import { ok, err } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { Thread, ThreadStatus } from "../types/index.js";
import type { Notifier, NotificationReason } from "../notifier/types.js";
import type { Logger } from "../logger.js";
import type { UpdateThreadFields } from "../database/thread-database.js";

// ---------------------------------------------------------------------------
// Message shape (what EventBridge Scheduler sends via SQS)
// ---------------------------------------------------------------------------

export interface FollowupMessage {
  accountId: string;
  threadId: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface IFollowupThreadDb {
  getThread(accountId: string, threadId: string): Promise<Result<Thread | null, DbError>>;
  updateThread(accountId: string, id: string, status: ThreadStatus, lastSignalAt: string, update: UpdateThreadFields): Promise<Result<Thread, DbError>>;
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
    const { accountId, threadId } = message;
    this.logger.info("Followup: processing", { code: "followup.start", accountId, threadId });

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

    // 2b. followupAt cleared (new signal already reactivated) → discard
    if (!thread.followupAt) {
      this.logger.info("Followup: followupAt cleared, new signal already reactivated — discarding.", { code: "followup.already_reactivated", accountId, threadId });
      return ok(undefined);
    }

    const reason: NotificationReason = "followup";

    // 3. Active → notify only (reminder on already-visible thread)
    if (thread.status === "active") {
      return this.notifier.notify(accountId, thread, undefined, thread.urgency ?? "normal", reason);
    }

    // 4. Archived → reactivate + notify
    if (thread.status === "archived") {
      const now = new Date().toISOString();
      const updateResult = await this.threadDb.updateThread(accountId, threadId, "active", now, {});
      if (updateResult.isErr()) return err(updateResult.error);

      const reactivatedThread: Thread = { ...thread, status: "active", updatedAt: now };
      return this.notifier.notify(accountId, reactivatedThread, undefined, reactivatedThread.urgency ?? "normal", reason);
    }

    // 5. Any other status (e.g. report_violation) → discard without action
    this.logger.track("Followup: thread in unexpected status, discarding.", {
      code: "followup.unexpected_status",
      thread,
    });
    return ok(undefined);
  }
}
