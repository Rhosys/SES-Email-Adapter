import { DateTime } from "luxon";
import type { Result, TransientSesError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { VerificationMailer } from "../api/aliasesApi.js";
import { EmailService } from "./email-service.js";
import { buildEmailTags } from "./tag-sanitizer.js";
import { renderTemplate } from "./template-renderer.js";

export class SesVerificationMailer implements VerificationMailer {
  constructor(
    private readonly emailService: EmailService,
    private readonly appBaseUrl: string,
    private readonly mailDomain: string,
    private readonly logger: Logger,
  ) {}

  async sendForwardVerification(accountId: string, address: string, token: string): Promise<Result<void, TransientSesError>> {
    const verifyUrl = `${this.appBaseUrl}/accounts/${accountId}/forwarding-addresses/${encodeURIComponent(address)}/verify?token=${token}`;
    const triggerId = `fwdverify-${accountId}-${address}`;
    const tags = this.buildTags(accountId, triggerId);

    const htmlBody = await renderTemplate("forward-verify", {
      address,
      verifyUrl,
      accountId,
      domain: this.mailDomain,
    });

    return this.emailService.send({
      to: address,
      subject: "Verify your forwarding address",
      textBody: `Click the link below to verify that you want to receive forwarded emails at ${address}:\n\n${verifyUrl}`,
      htmlBody,
      tags,
      fromOverride: `"Numaeel" <noreply@${this.mailDomain}>`,
      accountId,
    }).then(r => r.map(() => undefined));
  }

  async sendCalendarForwardVerification(accountId: string, address: string, token: string): Promise<Result<void, TransientSesError>> {
    const verifyUrl = `${this.appBaseUrl}/accounts/${accountId}/calendar-forwarding/${encodeURIComponent(address)}/verify?token=${token}`;
    const triggerId = `calverify-${accountId}-${address}`;
    const tags = this.buildTags(accountId, triggerId);

    const htmlBody = await renderTemplate("calendar-verify", {
      address,
      verifyUrl,
      accountId,
      domain: this.mailDomain,
    });

    return this.emailService.send({
      to: address,
      subject: "Verify your calendar forwarding address",
      textBody: `Click the link below to verify that you want to receive calendar forwarding at ${address}:\n\n${verifyUrl}`,
      htmlBody,
      tags,
      fromOverride: `"Numaeel" <noreply@${this.mailDomain}>`,
      accountId,
    }).then(r => r.map(() => undefined));
  }

  private buildTags(accountId: string, triggerId: string): Array<{ Name: string; Value: string }> {
    return buildEmailTags({
      accountId,
      fullDate: DateTime.utc().toISODate()!,
      invocationId: this.logger.getInvocationId(),
      triggerId,
    });
  }
}
