import { DateTime } from "luxon";
import type { Logger } from "../logger.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { EmailService } from "../email/email-service.js";
import { SYSTEM_ACCOUNT_ID } from "../database/system-account-db.js";
import { renderTemplate } from "../email/template-renderer.js";
import type { HealthcheckValidator, HealthCheckValidation, HealthCheckItem } from "./healthcheck-validator.js";
import { TAG_HEALTHCHECK_ID, TAG_PURPOSE } from "../email/ses-tags.js";

export interface HealthcheckJobDeps {
  threadDb: ThreadDatabase;
  emailService: EmailService;
  validator: HealthcheckValidator;
  mailDomain: string;
  logger: Logger;
}

export class HealthcheckJob {
  constructor(private readonly deps: HealthcheckJobDeps) {}

  async run(): Promise<void> {
    const now = DateTime.utc();
    const today = now.toFormat("yyyy-MM-dd");
    const yesterday = now.minus({ days: 1 }).toFormat("yyyy-MM-dd");

    const validation = await this.deps.validator.validate(yesterday);
    await this.send(today, validation);
  }

  private buildMessageId(date: string): string {
    return `healthcheck-${date}@${this.deps.mailDomain}`;
  }

  private async send(today: string, validation: HealthCheckValidation): Promise<void> {
    const messageId = this.buildMessageId(today);
    const recipient = `healthcheck@healthcheck.${this.deps.mailDomain}`;
    const subject = `Healthcheck ${today}`;

    const templateData: HealthcheckTemplateData = {
      date: today,
      messageId,
      invocationId: this.deps.logger.getInvocationId(),
      containerId: process.env["AWS_LAMBDA_LOG_STREAM_NAME"] ?? "unknown",
      timestamp: DateTime.utc().toISO()!,
      validation,
    };
    const { html, text } = await renderHealthcheckEmail(templateData, this.deps.emailService.appDomain, this.deps.mailDomain);

    try {
      const result = await this.deps.emailService.send({
        to: recipient,
        subject,
        textBody: text,
        htmlBody: html,
        // TAG_PURPOSE and TAG_HEALTHCHECK_ID are custom MIME headers — they appear in the
        // delivered email AND are auto-promoted to SES tags by EmailService for feedback
        // correlation. Tag values must be [A-Za-z0-9_-], so we use the id without the
        // `@domain` suffix.
        headers: [
          { Name: TAG_PURPOSE, Value: "healthcheck" },
          { Name: TAG_HEALTHCHECK_ID, Value: `healthcheck-${today}` },
        ],
        accountId: SYSTEM_ACCOUNT_ID,
      });

      if (result.isErr()) {
        if (result.error.kind === "permanent_ses_error") {
          this.deps.logger.error(
            `Healthcheck email permanently rejected by SES — ${result.error.errorName}`,
            { code: "healthcheck.send_permanent_failure", messageId, error: result.error },
          );
          return;
        }
        // transient/invalid_argument
        const cause = result.error.kind === "transient_ses_error" ? result.error.cause as { message?: string } | undefined : undefined;
        this.deps.logger.error(
          `Healthcheck email send failed — SES returned error${cause?.message ? `: ${cause.message}` : ""}.`,
          {
            code: "healthcheck.send_failed",
            messageId,
            error: result.error,
          },
        );
        return;
      }

      this.deps.logger.info("Healthcheck email sent successfully.", {
        code: "healthcheck.send_success",
        messageId,
        sesMessageId: result.value.messageId,
      });
    } catch (e) {
      const causeMessage = (e as { message?: string } | undefined)?.message;
      this.deps.logger.error(
        `Healthcheck send phase threw unexpected error${causeMessage ? `: ${causeMessage}` : ""}.`,
        {
          code: "healthcheck.send_error",
          messageId,
          error: e,
        },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

export interface HealthcheckTemplateData {
  date: string;
  messageId: string;
  invocationId: string;
  containerId: string;
  timestamp: string;
  validation: HealthCheckValidation;
}

function iconFor(status: HealthCheckItem["status"]): string {
  return status === "pass" ? "✓" : status === "fail" ? "✗" : "?";
}

export async function renderHealthcheckEmail(data: HealthcheckTemplateData, appDomain: string, mailDomain: string): Promise<{ html: string; text: string }> {
  const checks = data.validation.checks;

  const templateChecks = checks.map((c) => ({
    label: c.label,
    icon: iconFor(c.status),
    statusLabel: c.status,
    section: c.section,
    detail: c.detail ?? "",
    hasDetail: Boolean(c.detail),
  }));

  const templateVars: Record<string, unknown> = {
    date: data.date,
    messageId: data.messageId,
    invocationId: data.invocationId,
    containerId: data.containerId,
    timestamp: data.timestamp,
    domain: appDomain,
    checks: templateChecks,
    hasChecks: templateChecks.length > 0,
    overallStatus: data.validation.status,
    // Footer partial expects these
    unsubscribeCode: "",
    emailType: "healthcheck",
  };

  const html = await renderTemplate("healthcheck", templateVars);

  const text = [
    `Pipeline Healthcheck — ${data.date}`,
    "",
    "System-generated pipeline validation email (workflow: healthcheck).",
    "This is an automated daily healthcheck that exercises the full email-catcher processing pipeline.",
    "For: operations / automated monitoring. Account: SYSTEM.",
    "",
    "--- Execution Context ---",
    `Run Date: ${data.date}`,
    `Message-ID: ${data.messageId}`,
    `Invocation ID: ${data.invocationId}`,
    `Container ID: ${data.containerId}`,
    `Timestamp: ${data.timestamp}`,
    "",
    `--- Validation Results (${data.validation.checkedDate}) — overall: ${data.validation.status} ---`,
    ...(checks.length > 0
      ? checks.map((c) => `${iconFor(c.status)} ${c.label}${c.detail ? " — " + c.detail : ""}`)
      : ["No validation results — first run or validation error occurred."]),
    "",
    "---",
    "This email is part of the daily pipeline healthcheck system.",
    `Sent to healthcheck@healthcheck.${mailDomain} and processed through the full pipeline.`,
  ].join("\n");

  return { html, text };
}
