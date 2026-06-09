import type { SQSEvent } from "aws-lambda";
import { DateTime } from "luxon";
import type { DeliverabilitySignalData, SesFeedback, Signal, SuppressedAddress } from "../types/index.js";
import { generateId } from "../utils/id.js";
import type { ProcessingDatabase } from "../database/processing-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import { TAG_ACCOUNT_ID, TAG_TYPE, TAG_SIGNAL_ID, TAG_ARC_ID } from "../email/ses-tags.js";

// 72 hours in seconds — soft bounces expire and can retry
const SOFT_BOUNCE_TTL_SECONDS = 72 * 60 * 60;

export interface FeedbackSignalStore {
  getSignalById(accountId: string, signalId: string): Promise<Result<Signal | null, DbError>>;
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

export class FeedbackProcessor {
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

  private async processFeedback(feedback: SesFeedback): Promise<Result<void, DbError>> {
    if (feedback.notificationType === "Bounce" && feedback.bounce) {
      const isPermanent = feedback.bounce.bounceType === "Permanent";
      const suppressedAt = DateTime.utc().toISO()!;

      for (const r of feedback.bounce.bouncedRecipients) {
        const entry: SuppressedAddress = {
          address: r.emailAddress,
          reason: isPermanent ? "hard_bounce" : "soft_bounce",
          suppressedAt,
          ...(!isPermanent ? { ttl: Math.floor(Date.now() / 1000) + SOFT_BOUNCE_TTL_SECONDS } : {}),
        };
        const suppressResult = await this.processingDb.suppressAddress(entry);
        if (suppressResult.isErr()) return suppressResult;
      }

      // On permanent bounce, disable forward rules if this was a forwarded email
      if (isPermanent) {
        const accountId = feedback.mail.tags?.[TAG_ACCOUNT_ID];
        if (accountId && feedback.mail.tags?.[TAG_TYPE] === "forward") {
          for (const r of feedback.bounce!.bouncedRecipients) {
            const disableResult = await this.accountDb.disableForwardActions(accountId, r.emailAddress);
            if (disableResult.isErr()) {
              this.logger.track("Failed to disable forward actions after permanent bounce. The DynamoDB update for the forward rule returned an error. Emails may continue to be forwarded to the bouncing address.", { code: "feedback.disable_forward_failed", accountId, address: r.emailAddress, error: disableResult.error });
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
        let sentSignalResult: Result<Signal | null, DbError> | undefined;
        if (signalId && accountId) {
          // Direct signal lookup via tag (skips SES message ID query)
          sentSignalResult = await this.signalStore.getSignalById(accountId, signalId);
        } else if (accountId) {
          // Fallback: look up by SES message ID (covers pre-migration emails without SignalId tag)
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

            // Create deliverability signal in the same arc
            // Direct arc assignment: TAG_ARC_ID takes precedence (no arc-matching needed)
            const tagArcId = feedback.mail.tags?.[TAG_ARC_ID];
            const resolvedArcId = tagArcId || sentSignal.arcId;

            const id = generateId("sgn-");
            const deliverabilitySignal: Signal<DeliverabilitySignalData> = {
              id,
              signalLookupId: id,
              ...(resolvedArcId ? { arcId: resolvedArcId } : {}),
              accountId: sentSignal.accountId,
              source: "ses_feedback",
              type: "deliverability",
              status: "active",
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
    } else if (feedback.notificationType === "Complaint" && feedback.complaint) {
      const suppressedAt = DateTime.utc().toISO()!;

      for (const r of feedback.complaint.complainedRecipients) {
        const entry: SuppressedAddress = {
          address: r.emailAddress,
          reason: "complaint",
          suppressedAt,
        };
        const suppressResult = await this.processingDb.suppressAddress(entry);
        if (suppressResult.isErr()) return suppressResult;
      }
    }

    return ok(undefined);
  }
}
