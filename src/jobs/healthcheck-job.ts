import { DateTime } from "luxon";
import type { Logger } from "../logger.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { EmailService } from "../email/email-service.js";
import { SYSTEM_ACCOUNT_ID } from "../database/system-account-db.js";
import { renderTemplate } from "../email/template-renderer.js";
import { HealthcheckValidator, type ValidationChecks } from "./healthcheck-validator.js";
import { TAG_HEALTHCHECK_ID } from "../email/ses-tags.js";

export interface HealthcheckJobDeps {
  threadDb: ThreadDatabase;
  emailService: EmailService;
  searchDatabase: { hasEmbedding(threadId: string): Promise<boolean> };
  mailDomain: string;
  logger: Logger;
}

export class HealthcheckJob {
  private lastValidationResults: ValidationChecks | null = null;
  private readonly validator: HealthcheckValidator;

  constructor(private readonly deps: HealthcheckJobDeps) {
    this.validator = new HealthcheckValidator({
      threadDb: deps.threadDb,
      searchDatabase: deps.searchDatabase,
      logger: deps.logger,
    });
  }

  async run(): Promise<void> {
    const now = DateTime.utc();
    const today = now.toFormat("yyyy-MM-dd");
    const yesterday = now.minus({ days: 1 }).toFormat("yyyy-MM-dd");

    const validation = await this.validator.validate(yesterday);
    this.lastValidationResults = validation.rawChecks;
    await this.send(today);
  }

  private buildMessageId(date: string): string {
    return `healthcheck-${date}@${this.deps.mailDomain}`;
  }

  private async send(today: string): Promise<void> {
    const messageId = this.buildMessageId(today);
    const recipient = `healthcheck@${this.deps.mailDomain}`;
    const subject = `Healthcheck ${today}`;

    const templateData: HealthcheckTemplateData = {
      date: today,
      messageId,
      invocationId: this.deps.logger.getInvocationId(),
      containerId: process.env["AWS_LAMBDA_LOG_STREAM_NAME"] ?? "unknown",
      timestamp: DateTime.utc().toISO()!,
      validationResults: this.lastValidationResults,
    };
    const { html, text } = await renderHealthcheckEmail(templateData, this.deps.mailDomain);

    try {
      const result = await this.deps.emailService.send({
        to: recipient,
        subject,
        textBody: text,
        htmlBody: html,
        // `purpose` groups healthcheck sends; the healthcheck-id tag lets us
        // correlate a bounce/complaint back to a specific day's send (SES echoes
        // message tags in feedback notifications). Tag values must be
        // [A-Za-z0-9_-], so we use the id without the `@domain` suffix.
        tags: [
          { Name: "purpose", Value: "healthcheck" },
          { Name: TAG_HEALTHCHECK_ID, Value: `healthcheck-${today}` },
        ],
        accountId: SYSTEM_ACCOUNT_ID,
      });

      if (result.isErr()) {
        const cause = result.error.cause as { message?: string } | undefined;
        this.deps.logger.track(
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
      this.deps.logger.track("Healthcheck send phase threw unexpected error.", {
        code: "healthcheck.send_error",
        messageId,
        error: e,
      });
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
  validationResults: ValidationChecks | null;
}

export async function renderHealthcheckEmail(data: HealthcheckTemplateData, mailDomain: string): Promise<{ html: string; text: string }> {
  const checkIcon = (passed: boolean) => passed ? "✓" : "✗";
  const checkLabel = (passed: boolean) => passed ? "pass" : "FAIL";

  const templateVars: Record<string, unknown> = {
    date: data.date,
    messageId: data.messageId,
    invocationId: data.invocationId,
    containerId: data.containerId,
    timestamp: data.timestamp,
    domain: mailDomain,
    hasValidationResults: data.validationResults !== null,
    hasThreadIdIcon: data.validationResults ? checkIcon(data.validationResults.hasThreadId) : "",
    hasThreadIdLabel: data.validationResults ? checkLabel(data.validationResults.hasThreadId) : "",
    workflowIsHealthcheckIcon: data.validationResults ? checkIcon(data.validationResults.workflowIsHealthcheck) : "",
    workflowIsHealthcheckLabel: data.validationResults ? checkLabel(data.validationResults.workflowIsHealthcheck) : "",
    hasEmbeddingIcon: data.validationResults ? checkIcon(data.validationResults.hasEmbedding) : "",
    hasEmbeddingLabel: data.validationResults ? checkLabel(data.validationResults.hasEmbedding) : "",
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
    "--- Validation Results (Yesterday) ---",
    ...(data.validationResults
      ? [
          "Signal found: ✓",
          `Thread ID present: ${checkIcon(data.validationResults.hasThreadId)} ${checkLabel(data.validationResults.hasThreadId)}`,
          `Workflow is healthcheck: ${checkIcon(data.validationResults.workflowIsHealthcheck)} ${checkLabel(data.validationResults.workflowIsHealthcheck)}`,
          `Embedding indexed: ${checkIcon(data.validationResults.hasEmbedding)} ${checkLabel(data.validationResults.hasEmbedding)}`,
        ]
      : ["No validation results — first run or validation error occurred."]),
    "",
    "---",
    "This email is part of the daily pipeline healthcheck system.",
    `Sent to healthcheck@${mailDomain} and processed through the full pipeline.`,
  ].join("\n");

  return { html, text };
}
