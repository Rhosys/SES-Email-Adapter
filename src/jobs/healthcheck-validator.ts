import { DateTime } from "luxon";
import type { Logger } from "../logger.js";
import type { ThreadDatabase } from "../database/thread-database.js";
import { SYSTEM_ACCOUNT_ID } from "../database/system-account-db.js";

// ---------------------------------------------------------------------------
// Healthcheck validation
//
// Encapsulates the "validation" half of the daily healthcheck: it verifies that
// the healthcheck email sent for a given day actually made it through the whole
// pipeline, and reports the result check-by-check. Shared by the scheduled
// HealthcheckJob (which then emails the result) and the admin API route (which
// returns the result to the admin UI on demand).
//
// The SYSTEM account only ever receives the daily healthcheck email, and its
// threads are retained for 7 days, so validation simply lists SYSTEM threads and
// looks for the one created on the target day. We deliberately do NOT rely on a
// deterministic Message-ID — SES does not allow setting a custom Message-ID
// header on outbound mail, so it cannot be used as a lookup key.
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
  /** The day (yyyy-MM-dd) whose healthcheck was validated. */
  checkedDate: string;
  /** ISO timestamp of when this validation ran. */
  checkedAt: string;
  checks: HealthCheckItem[];
  /**
   * Raw per-field results, present only when the healthcheck thread was found
   * and inspected. Consumed by the email template; `null` when the thread was
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
  logger: Logger;
}

const CHECK_LABELS = {
  threadCreated: "Healthcheck thread created",
  workflowClassified: "Classified as healthcheck workflow",
  embeddingIndexed: "Embedding indexed for search",
} as const;

// How far back to list SYSTEM threads when searching for the target day.
const LOOKBACK_LIMIT = 100;

export class HealthcheckValidator {
  constructor(private readonly deps: HealthcheckValidatorDeps) {}

  /** Validate the most recent healthcheck (yesterday's). */
  validateLatest(): Promise<HealthCheckValidation> {
    const yesterday = DateTime.utc().minus({ days: 1 }).toFormat("yyyy-MM-dd");
    return this.validate(yesterday);
  }

  async validate(date: string): Promise<HealthCheckValidation> {
    const checkedAt = DateTime.utc().toISO()!;
    const base = { checkedDate: date, checkedAt };

    let threads: Array<{ id: string; createdAt: string; workflow: string }>;
    try {
      const result = await this.deps.threadDb.listThreads(SYSTEM_ACCOUNT_ID, { limit: LOOKBACK_LIMIT });
      if (result.isErr()) {
        this.deps.logger.track("Healthcheck validation query failed — could not list SYSTEM threads.", {
          code: "healthcheck.validation_error",
          date,
          error: result.error,
        });
        return { ...base, status: "unknown", rawChecks: null, checks: this.errorChecks("Validation query failed — could not list threads.") };
      }
      threads = result.value.items;
    } catch (e) {
      this.deps.logger.track("Healthcheck validation threw unexpected error.", {
        code: "healthcheck.validation_error",
        date,
        error: e,
      });
      return { ...base, status: "unknown", rawChecks: null, checks: this.errorChecks("Validation threw an unexpected error.") };
    }

    // Find the healthcheck thread created on the target day. Prefer one already
    // classified as the healthcheck workflow; fall back to any thread from that
    // day (SYSTEM only ever receives the healthcheck email).
    const createdOnDay = threads.filter((t) => t.createdAt.slice(0, 10) === date);
    const thread = createdOnDay.find((t) => t.workflow === "healthcheck") ?? createdOnDay[0];

    if (!thread) {
      this.deps.logger.track(`Healthcheck thread not found for ${date} — email did not complete the pipeline.`, {
        code: "healthcheck.thread_not_found",
        date,
      });
      return {
        ...base,
        status: "fail",
        rawChecks: null,
        checks: [
          { id: "thread-created", label: CHECK_LABELS.threadCreated, status: "fail", detail: `No healthcheck thread was created for ${date}.` },
          { id: "workflow-classified", label: CHECK_LABELS.workflowClassified, status: "unknown" },
          { id: "embedding-indexed", label: CHECK_LABELS.embeddingIndexed, status: "unknown" },
        ],
      };
    }

    const checks: ValidationChecks = {
      hasThreadId: true,
      workflowIsHealthcheck: thread.workflow === "healthcheck",
      hasEmbedding: false,
    };

    try {
      checks.hasEmbedding = await this.deps.searchDatabase.hasEmbedding(thread.id);
    } catch (e) {
      this.deps.logger.track("Aurora connectivity/timeout error during embedding existence check.", {
        code: "healthcheck.embedding_check_error",
        date,
        threadId: thread.id,
        error: e,
      });
      checks.hasEmbedding = false;
    }

    const allPassed = checks.workflowIsHealthcheck && checks.hasEmbedding;
    if (allPassed) {
      this.deps.logger.track(`Healthcheck validation passed — ${date}'s email fully processed.`, {
        code: "healthcheck.validation_passed",
        date,
        threadId: thread.id,
        checks,
      });
    } else {
      this.deps.logger.track(`Healthcheck validation failed for ${date} — one or more checks did not pass.`, {
        code: "healthcheck.validation_failed",
        date,
        threadId: thread.id,
        checks,
        threadState: { id: thread.id, workflow: thread.workflow, createdAt: thread.createdAt },
      });
    }

    return {
      ...base,
      status: allPassed ? "pass" : "fail",
      rawChecks: checks,
      checks: [
        { id: "thread-created", label: CHECK_LABELS.threadCreated, status: "pass" },
        {
          id: "workflow-classified",
          label: CHECK_LABELS.workflowClassified,
          status: checks.workflowIsHealthcheck ? "pass" : "fail",
          ...(checks.workflowIsHealthcheck ? {} : { detail: `Classified as "${thread.workflow}" instead of "healthcheck".` }),
        },
        {
          id: "embedding-indexed",
          label: CHECK_LABELS.embeddingIndexed,
          status: checks.hasEmbedding ? "pass" : "fail",
          ...(checks.hasEmbedding ? {} : { detail: "No embedding found in the search index for this thread." }),
        },
      ],
    };
  }

  private errorChecks(detail: string): HealthCheckItem[] {
    return [
      { id: "thread-created", label: CHECK_LABELS.threadCreated, status: "unknown", detail },
      { id: "workflow-classified", label: CHECK_LABELS.workflowClassified, status: "unknown" },
      { id: "embedding-indexed", label: CHECK_LABELS.embeddingIndexed, status: "unknown" },
    ];
  }
}
