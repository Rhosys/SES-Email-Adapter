import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { Forwarder } from "../processor/processor.js";
import type { ProcessingDatabase } from "../database/processing-database.js";

const FROM_ADDRESS = process.env["NOTIFICATION_FROM"] ?? "";
const EMAIL_BUCKET = process.env["EMAIL_BUCKET"] ?? "";
const CONFIG_SET = process.env["SES_CONFIGURATION_SET"] ?? "";

export class SesForwarder implements Forwarder {
  private readonly ses: SESClient;
  private readonly s3: S3Client;
  private readonly db: ProcessingDatabase;

  constructor(db: ProcessingDatabase, ses?: SESClient, s3?: S3Client) {
    this.db = db;
    this.ses = ses ?? new SESClient({});
    this.s3 = s3 ?? new S3Client({});
  }

  async forward(s3Key: string, toAddress: string, accountId: string): Promise<void> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: EMAIL_BUCKET, Key: s3Key }));
    const rawBytes = await res.Body!.transformToByteArray();

    const result = await this.ses.send(new SendRawEmailCommand({
      Source: FROM_ADDRESS,
      Destinations: [toAddress],
      RawMessage: { Data: rawBytes },
      ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
    }));

    // Store trace so bounce notifications can correlate back to the account + target
    if (result.MessageId) {
      await this.db.saveForwardTrace(result.MessageId, accountId, toAddress).catch((err) => {
        console.error("Failed to save forward trace:", err);
      });
    }
  }
}
