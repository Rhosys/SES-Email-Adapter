import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { Forwarder } from "../processor/processor.js";

const FORWARD_SOURCE = process.env["NOTIFICATION_FROM"] ?? "";
const EMAIL_BUCKET = process.env["EMAIL_BUCKET"] ?? "";

export class SesForwarder implements Forwarder {
  private readonly ses: SESClient;
  private readonly s3: S3Client;

  constructor(ses?: SESClient, s3?: S3Client) {
    this.ses = ses ?? new SESClient({});
    this.s3 = s3 ?? new S3Client({});
  }

  async forward(s3Key: string, toAddress: string): Promise<void> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: EMAIL_BUCKET, Key: s3Key }));
    const rawBytes = await res.Body!.transformToByteArray();

    await this.ses.send(new SendRawEmailCommand({
      Source: FORWARD_SOURCE,
      Destinations: [toAddress],
      RawMessage: { Data: rawBytes },
    }));
  }
}
