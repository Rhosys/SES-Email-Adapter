import { ok, err } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import type { Arc, ArcStatus, Signal } from "../types/index.js";
import type { Notifier, NotificationReason } from "../notifier/types.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Message shape (what EventBridge Scheduler sends via SQS)
// ---------------------------------------------------------------------------

export interface FollowupMessage {
  accountId: string;
  signalId: string;
  arcId: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export class FollowupHandler {
  private readonly arcDb: { getArc(accountId: string, arcId: string): Promise<Result<Arc | null, DbError>> };
  private readonly arcUpdater: { updateArcStatus(accountId: string, arcId: string, status: ArcStatus, updatedAt: string): Promise<Result<void, DbError>> };
  private readonly signalDb: { getSignalById(accountId: string, signalId: string, arcId?: string): Promise<Result<Signal | null, DbError>> };
  private readonly notifier: Notifier;
  private readonly logger: Logger;

  constructor(deps: {
    arcDb: { getArc(accountId: string, arcId: string): Promise<Result<Arc | null, DbError>> };
    arcUpdater: { updateArcStatus(accountId: string, arcId: string, status: ArcStatus, updatedAt: string): Promise<Result<void, DbError>> };
    signalDb: { getSignalById(accountId: string, signalId: string, arcId?: string): Promise<Result<Signal | null, DbError>> };
    notifier: Notifier;
    logger: Logger;
  }) {
    this.arcDb = deps.arcDb;
    this.arcUpdater = deps.arcUpdater;
    this.signalDb = deps.signalDb;
    this.notifier = deps.notifier;
    this.logger = deps.logger;
  }

  async process(message: FollowupMessage): Promise<Result<void, DbError>> {
    const { accountId, signalId, arcId } = message;

    // 1. Fetch arc
    const arcResult = await this.arcDb.getArc(accountId, arcId);
    if (arcResult.isErr()) return err(arcResult.error);

    const arc = arcResult.value;

    // 2. Stale-fire: arc missing or deleted → discard
    if (!arc || arc.status === "deleted") {
      this.logger.track("Followup stale-fire: arc missing or deleted, discarding.", {
        code: "followup.stale_fire",
        accountId,
        arcId,
        reason: arc ? "deleted" : "missing",
      });
      return ok(undefined);
    }

    // 3. Fetch signal for notification payload
    const signalResult = await this.signalDb.getSignalById(accountId, signalId, arcId);
    if (signalResult.isErr()) return err(signalResult.error);

    const signal = signalResult.value;
    if (!signal) {
      this.logger.track("Followup stale-fire: signal not found, discarding.", {
        code: "followup.signal_missing",
        accountId,
        arcId,
        signalId,
      });
      return ok(undefined);
    }

    const reason: NotificationReason = "followup";

    // 4. Active → notify only (reminder on already-visible arc)
    if (arc.status === "active") {
      return this.notifier.notify(accountId, arc, signal, arc.urgency ?? "normal", reason);
    }

    // 5. Archived → reactivate + notify
    if (arc.status === "archived") {
      const now = new Date().toISOString();
      const updateResult = await this.arcUpdater.updateArcStatus(accountId, arcId, "active", now);
      if (updateResult.isErr()) return updateResult;

      const reactivatedArc: Arc = { ...arc, status: "active", updatedAt: now };
      return this.notifier.notify(accountId, reactivatedArc, signal, reactivatedArc.urgency ?? "normal", reason);
    }

    // 6. Any other status (e.g. violate_report) → discard without action
    this.logger.track("Followup: arc in unexpected status, discarding.", {
      code: "followup.unexpected_status",
      accountId,
      arcId,
      status: arc.status,
    });
    return ok(undefined);
  }
}
