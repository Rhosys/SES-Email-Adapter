import type { SQSEvent } from "aws-lambda";
import { DateTime } from "luxon";
import type { AnySignal, SesFeedback, Signal, SuppressedAddress } from "../types/index.js";
import { SES_EVENT_TYPES, resolveSesEventType, isEmailSignal } from "../types/index.js";
import type { ProcessingDatabase } from "../database/processing-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import { TAG_ACCOUNT_ID, TAG_TYPE, TAG_SIGNAL_ID, TAG_THREAD_ID, TAG_HEALTHCHECK_ID, TAG_PURPOSE, isEmailSendType, systemResponsibleForBounces } from "../email/ses-tags.js";
import { BounceHandler } from "./bounce-handler.js";

export interface FeedbackSignalStore {
  getSignalById(accountId: string, signalId: string, threadId: string): Promise<Result<AnySignal | null, DbError>>;
  saveSignal(signal: AnySignal): Promise<Result<void, DbError>>;
  updateSignalSendStatus(accountId: string, signalLookupId: string, update: {
    status: "pending_send" | "sent" | "draft";
    sendInitiatedAt?: string | null;
    sentAt?: string;
    sesMessageId?: string;
    sendFailureReason?: string;
  }): Promise<Result<Signal, DbError>>;
}

export class SesFeedbackProcessor {
  private readonly processingDb: ProcessingDatabase;
  private readonly accountDb: AccountDatabase;
  private readonly signalStore: FeedbackSignalStore;
  private readonly logger: Logger;
  private readonly bounceHandler: BounceHandler;

  constructor(processingDb: ProcessingDatabase, accountDb: AccountDatabase, logger: Logger, signalStore: FeedbackSignalStore) {
    this.processingDb = processingDb;
    this.accountDb = accountDb;
    this.signalStore = signalStore;
    this.logger = logger;
    this.bounceHandler = new BounceHandler(signalStore, processingDb, accountDb, logger);
  }

