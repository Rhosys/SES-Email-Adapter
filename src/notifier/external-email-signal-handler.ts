// ---------------------------------------------------------------------------
// ExternalEmailSignalHandler — unified reply sender + forwarder via EmailService
// Replaces ses-reply-sender.ts and ses-forwarder.ts with a single class that
// delegates all SES knowledge to EmailService.
// ---------------------------------------------------------------------------

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { ReplySender, Forwarder } from "../processor/processor.js";
import type { EmailService } from "../email/email-service.js";
import type { DbError, Result } from "../errors.js";
import { ok, err, dbError } from "../errors.js";
import { buildOutboundTags } from "../email/ses-tags.js";
import type { Logger } from "../logger.js";

export class ExternalEmailSignalHandler implements ReplySender, Forwarder {
  private readonly emailService: EmailService;
  private readonly s3: S3Client;
  private readonly logger: Logger;
  private readonly emailBucket: string;

  constructor(emailService: EmailService, s3: S3Client, logger: Logger, emailBucket: string) {
    this.emailService = emailService;
    this.s3 = s3;
    this.logger = logger;
    this.emailBucket = emailBucket;
  }

  async sendReply(opts: {
    to: string;
    from: string;
    subject: string;
    body: string;
    inReplyTo: string;
    accountId: string;
    signalId?: string;
    arcId?: string;
  }): Promise<{ messageId: string }> {
    const tags = buildOutboundTags("reply", {
      accountId: opts.accountId,
      signalId: opts.signalId,
      arcId: opts.arcId,
    });

    const result = await this.emailService.send({
      to: opts.to,
      fromOverride: opts.from,
      subject: `Re: ${opts.subject}`,
      textBody: opts.body,
      accountId: opts.accountId,
      headers: [
        { Name: "In-Reply-To", Value: opts.inReplyTo },
        { Name: "References", Value: opts.inReplyTo },
      ],
      tags,
    });

    if (result.isErr()) {
      throw result.error;
    }

    return { messageId: result.value.messageId };
  }

  async forward(s3Key: string, toAddress: string, accountId: string, opts?: { signalId?: string; arcId?: string }): Promise<Result<void, DbError>> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.emailBucket, Key: s3Key }));
      const rawBytes = await res.Body!.transformToByteArray();

      const tags = buildOutboundTags("forward", { accountId, signalId: opts?.signalId, arcId: opts?.arcId });

      const result = await this.emailService.sendRaw({
        to: toAddress,
        rawData: rawBytes,
        accountId,
        tags,
      });

      if (result.isErr()) {
        return err(result.error);
      }

      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
