import { DateTime } from "luxon";
import type { Logger } from "../logger.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { EmailService } from "../email/email-service.js";
import { buildSignalGsi3pk } from "../processor/message-id.js";
import { SYSTEM_ACCOUNT_ID } from "../database/system-account-db.js";
import { renderTemplate } from "../email/template-renderer.js";

export interface HealthcheckJobDeps {
  threadDb: ThreadDatabase;
  emailService: EmailService;
  searchDatabase: { hasEmbedding(threadId: string): Promise<boolean> };
  mailDomain: string;
  logger: Logger;
}

interface ValidationChecks {
  hasThreadId: boolean;
  workflowIsHealthcheck: boolean;
  hasEmbedding: boolean;
}

export class HealthcheckJob {
  private lastValidationResults: ValidationChecks | null = null;

  constructor(private readonly deps: HealthcheckJobDeps) {}

  async run(): Promise<void> {
    const now = DateTime.utc();
    const today = now.toFormat("yyyy-MM-dd");
    const yesterday = now.minus({ days: 1 }).toFormat("yyyy-MM-dd");

    await this.validate(yesterday);
    await this.send(today);
  }

  private buildMessageId(date: string): string {
    return `healthcheck-${date}@${this.deps.mailDomain}`;
  }

  private async validate(date: string): Promise<void> {
    const expectedMessageId = this.buildMessageId(date);
    const gsi3pk = buildSignalGsi3pk(SYSTEM_ACCOUNT_ID, expectedMessageId);

    let signal: { threadId?: string; id: string; signalLookupId: string; accountId: string; status: string; source: string; type: string } | null;
    try {
      const result = await this.deps.threadDb.findSignalByEmailMessageId(gsi3pk);
      if (result.isErr()) {
        this.deps.logger.track("Healthcheck validation query failed — DynamoDB error.", {
          code: "healthcheck.validation_error",
          messageId: expectedMessageId,
          error: result.error,
        });
        this.lastValidationResults = null;
        return;
      }
      signal = result.value;
    } catch (e) {
      this.deps.logger.track("Healthcheck validation threw unexpected error.", {
        code: "healthcheck.validation_error",
        messageId: expectedMessageId,
        error: e,
      });
      this.lastValidationResults = null;
      return;
    }

    if (!signal) {
      this.deps.logger.track("Yesterday's healthcheck signal not found in signals table.", {
        code: "healthcheck.signal_not_found",
        messageId: expectedMessageId,
      });
      this.lastValidationResults = null;
      return;
    }

    const checks: ValidationChecks = {
      hasThreadId: Boolean(signal.threadId && signal.threadId.length > 0),
      workflowIsHealthcheck: false,
      hasEmbedding: false,
    };

    // GSI3 returns full item (ALL projection) — workflow lives in data.workflow
    const fullSignal = signal as unknown as { data?: { workflow?: string } };
    const workflow = fullSignal.data?.workflow;
    checks.workflowIsHealthcheck = workflow === "healthcheck";

    // Embedding existence check
    if (signal.threadId) {
      try {
        checks.hasEmbedding = await this.deps.searchDatabase.hasEmbedding(signal.threadId);
      } catch (e) {
        this.deps.logger.track("Aurora connectivity/timeout error during embedding existence check.", {
          code: "healthcheck.embedding_check_error",
          messageId: expectedMessageId,
          threadId: signal.threadId,
          error: e,
        });
        checks.hasEmbedding = false;
      }
    }

    this.lastValidationResults = checks;

    const allPassed = checks.hasThreadId && checks.workflowIsHealthcheck && checks.hasEmbedding;
    if (allPassed) {
      this.deps.logger.track("Healthcheck validation passed — yesterday's email fully processed.", {
        code: "healthcheck.validation_passed",
        messageId: expectedMessageId,
        checks,
      });
    } else {
      this.deps.logger.track("Healthcheck validation failed — one or more checks did not pass.", {
        code: "healthcheck.validation_failed",
        messageId: expectedMessageId,
        checks,
        signalState: { id: signal.id, threadId: signal.threadId, workflow },
      });
    }
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
        headers: [{ Name: "Message-ID", Value: `<${messageId}>` }],
        tags: [{ Name: "purpose", Value: "healthcheck" }],
        accountId: SYSTEM_ACCOUNT_ID,
      });

      if (result.isErr()) {
        this.deps.logger.track("Healthcheck email send failed — SES returned error.", {
          code: "healthcheck.send_failed",
          messageId,
          error: result.error,
        });
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
