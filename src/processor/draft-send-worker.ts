import { DateTime } from "luxon";
import type { Signal, Arc } from "../types/index.js";
import type { DbError, TransientSesError, Result } from "../errors.js";
import { ok, err } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ReplySender } from "./processor.js";
import type { DraftSendPayload } from "./draft-send-dispatcher.js";
import { buildOutboundMsgId, buildGsi2pk } from "./message-id.js";

export interface DraftSendStore {
  getSignalById(accountId: string, signalId: string): Promise<Result<Signal | null, DbError>>;
  updateSignalSendStatus(accountId: string, signalLookupId: string, update: {
    status: "sent" | "draft";
    sentAt?: string;
    sesMessageId?: string;
    sendFailureReason?: string;
    sendInitiatedAt?: string | null;
    gsi2pk?: string;
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

  async process(payload: DraftSendPayload): Promise<Result<void, DbError | TransientSesError>> {
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

    if (signal.data.sendInitiatedAt !== sendInitiatedAt) {
      this.logger.info("Draft send: sendInitiatedAt mismatch — stale message, discarding.", { code: "draft_send.stale_message", signalId, accountId });
      return ok(undefined);
    }

    // Send via SES — join all recipients
    const from = signal.data.from.address;
    const to = signal.data.to.map(r => r.address).join(", ");
    const subject = signal.data.subject;
    const body = signal.data.textBody ?? "";

    const sendResult = await this.replySender.sendReply({
      to,
      from,
      subject,
      body,
      inReplyTo: signal.arcId ?? "",
      accountId,
      signalId: signal.id,
      ...(signal.arcId ? { arcId: signal.arcId } : {}),
    });

    if (sendResult.isErr()) {
      // Transient — let SQS retry
      return err(sendResult.error);
    }

    const { messageId } = sendResult.value;

    // Compute outbound message ID for arc threading lookup
    const SES_REGION = process.env.SES_REGION ?? 'eu-central-1';
    const outboundMsgId = buildOutboundMsgId(messageId, SES_REGION);
    const gsi2pk = buildGsi2pk(accountId, outboundMsgId);

    // Transition to sent
    const now = DateTime.utc().toISO()!;
    const updateResult = await this.store.updateSignalSendStatus(accountId, signal.signalLookupId, {
      status: "sent",
      sentAt: now,
      sesMessageId: messageId,
      gsi2pk,
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
  }
}
