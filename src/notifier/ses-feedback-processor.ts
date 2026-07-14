import type { SQSEvent } from "aws-lambda";
import { DateTime } from "luxon";
import type { DeliverabilitySignalData, SesFeedback, Signal, SuppressedAddress } from "../types/index.js";
import { SES_EVENT_TYPES, resolveSesEventType } from "../types/index.js";
import { generateId } from "../utils/id.js";
import type { ProcessingDatabase } from "../database/processing-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import { TAG_ACCOUNT_ID, TAG_TYPE, TAG_SIGNAL_ID, TAG_THREAD_ID, TAG_HEALTHCHECK_ID } from "../email/ses-tags.js";

// 7 days in seconds — soft bounces expire and can retry
const SOFT_BOUNCE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface FeedbackSignalStore {
  getSignalById(accountId: string, signalId: string, threadId: string): Promise<Result<Signal | null, DbError>>;
  getSignalByMessageId(accountId: string, sesMessageId: string): Promise<Result<Signal | null, DbError>>;
  saveSignal(signal: Signal): Promise<Result<void, DbError>>;
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

  constructor(processingDb: ProcessingDatabase, accountDb: AccountDatabase, logger: Logger, signalStore: FeedbackSignalStore) {
    this.processingDb = processingDb;
    this.accountDb = accountDb;
    this.signalStore = signalStore;
    this.logger = logger;
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
        this.logger.error("Failed to parse SES feedback notification from SQS record. The JSON payload could not be deserialized as a valid SesFeedback structure. This feedback event will be skipped and the bounce/complaint won't be recorded. Check the SNS subscription format.", { code: "feedback.parse_failed", error: err, record });
        continue;
      }

      const result = await this.processFeedback(feedback);
      if (result.isErr()) {
        this.logger.track("Failed to process SES bounce/complaint feedback. A database operation failed while suppressing the address or disabling forward rules. The suppression entry may be incomplete.", { code: "feedback.process_failed", error: result.error });
      }
    }
  }

  /**
   * Identify which of our sending processes produced the email that bounced /
   * complained, and whether a failure there is our problem. A bounce/complaint on
   * a *system* email we generate (e.g. the daily healthcheck) means our own
   * pipeline is broken, so it is logged at error level; recipient bounces on
   * user/forward mail are normal deliverability and stay at track level.
   */
  private describeOrigin(feedback: SesFeedback): { process: string; isSystemError: boolean; healthcheckId?: string } {
    const tags = feedback.mail.tags ?? {};
    const healthcheckId = tags[TAG_HEALTHCHECK_ID];
    if (healthcheckId || tags["purpose"] === "healthcheck") {
      return { process: "healthcheck", isSystemError: true, ...(healthcheckId ? { healthcheckId } : {}) };
    }
    const type = tags[TAG_TYPE];
    if (type) return { process: type, isSystemError: false };
    const purpose = tags["purpose"];
    if (purpose) return { process: purpose, isSystemError: false };
    return { process: "unknown", isSystemError: false };
  }

  private async processFeedback(feedback: SesFeedback): Promise<Result<void, DbError>> {
    const type = resolveSesEventType(feedback);

    if (type === "Bounce" && feedback.bounce) {
      const isPermanent = feedback.bounce.bounceType === "Permanent";
      const suppressedAt = DateTime.utc().toISO()!;

      const origin = this.describeOrigin(feedback);
      if (origin.isSystemError) {
        this.logger.error(`SES bounce on the ${origin.process} process — a system email we send is failing delivery.`, { code: "feedback.system_bounce", feedback });
      } else {
        this.logger.track(`SES bounce on the ${origin.process} process.`, { code: "feedback.bounce", feedback });
      }

      for (const r of feedback.bounce.bouncedRecipients) {
        const address = r.emailAddress;
        const tagSignalId = feedback.mail.tags?.[TAG_SIGNAL_ID];
        const entry: SuppressedAddress = {
          address,
          reason: isPermanent ? "hard_bounce" : "soft_bounce",
          suppressedAt,
          ...(!isPermanent ? { ttl: Math.floor(Date.now() / 1000) + SOFT_BOUNCE_TTL_SECONDS } : {}),
          feedback,
          sesMessageId: feedback.mail.messageId,
          ...(tagSignalId ? { linkedSignalId: tagSignalId } : {}),
        };
        const suppressResult = await this.processingDb.suppressAddress(entry);
        if (suppressResult.isErr()) return err(suppressResult.error);

        if (!isPermanent && suppressResult.value.bounceCount > 2) {
          this.logger.error("Address has bounced transiently more than 2 times in 7 days — investigate.", { code: "feedback.repeated_transient_bounce", address, bounceCount: suppressResult.value.bounceCount, feedback });
        }
      }

      // On permanent bounce, disable forward rules if this was a forwarded email
      if (isPermanent) {
        const accountId = feedback.mail.tags?.[TAG_ACCOUNT_ID];
        if (accountId && feedback.mail.tags?.[TAG_TYPE] === "forward") {
          for (const r of feedback.bounce!.bouncedRecipients) {
            const disableResult = await this.accountDb.disableRulesForwardingTo(accountId, r.emailAddress);
            if (disableResult.isErr()) {
              this.logger.track("Failed to disable rules forwarding to bounced address. The DynamoDB update returned an error. Emails may continue to be forwarded to the bouncing address.", { code: "feedback.disable_forward_failed", accountId, address: r.emailAddress, error: disableResult.error });
            } else {
              for (const ruleId of disableResult.value) {
                this.logger.track("Rule disabled due to permanent forward bounce", { code: "feedback.rule_disabled_on_bounce", accountId, ruleId, bouncedAddress: r.emailAddress });
              }
            }
          }
        }
      }

      // Check if this bounce is for a user-sent signal
      {
        const sesMessageId = feedback.mail.messageId;
        const signalId = feedback.mail.tags?.[TAG_SIGNAL_ID];
        // Prefixed tag takes priority; fall back to bare "accountId" for pre-migration emails
        const accountId = feedback.mail.tags?.[TAG_ACCOUNT_ID] ?? feedback.mail.tags?.["accountId"];

        // Requirement 5.6: if neither TAG_SIGNAL_ID nor TAG_ACCOUNT_ID is present, skip signal lookup
        // Requirement 5.3: if TAG_ACCOUNT_ID is absent, skip account-specific correlation
        const tagThreadId = feedback.mail.tags?.[TAG_THREAD_ID];
        let sentSignalResult: Result<Signal | null, DbError> | undefined;
        if (signalId && accountId && tagThreadId) {
          // Direct signal lookup via tag (skips SES message ID query)
          sentSignalResult = await this.signalStore.getSignalById(accountId, signalId, tagThreadId);
        } else if (accountId) {
          // Fallback: look up by SES message ID (covers pre-migration emails without SignalId tag or threadId tag)
          sentSignalResult = await this.signalStore.getSignalByMessageId(accountId, sesMessageId);
        }

        if (sentSignalResult?.isOk()) {
          const sentSignal = sentSignalResult.value;
          if (sentSignal && sentSignal.source === "user") {
            const bouncedRecipients = feedback.bounce!.bouncedRecipients.map(r => ({
              address: r.emailAddress,
              bounceType: isPermanent ? "permanent" as const : "transient" as const,
              ...(r.status ? { reason: r.status } : {}),
            }));

            // Create deliverability signal in the same thread
            // Direct thread assignment: TAG_THREAD_ID takes precedence (no thread-matching needed)
            const tagThreadId = feedback.mail.tags?.[TAG_THREAD_ID];
            const resolvedThreadId = tagThreadId || sentSignal.threadId;

            const id = generateId("sgn-");
            const deliverabilitySignal: Signal<DeliverabilitySignalData> = {
              id,
              signalLookupId: id,
              ...(resolvedThreadId ? { threadId: resolvedThreadId } : {}),
              accountId: sentSignal.accountId,
              source: "ses_feedback",
              type: "deliverability",
              status: "active",
              labels: [],
              createdAt: DateTime.utc().toISO()!,
              data: {
                linkedSignalId: sentSignal.id,
                bouncedRecipients,
                subject: `Delivery failure: ${bouncedRecipients.length} recipient(s) bounced`,
              },
            };
            await this.signalStore.saveSignal(deliverabilitySignal as unknown as Signal);

            // If ALL recipients permanently bounced → revert sent signal to draft
            if (isPermanent) {
              const allTo = sentSignal.data.to.map(t => t.address.toLowerCase());
              const allBounced = allTo.every(addr =>
                bouncedRecipients.some(b => b.address.toLowerCase() === addr && b.bounceType === "permanent")
              );
              if (allBounced) {
                await this.signalStore.updateSignalSendStatus(sentSignal.accountId, sentSignal.signalLookupId, {
                  status: "draft",
                  sendFailureReason: "all_recipients_bounced",
                  sendInitiatedAt: null,
                });
              }
            }
          }
        }
      }
    } else if (type === "Complaint" && feedback.complaint) {
      const suppressedAt = DateTime.utc().toISO()!;

      const origin = this.describeOrigin(feedback);
      if (origin.isSystemError) {
        this.logger.error(`SES complaint on the ${origin.process} process — a system email we send was marked as spam.`, { code: "feedback.system_complaint", feedback });
      } else {
        this.logger.track(`SES complaint on the ${origin.process} process.`, { code: "feedback.complaint", feedback });
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
