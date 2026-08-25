import { DateTime } from "luxon";
import type { Signal } from "../types/index.js";
import type { DbError, Result } from "../errors.js";
import { ok, err } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ReplySender, ReplySendError } from "./processor.js";
import type { DraftSendPayload } from "./draft-send-dispatcher.js";
import { buildSignalGsi3pk } from "./message-id.js";

/**
 * Send failures that no amount of retrying will clear: SES refused the message outright, the
 * provider refused it, or the connection lacks the scope needed to send at all. Everything
 * else (transient SES faults, 5xx from a provider, an expired token that will be refreshed on
 * the next attempt) goes back to SQS.
 */
const PERMANENT_SEND_ERRORS = new Set<ReplySendError["kind"]>([
  "permanent_ses_error",
  "provider_send_rejected",
  "provider_send_scope_missing",
  "invalid_argument",
]);

/** A short, user-facing reason to show against the parked draft. */
function describeSendFailure(error: ReplySendError): string {
  switch (error.kind) {
    case "provider_send_scope_missing":
      return "Your connected mailbox has not granted permission to send email. Reconnect the mailbox to allow sending.";
    case "provider_send_rejected":
      return `The mail provider rejected this message: ${String(error.cause).slice(0, 256)}`;
    case "permanent_ses_error":
      return `Rejected by the mail service: ${error.errorName}`;
    default:
      return "The message could not be sent.";
  }
}

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

  async process(payload: DraftSendPayload): Promise<Result<void, DbError | ReplySendError>> {
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
    const inReplyTo = await this.resolveInReplyTo(accountId, threadId, signal);

    const sendResult = await this.replySender.sendReply({
      to,
      from,
      subject,
      body,
      ...(inReplyTo ? { inReplyTo } : {}),
      accountId,
      signalId: signal.id,
      threadId,
    });

    if (sendResult.isErr()) {
      if (PERMANENT_SEND_ERRORS.has(sendResult.error.kind)) {
        // The message itself is the problem — a retry sends the same bytes to the same
        // rejection. Park the draft with the reason so the user can fix and resend.
        this.logger.warn("Draft send permanently rejected — will not retry.", { code: "draft_send.send_permanent", signalId, accountId, error: sendResult.error });
        const failureResult = await this.threadDb.updateSignalSendStatus(accountId, signal.signalLookupId, {
          status: "draft",
          sendInitiatedAt: null,
          sendFailureReason: describeSendFailure(sendResult.error),
          threadId,
        });
        if (failureResult.isErr()) return err(failureResult.error);
        return ok(undefined);
      }
      // Transient — let SQS retry
      return err(sendResult.error);
    }

    const { messageId, outboundMsgId } = sendResult.value;

    // Key the reply-threading lookup on the Message-ID the send route reported. Provider
    // sends report the one the provider assigned; SES sends derive it from the SES id.
    const gsi3pk = outboundMsgId ? buildSignalGsi3pk(accountId, outboundMsgId) : undefined;

    // Transition to sent
    const now = DateTime.utc().toISO()!;
    const updateResult = await this.threadDb.updateSignalSendStatus(accountId, signal.signalLookupId, {
      status: "sent",
      sentAt: now,
      sesMessageId: messageId,
      ...(gsi3pk ? { gsi3pk } : {}),
      threadId,
    });
    if (updateResult.isErr()) return err(updateResult.error);

    this.logger.info("Draft send: signal sent successfully", { code: "draft_send.sent", signalId, accountId, sesMessageId: messageId });
    return ok(undefined);
  }

  /**
   * Resolves the In-Reply-To/References value from the specific message this draft was
   * composed as a reply to (Signal.data.linkedSignalId, set explicitly by the UI at draft
   * creation — see CreateDraftSignalRequest). Returns undefined — never a wrong value — when
   * there's nothing to link, the linked signal can't be found, or it has no Message-ID header.
   *
   * linkedSignalId is intentionally unvalidated at creation time (a lookup then would only
   * prove the signal existed then, not now) — so "not found" here is an ordinary, expected
   * outcome (the linked signal aged out or was deleted between compose and send), not a fault;
   * tracked rather than logged as an error. A DB error fetching it, or a found-but-headerless
   * signal, are more likely to indicate a real problem and stay louder.
   */
  private async resolveInReplyTo(accountId: string, threadId: string, signal: Signal): Promise<string | undefined> {
    if (!("linkedSignalId" in signal.data) || !signal.data.linkedSignalId) return undefined;
    const linkedSignalId = signal.data.linkedSignalId;

    const linkedResult = await this.threadDb.getSignalById(accountId, linkedSignalId, threadId);
    if (linkedResult.isErr()) {
      this.logger.error(`Draft send: failed to fetch linked signal for In-Reply-To — header will be omitted: ${linkedResult.error.message}`, { code: "draft_send.linked_signal_fetch_failed", signalId: signal.id, accountId, linkedSignalId, error: linkedResult.error });
      return undefined;
    }
    const linked = linkedResult.value;
    if (!linked) {
      this.logger.track("Draft send: linked signal no longer exists — In-Reply-To will be omitted.", { code: "draft_send.linked_signal_not_found", signalId: signal.id, accountId, linkedSignalId });
      return undefined;
    }
    const messageId = linked.data.headers["message-id"];
    if (!messageId) {
      this.logger.warn("Draft send: linked signal has no Message-ID header — In-Reply-To will be omitted.", { code: "draft_send.linked_signal_no_message_id", signalId: signal.id, accountId, linkedSignalId });
      return undefined;
    }
    return messageId;
  }
}
