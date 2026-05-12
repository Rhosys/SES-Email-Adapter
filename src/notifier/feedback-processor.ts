import type { SQSEvent } from "aws-lambda";
import { ResultAsync } from "neverthrow";
import type { SesFeedback, SuppressedAddress } from "../types/index.js";
import type { ProcessingDatabase } from "../database/processing-database.js";
import type { AccountDatabase } from "../database/account-database.js";
import { dbError, ok } from "../errors.js";
import type { DbError, Result } from "../errors.js";

// 72 hours in seconds — soft bounces expire and can retry
const SOFT_BOUNCE_TTL_SECONDS = 72 * 60 * 60;

export class FeedbackProcessor {
  private readonly processingDb: ProcessingDatabase;
  private readonly accountDb: AccountDatabase;

  constructor(processingDb: ProcessingDatabase, accountDb: AccountDatabase) {
    this.processingDb = processingDb;
    this.accountDb = accountDb;
  }

  process(event: SQSEvent): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      this.doProcess(event),
      (e) => dbError(e instanceof Error ? e : new Error(String(e))),
    );
  }

  private async doProcess(event: SQSEvent): Promise<void> {
    for (const record of event.Records) {
      let feedback: SesFeedback;
      try {
        const sns = JSON.parse(record.body) as { Message: string };
        feedback = JSON.parse(sns.Message) as SesFeedback;
      } catch (err) {
        console.error("Failed to parse feedback record:", err);
        continue;
      }

      const result = await this.processFeedback(feedback);
      if (result.isErr()) {
        console.error("Failed to process feedback record:", result.error.cause);
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
              console.error("Failed to disable forward actions after bounce:", disableResult.error.cause);
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
