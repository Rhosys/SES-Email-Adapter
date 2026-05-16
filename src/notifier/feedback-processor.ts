import type { SQSEvent } from "aws-lambda";
import type { SesFeedback, SuppressedAddress } from "../types/index.js";
import type { ProcessingDatabase } from "../database/processing-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";

// 72 hours in seconds — soft bounces expire and can retry
const SOFT_BOUNCE_TTL_SECONDS = 72 * 60 * 60;

export class FeedbackProcessor {
  private readonly processingDb: ProcessingDatabase;
  private readonly accountDb: AccountDatabase;
  private readonly logger: Logger;

  constructor(processingDb: ProcessingDatabase, accountDb: AccountDatabase, logger: Logger) {
    this.processingDb = processingDb;
    this.accountDb = accountDb;
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
      const suppressedAt = new Date().toISOString();

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
        const accountId = feedback.mail.tags?.["accountId"];
        if (accountId && feedback.mail.tags?.["type"] === "forward") {
          for (const r of feedback.bounce!.bouncedRecipients) {
            const disableResult = await this.accountDb.disableForwardActions(accountId, r.emailAddress);
            if (disableResult.isErr()) {
              this.logger.track("Failed to disable forward actions after permanent bounce. The DynamoDB update for the forward rule returned an error. Emails may continue to be forwarded to the bouncing address.", { code: "feedback.disable_forward_failed", accountId, address: r.emailAddress, error: disableResult.error });
            }
          }
        }
      }
    } else if (feedback.notificationType === "Complaint" && feedback.complaint) {
      const suppressedAt = new Date().toISOString();

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
