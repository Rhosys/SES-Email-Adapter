import type { SQSEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SesFeedback, SuppressedAddress } from "../types/index.js";

const TABLE = process.env["PROCESSING_TABLE"] ?? "ses-processing";
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// 72 hours in seconds — soft bounces expire and can retry
const SOFT_BOUNCE_TTL_SECONDS = 72 * 60 * 60;

export class FeedbackProcessor {
  async process(event: SQSEvent): Promise<void> {
    for (const record of event.Records) {
      try {
        // SQS record body is an SNS notification envelope
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
        feedback.bounce.bouncedRecipients.map((r) => {
          const entry: SuppressedAddress = {
            address: r.emailAddress,
            reason: isPermanent ? "hard_bounce" : "soft_bounce",
            suppressedAt,
            ...(!isPermanent ? { ttl: Math.floor(Date.now() / 1000) + SOFT_BOUNCE_TTL_SECONDS } : {}),
          };
          return this.suppressAddress(entry);
        }),
      );
    } else if (feedback.notificationType === "Complaint" && feedback.complaint) {
      const suppressedAt = new Date().toISOString();

      await Promise.all(
        feedback.complaint.complainedRecipients.map((r) => {
          const entry: SuppressedAddress = {
            address: r.emailAddress,
            reason: "complaint",
            suppressedAt,
          };
          return this.suppressAddress(entry);
        }),
      );
    }
  }

  private async suppressAddress(entry: SuppressedAddress): Promise<void> {
    await dynamo.send(new PutCommand({
      TableName: TABLE,
      Item: { ...entry, pk: `SUPPRESS#${entry.address}`, sk: "SUPPRESS" },
    }));
  }
}
