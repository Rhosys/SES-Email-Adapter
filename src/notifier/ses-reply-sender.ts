// ---------------------------------------------------------------------------
// SES Reply Sender
// Sends composed reply emails (pong, auto-reply) via SESv2.
// ---------------------------------------------------------------------------

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { ReplySender } from "../processor/processor.js";

const CONFIG_SET = process.env["SES_CONFIGURATION_SET"] ?? "";

export class SesReplySender implements ReplySender {
  private readonly sesv2: SESv2Client;

  constructor(sesv2?: SESv2Client) {
    this.sesv2 = sesv2 ?? new SESv2Client({});
  }

  async sendReply(opts: {
    to: string;
    from: string;
    subject: string;
    body: string;
    inReplyTo: string;
  }): Promise<{ messageId: string }> {
    const result = await this.sesv2.send(new SendEmailCommand({
      FromEmailAddress: opts.from,
      Destination: { ToAddresses: [opts.to] },
      Content: {
        Simple: {
          Subject: { Data: `Re: ${opts.subject}`, Charset: "UTF-8" },
          Body: {
            Text: { Data: opts.body, Charset: "UTF-8" },
          },
          Headers: [
            { Name: "In-Reply-To", Value: opts.inReplyTo },
            { Name: "References", Value: opts.inReplyTo },
          ],
        },
      },
      ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
      EmailTags: [
        { Name: "type", Value: "reply" },
      ],
    }));

    return { messageId: result.MessageId ?? "" };
  }
}