  async process(event: SQSEvent): Promise<Result<void, DbError>> {
    try {
      await this.doProcess(event);
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async processNotification(notification: unknown): Promise<Result<void, DbError>> {
    try {
      const result = await this.processFeedback(notification as SesFeedback);
      return result;
    } catch (e) {
      return err(dbError(e));
    }
  }

  private async doProcess(event: SQSEvent): Promise<void> {
    for (const record of event.Records) {
      let feedback: SesFeedback;
      try {
        const sns = JSON.parse(record.body) as { Message: string };
        feedback = JSON.parse(sns.Message) as SesFeedback;
      } catch (err) {
        this.logger.error(`Failed to parse SES feedback notification from SQS record: ${err instanceof Error ? err.message : err}`, { code: "feedback.parse_failed", error: err, record });
        continue;
      }

      const result = await this.processFeedback(feedback);
      if (result.isErr()) {
        this.logger.track(`Failed to process SES bounce/complaint feedback. A database operation failed while suppressing the address or disabling forward rules. The suppression entry may be incomplete: ${result.error.message}`, { code: "feedback.process_failed", error: result.error });
      }
    }
  }

  /**
   * Identify which of our sending processes produced the email that bounced /
   * complained, and whether a failure there is our problem. A bounce/complaint on
   * a send WE are responsible for (e.g. the daily healthcheck) means our own pipeline
   * is broken, so it is logged at error level; bounces on mail carrying a user's content
   * to a third party are normal deliverability and stay at track level.
   *
   * Every send EmailService produces now carries TAG_TYPE (an EmailSendType), so `sendType`
   * is read straight off it. Only pre-migration in-flight messages lack the tag — those fall
   * back to the legacy TAG_PURPOSE/healthcheck signal, then to an unattributable "unknown".
   */
  private describeSendType(feedback: SesFeedback): { sendType: string; systemResponsible: boolean } {
    const tags = feedback.mail.tags ?? {};
    const tagType = tags[TAG_TYPE];
    if (tagType && isEmailSendType(tagType)) {
      return { sendType: tagType, systemResponsible: systemResponsibleForBounces(tagType) };
    }
    // Backward compat with pre-migration in-flight messages that predate TAG_TYPE.
    if (tags[TAG_HEALTHCHECK_ID] || tags[TAG_PURPOSE] === "healthcheck") {
      return { sendType: "healthcheck", systemResponsible: true };
    }
    const purpose = tags[TAG_PURPOSE];
    if (purpose) return { sendType: purpose, systemResponsible: false };
    return { sendType: "unknown", systemResponsible: false };
  }

  private async processFeedback(feedback: SesFeedback): Promise<Result<void, DbError>> {
    const type = resolveSesEventType(feedback);

    if (type === "Bounce" && feedback.bounce) {
      const isPermanent = feedback.bounce.bounceType === "Permanent";
      const sendType = this.describeSendType(feedback);
      const bouncedRecipients = feedback.bounce.bouncedRecipients.map(r => ({
        address: r.emailAddress,
        bounceType: isPermanent ? "permanent" as const : "transient" as const,
        ...(r.status ? { reason: r.status } : {}),
      }));

      const recipients = bouncedRecipients.map(r => r.address).join(", ") || "(none)";
      const kind = `${feedback.bounce.bounceType}/${feedback.bounce.bounceSubType}`;
      if (sendType.systemResponsible) {
        this.logger.error(`SES ${kind} bounce on a ${sendType.sendType} send — a system email we send (from ${feedback.mail.source}, messageId ${feedback.mail.messageId}) failed delivery to ${recipients}.`, { code: "feedback.system_bounce", feedback });
      } else {
        this.logger.track(`SES ${kind} bounce on a ${sendType.sendType} send — email from ${feedback.mail.source} (messageId ${feedback.mail.messageId}) bounced for ${recipients}.`, { code: "feedback.bounce", feedback });
      }

      // Resolve the originating send from the tags we stamped. A user-composed email surfaces a
      // deliverability signal; machine sends (healthcheck, forward, calendar-rsvp, …) only suppress.
      const signalId = feedback.mail.tags?.[TAG_SIGNAL_ID];
      const accountId = feedback.mail.tags?.[TAG_ACCOUNT_ID] ?? feedback.mail.tags?.["accountId"];
      const tagThreadId = feedback.mail.tags?.[TAG_THREAD_ID];
      let sentSignal: AnySignal | null = null;
      if (signalId && accountId && tagThreadId) {
        const sentSignalResult = await this.signalStore.getSignalById(accountId, signalId, tagThreadId);
        if (sentSignalResult.isErr()) return err(sentSignalResult.error);
        sentSignal = sentSignalResult.value;
      }
      const userSend = sentSignal && sentSignal.source === "user" && isEmailSignal(sentSignal) ? sentSignal : null;

      // Revert the draft only when every recipient it was sent to permanently bounced — a partial
      // bounce leaves the send intact. Computed here where the full recipient list is in hand.
      const revertToDraft = isPermanent && userSend !== null && userSend.data.to.length > 0 &&
        userSend.data.to.every(addr => bouncedRecipients.some(b => b.address.toLowerCase() === addr.address.toLowerCase() && b.bounceType === "permanent"));

      return this.bounceHandler.handleBounce({
        accountId: accountId ?? userSend?.accountId ?? "",
        bouncedRecipients,
        isPermanent,
        sesMessageId: feedback.mail.messageId,
        suppressionReason: isPermanent ? "hard_bounce" : "soft_bounce",
        ...(userSend ? { linkedSend: { linkedSignalId: userSend.id, signalLookupId: userSend.signalLookupId, ...(tagThreadId || userSend.threadId ? { threadId: tagThreadId || userSend.threadId! } : {}) } } : {}),
        revertToDraft,
        disableForwardingRules: accountId !== undefined && feedback.mail.tags?.[TAG_TYPE] === "forward",
        feedback,
      });
    } else if (type === "Complaint" && feedback.complaint) {
      const suppressedAt = DateTime.utc().toISO()!;

      const sendType = this.describeSendType(feedback);
      const recipients = feedback.complaint.complainedRecipients.map(r => r.emailAddress).join(", ") || "(none)";
      const messageId = feedback.mail.messageId;
      const from = feedback.mail.source;
      if (sendType.systemResponsible) {
        this.logger.error(`SES complaint on a ${sendType.sendType} send — a system email we send (from ${from}, messageId ${messageId}) was marked as spam by ${recipients}.`, { code: "feedback.system_complaint", feedback });
      } else {
        this.logger.track(`SES complaint on a ${sendType.sendType} send — email from ${from} (messageId ${messageId}) marked as spam by ${recipients}.`, { code: "feedback.complaint", feedback });
      }

      for (const r of feedback.complaint.complainedRecipients) {
        const entry: SuppressedAddress = {
          address: r.emailAddress,
          reason: "complaint",
          suppressedAt,
        };
        const suppressResult = await this.processingDb.suppressAddress(entry);
        if (suppressResult.isErr()) return err(suppressResult.error);
      }
    } else if (type && (SES_EVENT_TYPES as readonly string[]).includes(type)) {
      // A known SES event type (Delivery, Send, Reject, Open, Click, RenderingFailure,
      // DeliveryDelay, Subscription) that we don't act on today. Tracked rather than
      // silently dropped so it stays visible if it ever becomes unexpectedly frequent.
      this.logger.track("SES feedback event received but not actioned by this processor.", { code: "feedback.unactioned_event_type", feedback });
    } else {
      this.logger.error("SES feedback notification with an unrecognised eventType/notificationType — check the SNS subscription or event-destination configuration.", { code: "feedback.unknown_type", feedback });
    }

    return ok(undefined);
  }
}
