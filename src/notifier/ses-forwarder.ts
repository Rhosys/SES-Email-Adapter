import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { Forwarder } from "../processor/processor.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";

const FROM_ADDRESS = process.env["NOTIFICATION_FROM"] ?? "";
const EMAIL_BUCKET = process.env["EMAIL_BUCKET"] ?? "";
const CONFIG_SET = process.env["SES_CONFIGURATION_SET"] ?? "";

export class SesForwarder implements Forwarder {
  private readonly sesv2: SESv2Client;
  private readonly s3: S3Client;
  private readonly logger: Logger;

  constructor(logger: Logger, sesv2?: SESv2Client, s3?: S3Client) {
    this.logger = logger;
    this.sesv2 = sesv2 ?? new SESv2Client({});
    this.s3 = s3 ?? new S3Client({});
  }

  async forward(s3Key: string, toAddress: string, accountId: string): Promise<Result<void, DbError>> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: EMAIL_BUCKET, Key: s3Key }));
      const rawBytes = await res.Body!.transformToByteArray();

      await this.sesv2.send(new SendEmailCommand({
        FromEmailAddress: FROM_ADDRESS,
        Destination: { ToAddresses: [toAddress] },
        Content: { Raw: { Data: rawBytes } },
        ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
        EmailTags: [
          { Name: "accountId", Value: accountId },
          { Name: "type", Value: "forward" },
        ],
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
