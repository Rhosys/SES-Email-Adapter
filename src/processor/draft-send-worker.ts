import type { Signal, Arc } from "../types/index.js";
import type { DbError, Result } from "../errors.js";
import { ok, err, dbError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ReplySender } from "./processor.js";
import type { DraftSendPayload } from "./draft-send-dispatcher.js";

export interface DraftSendStore {
  getSignalById(accountId: string, signalId: string): Promise<Result<Signal | null, DbError>>;
  updateSignalSendStatus(accountId: string, signalLookupId: string, update: {
    status: "sent" | "draft";
    sentAt?: string;
    sesMessageId?: string;
    sendFailureReason?: string;
    sendInitiatedAt?: string | null;
  }): Promise<Result<Signal, DbError>>;
  getArc(accountId: string, id: string): Promise<Result<Arc | null, DbError>>;
  updateArcStatus(accountId: string, id: string, status: "archived"): Promise<Result<void, DbError>>;
  getAccountAfterSendAction(accountId: string): Promise<Result<"archive" | "keep_active", DbError>>;
}

export class DraftSendWorker {
  private readonly store: DraftSendStore;
  private readonly replySender: ReplySender;
  private readonly logger: Logger;

  constructor(store: DraftSendStore, replySender: ReplySender, logger: Logger) {
    this.store = store;
    this.replySender = replySender;
    this.logger = logger;
  }

  async process(payload: DraftSendPayload): Promise<Result<void, DbError>> {
    const { signalId, accountId, sendInitiatedAt } = payload;

    // Re-read signal — verify still pending_send
    const signalResult = await this.store.getSignalById(accountId, signalId);
    if (signalResult.isErr()) return err(signalResult.error);
    const signal = signalResult.value;

    if (!signal) {
      this.logger.info("Draft send: signal not found — discarding.", { code: "draft_send.signal_not_found", signalId, accountId });
      return ok(undefined);
    }

    if (signal.status !== "pending_send") {
      this.logger.info("Draft send: signal no longer pending_send — discarding.", { code: "draft_send.status_changed", signalId, accountId, currentStatus: signal.status });
      return ok(undefined);
    }

    if (signal.sendInitiatedAt !== sendInitiatedAt) {
      this.logger.info("Draft send: sendInitiatedAt mismatch — stale message, discarding.", { code: "draft_send.stale_message", signalId, accountId });
      return ok(undefined);
    }

    // Send via SES — join all recipients
    const from = signal.from.address;
    const to = signal.to.map(r => r.address).join(", ");
    const subject = signal.subject;
    const body = signal.textBody ?? "";

    try {
      const { messageId } = await this.replySender.sendReply({
        to,
        from,
        subject,
        body,
        inReplyTo: signal.arcId ?? "",
        accountId,
        signalId: signal.id,
        ...(signal.arcId ? { arcId: signal.arcId } : {}),
      });

      // Transition to sent
      const now = new Date().toISOString();
      const updateResult = await this.store.updateSignalSendStatus(accountId, signal.signalLookupId, {
        status: "sent",
        sentAt: now,
        sesMessageId: messageId,
      });
      if (updateResult.isErr()) return err(updateResult.error);

      // Post-send arc archival
      if (signal.arcId) {
        const actionResult = await this.store.getAccountAfterSendAction(accountId);
        if (actionResult.isOk() && actionResult.value === "archive") {
          await this.store.updateArcStatus(accountId, signal.arcId, "archived");
        }
      }

      return ok(undefined);
    } catch (e) {
      // Distinguish permanent vs transient SES errors
      const error = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      const httpStatus = error.$metadata?.httpStatusCode ?? 0;
      const isPermanent = error.name === "MessageRejected"
        || error.name === "AccountSendingPausedException"
        || (httpStatus >= 400 && httpStatus < 500);

      if (isPermanent) {
        this.logger.error("Draft send: SES permanent failure — reverting to draft.", { code: "draft_send.ses_permanent_failure", signalId, accountId, error: e });
        await this.store.updateSignalSendStatus(accountId, signal.signalLookupId, {
          status: "draft",
          sendInitiatedAt: null,
          sendFailureReason: "ses_permanent_failure",
        });
        return ok(undefined);
      }

      // Transient — let SQS retry
      return err(dbError(e));
    }
  }
}
