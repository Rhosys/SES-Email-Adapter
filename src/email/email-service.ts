// ---------------------------------------------------------------------------
// EmailService — shared SES abstraction for all outbound email
// ---------------------------------------------------------------------------

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";

export interface EmailSendOptions {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  headers?: Array<{ Name: string; Value: string }>;
  tags?: Array<{ Name: string; Value: string }>;
  fromOverride?: string;
}

export interface EmailRawOptions {
  to: string;
  rawData: Uint8Array;
  tags?: Array<{ Name: string; Value: string }>;
}

export class EmailService {
  private readonly sesv2: SESv2Client;
  private readonly from: string;
  private readonly configSet: string;

  constructor(sesv2: SESv2Client, opts: { from: string; configSet: string }) {
    this.sesv2 = sesv2;
    this.from = opts.from;
    this.configSet = opts.configSet;
  }

  async send(opts: EmailSendOptions): Promise<Result<{ messageId: string }, DbError>> {
    try {
      const result = await this.sesv2.send(new SendEmailCommand({
        FromEmailAddress: opts.fromOverride ?? this.from,
        Destination: { ToAddresses: [opts.to] },
        Content: {
          Simple: {
            Subject: { Data: opts.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: opts.textBody, Charset: "UTF-8" },
              ...(opts.htmlBody ? { Html: { Data: opts.htmlBody, Charset: "UTF-8" } } : {}),
            },
            ...(opts.headers?.length ? { Headers: opts.headers } : {}),
          },
        },
        ...(this.configSet ? { ConfigurationSetName: this.configSet } : {}),
        ...(opts.tags?.length ? { EmailTags: opts.tags } : {}),
      }));
      return ok({ messageId: result.MessageId ?? "" });
    } catch (e) {
      return err(dbError(e));
    }
  }

  async sendRaw(opts: EmailRawOptions): Promise<Result<{ messageId: string }, DbError>> {
    try {
      const result = await this.sesv2.send(new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [opts.to] },
        Content: { Raw: { Data: opts.rawData } },
        ...(this.configSet ? { ConfigurationSetName: this.configSet } : {}),
        ...(opts.tags?.length ? { EmailTags: opts.tags } : {}),
      }));
      return ok({ messageId: result.MessageId ?? "" });
    } catch (e) {
      return err(dbError(e));
    }
  }
}
