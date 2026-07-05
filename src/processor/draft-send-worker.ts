import { DateTime } from "luxon";
import type { Signal } from "../types/index.js";
import type { DbError, TransientSesError, Result } from "../errors.js";
import { ok, err } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ReplySender } from "./processor.js";
import type { DraftSendPayload } from "./draft-send-dispatcher.js";
import { buildOutboundMsgId, buildSignalGsi3pk } from "./message-id.js";

export interface IDraftSendThreadDb {
  getSignalById(accountId: string, signalId: string, threadId: string): Promise<Result<Signal | null, DbError>>;
  updateSignalSendStatus(accountId: string, signalLookupId: string, update: {
    status: "sent" | "draft";
    sentAt?: string;
    sesMessageId?: string;
    sendFailureReason?: string;
    sendInitiatedAt?: string | null;
    gsi3pk?: string;
    threadId?: string;
  }): Promise<Result<Signal, DbError>>;
}

export class DraftSendWorker {
  private readonly threadDb: IDraftSendThreadDb;
  private readonly replySender: ReplySender;
  private readonly logger: Logger;

  constructor(threadDb: IDraftSendThreadDb, replySender: ReplySender, logger: Logger) {
    this.threadDb = threadDb;
    this.replySender = replySender;
    this.logger = logger;
  }

  async process(payload: DraftSendPayload): Promise<Result<void, DbError | TransientSesError>> {
    const { signalId, accountId, threadId, sendInitiatedAt } = payload;

    // Re-read signal — verify still pending_send
    const signalResult = await this.threadDb.getSignalById(accountId, signalId, threadId);
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

    if (!("sendInitiatedAt" in signal.data) || signal.data.sendInitiatedAt !== sendInitiatedAt) {
      this.logger.info("Draft send: sendInitiatedAt mismatch — stale message, discarding.", { code: "draft_send.stale_message", signalId, accountId });
      return ok(undefined);
    }

    // Send via SES — join all recipients
    const from = signal.data.from.address;
    const to = signal.data.to.map(r => r.address).join(", ");
    const subject = signal.data.subject;
    const body = "textBody" in signal.data ? (signal.data.textBody ?? "") : "";

    const sendResult = await this.replySender.sendReply({
      to,
      from,
      subject,
      body,
      inReplyTo: signal.threadId ?? "",
      accountId,
      signalId: signal.id,
      ...(signal.threadId ? { threadId: signal.threadId } : {}),
    });

    if (sendResult.isErr()) {
      // Transient — let SQS retry
      return err(sendResult.error);
    }

    const { messageId } = sendResult.value;

    // Compute outbound message ID for thread lookup
    const SES_REGION = process.env.SES_REGION ?? 'eu-central-1';
    const outboundMsgId = buildOutboundMsgId(messageId, SES_REGION);
    const gsi3pk = buildSignalGsi3pk(accountId, outboundMsgId);

    // Transition to sent
    const now = DateTime.utc().toISO()!;
    const updateResult = await this.threadDb.updateSignalSendStatus(accountId, signal.signalLookupId, {
      status: "sent",
      sentAt: now,
      sesMessageId: messageId,
      gsi3pk,
      ...(signal.threadId ? { threadId: signal.threadId } : {}),
    });
    if (updateResult.isErr()) return err(updateResult.error);

    return ok(undefined);
  }
}
