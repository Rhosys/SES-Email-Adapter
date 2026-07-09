import { DateTime } from "luxon";
import type { Logger } from "../logger.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import { buildSignalGsi3pk } from "../processor/message-id.js";
import { SYSTEM_ACCOUNT_ID } from "../database/system-account-db.js";

// ---------------------------------------------------------------------------
// Healthcheck validation
//
// Encapsulates the "validation" half of the daily healthcheck: it looks up the
// system healthcheck email that should have been ingested for a given day and
// reports, check-by-check, how far it made it through the pipeline. Shared by
// the scheduled HealthcheckJob (which then emails the result) and the admin API
// route (which returns the result to the admin UI on demand).
// ---------------------------------------------------------------------------

export type HealthCheckStatus = "pass" | "fail" | "unknown";

export interface HealthCheckItem {
  id: string;
  label: string;
  status: HealthCheckStatus;
  detail?: string;
}

export interface HealthCheckValidation {
  /** Overall status: pass = every check passed, fail = at least one failed, unknown = validation could not run. */
  status: HealthCheckStatus;
  /** The day (yyyy-MM-dd) whose healthcheck email was validated. */
  checkedDate: string;
  /** The Message-ID of the healthcheck email that was looked up. */
  messageId: string;
  /** ISO timestamp of when this validation ran. */
  checkedAt: string;
  checks: HealthCheckItem[];
  /**
   * Raw per-field results, present only when the healthcheck signal was found
   * and inspected. Consumed by the email template; `null` when the signal was
   * missing or the lookup errored.
   */
  rawChecks: ValidationChecks | null;
}

export interface ValidationChecks {
  hasThreadId: boolean;
  workflowIsHealthcheck: boolean;
  hasEmbedding: boolean;
}

export interface HealthcheckValidatorDeps {
  threadDb: ThreadDatabase;
  searchDatabase: { hasEmbedding(threadId: string): Promise<boolean> };
  mailDomain: string;
  logger: Logger;
}

const CHECK_LABELS = {
  signalReceived: "Healthcheck email received",
  threadAssigned: "Thread assigned to signal",
  workflowClassified: "Classified as healthcheck workflow",
  embeddingIndexed: "Embedding indexed for search",
} as const;

export class HealthcheckValidator {
  constructor(private readonly deps: HealthcheckValidatorDeps) {}

  buildMessageId(date: string): string {
    return `healthcheck-${date}@${this.deps.mailDomain}`;
  }

  /** Validate the most recently expected healthcheck email (yesterday's). */
  validateLatest(): Promise<HealthCheckValidation> {
    const yesterday = DateTime.utc().minus({ days: 1 }).toFormat("yyyy-MM-dd");
    return this.validate(yesterday);
  }

  async validate(date: string): Promise<HealthCheckValidation> {
    const checkedAt = DateTime.utc().toISO()!;
    const expectedMessageId = this.buildMessageId(date);
    const gsi3pk = buildSignalGsi3pk(SYSTEM_ACCOUNT_ID, expectedMessageId);

    const base = { checkedDate: date, messageId: expectedMessageId, checkedAt };

    let signal: { threadId?: string; id: string; signalLookupId: string; accountId: string; status: string; source: string; type: string } | null;
    try {
      const result = await this.deps.threadDb.findSignalByEmailMessageId(gsi3pk);
      if (result.isErr()) {
        this.deps.logger.track("Healthcheck validation query failed — DynamoDB error.", {
          code: "healthcheck.validation_error",
          messageId: expectedMessageId,
          error: result.error,
        });
        return { ...base, status: "unknown", rawChecks: null, checks: this.errorChecks("Validation query failed — could not reach the signals table.") };
      }
      signal = result.value;
    } catch (e) {
      this.deps.logger.track("Healthcheck validation threw unexpected error.", {
        code: "healthcheck.validation_error",
        messageId: expectedMessageId,
        error: e,
      });
      return { ...base, status: "unknown", rawChecks: null, checks: this.errorChecks("Validation threw an unexpected error.") };
    }

    if (!signal) {
      this.deps.logger.track("Yesterday's healthcheck signal not found in signals table.", {
        code: "healthcheck.signal_not_found",
        messageId: expectedMessageId,
      });
      return {
        ...base,
        status: "fail",
        rawChecks: null,
        checks: [
          { id: "signal-received", label: CHECK_LABELS.signalReceived, status: "fail", detail: "No healthcheck signal found for this day." },
          { id: "thread-assigned", label: CHECK_LABELS.threadAssigned, status: "unknown" },
          { id: "workflow-classified", label: CHECK_LABELS.workflowClassified, status: "unknown" },
          { id: "embedding-indexed", label: CHECK_LABELS.embeddingIndexed, status: "unknown" },
        ],
      };
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

    return {
      ...base,
      status: allPassed ? "pass" : "fail",
      rawChecks: checks,
      checks: [
        { id: "signal-received", label: CHECK_LABELS.signalReceived, status: "pass" },
        {
          id: "thread-assigned",
          label: CHECK_LABELS.threadAssigned,
          status: checks.hasThreadId ? "pass" : "fail",
          ...(checks.hasThreadId ? {} : { detail: "Signal was ingested but never matched to a thread." }),
        },
        {
          id: "workflow-classified",
          label: CHECK_LABELS.workflowClassified,
          status: checks.workflowIsHealthcheck ? "pass" : "fail",
          ...(checks.workflowIsHealthcheck ? {} : { detail: `Classified as "${workflow ?? "unknown"}" instead of "healthcheck".` }),
        },
        {
          id: "embedding-indexed",
          label: CHECK_LABELS.embeddingIndexed,
          status: checks.hasEmbedding ? "pass" : "fail",
          ...(checks.hasEmbedding ? {} : { detail: checks.hasThreadId ? "No embedding found in the search index for this thread." : "Skipped — no thread to index." }),
        },
      ],
    };
  }

  private errorChecks(detail: string): HealthCheckItem[] {
    return [
      { id: "signal-received", label: CHECK_LABELS.signalReceived, status: "unknown", detail },
      { id: "thread-assigned", label: CHECK_LABELS.threadAssigned, status: "unknown" },
      { id: "workflow-classified", label: CHECK_LABELS.workflowClassified, status: "unknown" },
      { id: "embedding-indexed", label: CHECK_LABELS.embeddingIndexed, status: "unknown" },
    ];
  }
}
