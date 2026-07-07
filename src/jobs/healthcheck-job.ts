import { DateTime } from "luxon";
import type { Logger } from "../logger.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { EmailService } from "../email/email-service.js";
import { buildSignalGsi3pk } from "../processor/message-id.js";
import { SYSTEM_ACCOUNT_ID } from "../database/system-account-db.js";

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

    // Build text body — placeholder until MJML template is created (Task 11)
    const textBody = [
      `Daily pipeline healthcheck — ${today}`,
      "",
      "This is an automated system-generated email to validate the email-catcher processing pipeline.",
      "It exercises: SES receive → S3 → Lambda → MIME parse → classify → embed → Aurora pgvector upsert.",
      "",
      `Message-ID: ${messageId}`,
      `Invocation: ${this.deps.logger.getInvocationId()}`,
      `Timestamp: ${DateTime.utc().toISO()}`,
      "",
      "Validation results from today's run:",
      this.lastValidationResults
        ? JSON.stringify(this.lastValidationResults, null, 2)
        : "No validation results (first run or validation error)",
    ].join("\n");

    try {
      const result = await this.deps.emailService.send({
        to: recipient,
        subject,
        textBody,
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
