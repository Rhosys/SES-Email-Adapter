// ---------------------------------------------------------------------------
// ReplySenderService — reply sender via EmailService
// ---------------------------------------------------------------------------

import type { ReplySender } from "../processor/processor.js";
import type { EmailService } from "../email/email-service.js";
import type { TransientSesError } from "../errors.js";
import type { Result } from "../errors.js";
import { buildOutboundTags } from "../email/ses-tags.js";
import type { Logger } from "../logger.js";

export class ReplySenderService implements ReplySender {
  private readonly emailService: EmailService;
  private readonly logger: Logger;

  constructor(emailService: EmailService, logger: Logger) {
    this.emailService = emailService;
    this.logger = logger;
  }

  async sendReply(opts: {
    to: string;
    from: string;
    subject: string;
    body: string;
    inReplyTo: string;
    accountId: string;
    signalId?: string;
    threadId?: string;
  }): Promise<Result<{ messageId: string }, TransientSesError>> {
    const tags = buildOutboundTags("reply", {
      accountId: opts.accountId,
      signalId: opts.signalId,
      arcId: opts.threadId,
    });

    return this.emailService.send({
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
  }
}
