import type { SQSEvent } from "aws-lambda";
import type { SesFeedback, SuppressedAddress } from "../types/index.js";
import type { ProcessingDatabase } from "../database/processing-database.js";
import type { AccountDatabase } from "../database/account-database.js";

// 72 hours in seconds — soft bounces expire and can retry
const SOFT_BOUNCE_TTL_SECONDS = 72 * 60 * 60;

export class FeedbackProcessor {
  private readonly processingDb: ProcessingDatabase;
  private readonly accountDb: AccountDatabase;

  constructor(processingDb: ProcessingDatabase, accountDb: AccountDatabase) {
    this.processingDb = processingDb;
    this.accountDb = accountDb;
  }

  async process(event: SQSEvent): Promise<void> {
    for (const record of event.Records) {
      try {
        const sns = JSON.parse(record.body) as { Message: string };
        const feedback = JSON.parse(sns.Message) as SesFeedback;
        await this.processFeedback(feedback);
      } catch (err) {
        console.error("Failed to process feedback record:", err);
      }
    }
  }

  private async processFeedback(feedback: SesFeedback): Promise<void> {
    if (feedback.notificationType === "Bounce" && feedback.bounce) {
      const isPermanent = feedback.bounce.bounceType === "Permanent";
      const suppressedAt = new Date().toISOString();

      await Promise.all(
        feedback.bounce.bouncedRecipients.map(async (r) => {
          const entry: SuppressedAddress = {
            address: r.emailAddress,
            reason: isPermanent ? "hard_bounce" : "soft_bounce",
            suppressedAt,
            ...(!isPermanent ? { ttl: Math.floor(Date.now() / 1000) + SOFT_BOUNCE_TTL_SECONDS } : {}),
          };
          await this.processingDb.suppressAddress(entry);
        }),
      );

      // On permanent bounce, disable forward rules if this was a forwarded email (identified by SES EmailTags)
      if (isPermanent) {
        const accountId = feedback.mail.tags?.["accountId"];
        if (accountId && feedback.mail.tags?.["type"] === "forward") {
          await Promise.all(
            feedback.bounce!.bouncedRecipients.map((r) =>
              this.accountDb.disableForwardActions(accountId, r.emailAddress).catch((err) => {
                console.error("Failed to disable forward actions after bounce:", err);
              }),
            ),
          );
        }
      }
    } else if (feedback.notificationType === "Complaint" && feedback.complaint) {
      const suppressedAt = new Date().toISOString();

      await Promise.all(
        feedback.complaint.complainedRecipients.map((r) => {
          const entry: SuppressedAddress = {
            address: r.emailAddress,
            reason: "complaint",
            suppressedAt,
          };
          return this.processingDb.suppressAddress(entry);
        }),
      );
    }
  }
}
