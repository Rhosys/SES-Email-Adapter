// ---------------------------------------------------------------------------
// ReplySenderService — reply sender via EmailService
// ---------------------------------------------------------------------------

import type { ReplySender } from "../processor/processor.js";
import type { EmailService } from "../email/email-service.js";
import type { EmailServiceError } from "../email/email-service.js";
import type { Result } from "../errors.js";
import { ok } from "../errors.js";
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
    accountId?: string;
    signalId?: string;
    threadId?: string;
  }): Promise<Result<{ messageId: string }, EmailServiceError>> {
    const resolvedAccountId = opts.accountId ?? this.emailService.platformTenant;
    const tags = buildOutboundTags("reply", {
      accountId: resolvedAccountId,
      signalId: opts.signalId,
      threadId: opts.threadId,
    });

    const result = await this.emailService.send({
      to: opts.to,
      fromOverride: opts.from,
      subject: `Re: ${opts.subject}`,
      textBody: opts.body,
      accountId: resolvedAccountId,
      headers: [
        { Name: "In-Reply-To", Value: opts.inReplyTo },
        { Name: "References", Value: opts.inReplyTo },
      ],
      tags,
    });

    if (result.isErr() && result.error.kind === "permanent_ses_error") {
      this.logger.warn("Reply send permanently rejected by SES — will not retry.", { code: "reply_sender.send_permanent", accountId: resolvedAccountId, error: result.error });
      return ok({ messageId: "" });
    }

    if (result.isErr()) {
      this.logger.info("Reply send failed (transient)", { code: "reply_sender.transient_failure", to: opts.to, accountId: resolvedAccountId, error: result.error });
      return result;
    }

    this.logger.info("Reply sent", { code: "reply_sender.sent", to: opts.to, from: opts.from, accountId: resolvedAccountId });
    return result;
  }
}
