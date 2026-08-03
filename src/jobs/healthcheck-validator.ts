import dns from "node:dns/promises";
import { DateTime } from "luxon";
import type { Logger } from "../logger.js";
import type { DbError, Result } from "../errors.js";
import type { Domain, DnsRecord } from "../types/index.js";
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
  section: "terminus" | "delegation" | "ses" | "pipeline";
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
  threadDb: { listActiveThreadsSince(accountId: string, sinceDate: string): Promise<Result<Array<{ id: string; createdAt: string; workflow: string }>, DbError>> };
  searchDatabase: { hasEmbedding(threadId: string): Promise<Result<boolean, DbError>> };
  sesChecker: { canSendFrom(domain: string): Promise<{ verified: boolean; dkimEnabled: boolean; accountSendingEnabled: boolean; detail?: string }> };
  dnsChecker: { checkDomain(domain: Domain): Promise<DnsRecord[]> };
  mailDomain: string;
  logger: Logger;
}

const CHECK_LABELS = {
  threadCreated: "Healthcheck thread created",
  workflowClassified: "Classified as healthcheck workflow",
  embeddingIndexed: "Embedding indexed for search",
} as const;

// How far back to search for a successful healthcheck day.
const MAX_LOOKBACK_DAYS = 7;

export class HealthcheckValidator {
  constructor(private readonly deps: HealthcheckValidatorDeps) {}

  /** Validate the most recent healthcheck (yesterday's), with lookback up to 7 days for context. */
  async validateLatest(): Promise<HealthCheckValidation> {
    const now = DateTime.utc();
    const checkedAt = now.toISO()!;
    const yesterday = now.minus({ days: 1 }).toFormat("yyyy-MM-dd");

    // Infra checks are point-in-time — run once
    const dnsChecks = await this.checkPlatformDns();
    const delegationChecks = await this.checkDelegation();
    const sesChecks = await this.checkSesIdentity();
    const infraChecks = [...dnsChecks, ...delegationChecks, ...sesChecks];

    // Fetch active SYSTEM threads from the last 7 days (bounded query, single DDB call)
    const sinceDate = now.minus({ days: MAX_LOOKBACK_DAYS }).toFormat("yyyy-MM-dd");
    let threads: Array<{ id: string; createdAt: string; workflow: string }>;
    try {
      const result = await this.deps.threadDb.listActiveThreadsSince(SYSTEM_ACCOUNT_ID, sinceDate);
      if (result.isErr()) {
        this.deps.logger.error("Healthcheck validation query failed — could not list SYSTEM threads.", {
          code: "healthcheck.validation_error",
          error: result.error,
        });
        return { checkedDate: yesterday, checkedAt, status: "unknown", rawChecks: null, checks: [...infraChecks, ...this.errorChecks("Validation query failed — could not list threads.")] };
      }
      threads = result.value;
    } catch (e) {
      this.deps.logger.error("Healthcheck validation threw unexpected error.", {
        code: "healthcheck.validation_error",
        error: e,
      });
      return { checkedDate: yesterday, checkedAt, status: "unknown", rawChecks: null, checks: [...infraChecks, ...this.errorChecks("Validation threw an unexpected error.")] };
    }

    // Check day-by-day starting from yesterday, going back up to MAX_LOOKBACK_DAYS.
    // Collect pipeline checks for each failed day (with date in detail). Stop on first success.
    const pipelineChecks: HealthCheckItem[] = [];
    let rawChecks: ValidationChecks | null = null;
    let yesterdayPassed = false;

    for (let daysBack = 1; daysBack <= MAX_LOOKBACK_DAYS; daysBack++) {
      const date = now.minus({ days: daysBack }).toFormat("yyyy-MM-dd");
      const dayResult = await this.validateDay(date, threads);

      for (const check of dayResult.checks) {
        pipelineChecks.push(check);
      }
      rawChecks = dayResult.rawChecks;

      if (dayResult.status === "pass") {
        if (daysBack === 1) yesterdayPassed = true;
        break;
      }
    }

    const allInfraPassed = infraChecks.every(c => c.status === "pass");
    const overallStatus: HealthCheckStatus = yesterdayPassed && allInfraPassed ? "pass" : "fail";

    return { checkedDate: yesterday, checkedAt, status: overallStatus, rawChecks, checks: [...infraChecks, ...pipelineChecks] };
  }

  async validate(date: string): Promise<HealthCheckValidation> {
    const checkedAt = DateTime.utc().toISO()!;
    const base = { checkedDate: date, checkedAt };

    // DNS validation — run before pipeline checks so we can surface infrastructure issues
    const dnsChecks = await this.checkPlatformDns();
    const delegationChecks = await this.checkDelegation();
    const sesChecks = await this.checkSesIdentity();
    const infraChecks = [...dnsChecks, ...delegationChecks, ...sesChecks];

    // Fetch threads for just this single day (use a 2-day window to cover edge cases)
    const sinceDate = DateTime.fromISO(date).minus({ days: 1 }).toFormat("yyyy-MM-dd");
    let threads: Array<{ id: string; createdAt: string; workflow: string }>;
    try {
      const result = await this.deps.threadDb.listActiveThreadsSince(SYSTEM_ACCOUNT_ID, sinceDate);
      if (result.isErr()) {
        this.deps.logger.error("Healthcheck validation query failed — could not list SYSTEM threads.", {
          code: "healthcheck.validation_error",
          date,
          error: result.error,
        });
        return { ...base, status: "unknown", rawChecks: null, checks: [...infraChecks, ...this.errorChecks("Validation query failed — could not list threads.")] };
      }
      threads = result.value;
    } catch (e) {
      this.deps.logger.error("Healthcheck validation threw unexpected error.", {
        code: "healthcheck.validation_error",
        date,
        error: e,
      });
      return { ...base, status: "unknown", rawChecks: null, checks: [...infraChecks, ...this.errorChecks("Validation threw an unexpected error.")] };
    }

    const dayResult = await this.validateDay(date, threads);
    const allInfraPassed = infraChecks.every(c => c.status === "pass");
    const status: HealthCheckStatus = dayResult.status === "pass" && allInfraPassed ? "pass" : dayResult.status === "unknown" ? "unknown" : "fail";

    return { ...base, status, rawChecks: dayResult.rawChecks, checks: [...infraChecks, ...dayResult.checks] };
  }

  private async validateDay(date: string, threads: Array<{ id: string; createdAt: string; workflow: string }>): Promise<{ status: HealthCheckStatus; rawChecks: ValidationChecks | null; checks: HealthCheckItem[] }> {
    const createdOnDay = threads.filter((t) => t.createdAt.slice(0, 10) === date);
    const thread = createdOnDay.find((t) => t.workflow === "healthcheck") ?? createdOnDay[0];

    if (!thread) {
      this.deps.logger.error(`Healthcheck thread not found for ${date}.`, {
        code: "healthcheck.thread_not_found",
        date,
      });
      return {
        status: "fail",
        rawChecks: null,
        checks: [
          { id: "thread-created", label: CHECK_LABELS.threadCreated, status: "fail", detail: `[${date}] No healthcheck thread was created.`, section: "pipeline" as const },
          { id: "workflow-classified", label: CHECK_LABELS.workflowClassified, status: "unknown", detail: `[${date}]`, section: "pipeline" as const },
          { id: "embedding-indexed", label: CHECK_LABELS.embeddingIndexed, status: "unknown", detail: `[${date}]`, section: "pipeline" as const },
        ],
      };
    }

    const checks: ValidationChecks = {
      hasThreadId: true,
      workflowIsHealthcheck: thread.workflow === "healthcheck",
      hasEmbedding: false,
    };

    let embeddingDetail = `[${date}] No embedding found in the search index for this thread.`;

    try {
      const embeddingResult = await this.deps.searchDatabase.hasEmbedding(thread.id);
      if (embeddingResult.isOk()) {
        checks.hasEmbedding = embeddingResult.value;
      } else if (embeddingResult.error.schemaMismatch) {
        embeddingDetail = `[${date}] Aurora schema mismatch — migrations behind code: ${embeddingResult.error.message}.`;
        this.deps.logger.error("Healthcheck embedding check failed — Aurora schema mismatch.", {
          code: "healthcheck.embedding_check_schema_mismatch",
          date,
          threadId: thread.id,
          error: embeddingResult.error.cause,
          message: embeddingResult.error.message,
        });
      } else {
        this.deps.logger.error("Aurora error during embedding existence check.", {
          code: "healthcheck.embedding_check_error",
          date,
          threadId: thread.id,
          error: embeddingResult.error.cause,
          message: embeddingResult.error.message,
        });
      }
    } catch (e) {
      this.deps.logger.error("Aurora connectivity/timeout error during embedding existence check.", {
        code: "healthcheck.embedding_check_error",
        date,
        threadId: thread.id,
        error: e,
      });
    }

    const allPassed = checks.workflowIsHealthcheck && checks.hasEmbedding;

    if (allPassed) {
      this.deps.logger.info(`Healthcheck validation passed — ${date}.`, {
        code: "healthcheck.validation_passed",
        date,
        threadId: thread.id,
        checks,
      });
    } else {
      this.deps.logger.error(`Healthcheck validation failed for ${date}.`, {
        code: "healthcheck.validation_failed",
        date,
        threadId: thread.id,
        checks,
        threadState: { id: thread.id, workflow: thread.workflow, createdAt: thread.createdAt },
      });
    }

    return {
      status: allPassed ? "pass" : "fail",
      rawChecks: checks,
      checks: [
        { id: "thread-created", label: CHECK_LABELS.threadCreated, status: "pass", detail: `[${date}]`, section: "pipeline" as const },
        {
          id: "workflow-classified",
          label: CHECK_LABELS.workflowClassified,
          status: checks.workflowIsHealthcheck ? "pass" : "fail",
          detail: checks.workflowIsHealthcheck ? `[${date}]` : `[${date}] Classified as "${thread.workflow}" instead of "healthcheck".`,
          section: "pipeline" as const,
        },
        {
          id: "embedding-indexed",
          label: CHECK_LABELS.embeddingIndexed,
          status: checks.hasEmbedding ? "pass" : "fail",
          detail: checks.hasEmbedding ? `[${date}]` : embeddingDetail,
          section: "pipeline" as const,
        },
      ],
    };
  }

  private async checkPlatformDns(): Promise<HealthCheckItem[]> {
    const domain = this.deps.mailDomain;
    const checks: HealthCheckItem[] = [];

    // MX — platform domain must have at least one MX record for inbound delivery
    try {
      const mx = await dns.resolveMx(domain);
      checks.push({
        id: "dns-mx",
        label: `MX record: ${domain}`,
        status: mx.length > 0 ? "pass" : "fail",
        section: "terminus",
        ...(mx.length === 0 ? { detail: "No MX records found — inbound mail cannot be delivered." } : {}),
      });
    } catch {
      checks.push({ id: "dns-mx", label: `MX record: ${domain}`, status: "fail", section: "terminus", detail: "DNS resolution failed — no MX record found." });
    }

    // DKIM TXT — must contain v=DKIM1
    const dkimName = `mail._domainkey.${domain}`;
    try {
      const txt = await dns.resolveTxt(dkimName);
      const joined = txt.map((parts) => parts.join("")).join("");
      const hasDkim = joined.startsWith("v=DKIM1");
      checks.push({
        id: "dns-dkim",
        label: `DKIM TXT: ${dkimName}`,
        status: hasDkim ? "pass" : "fail",
        section: "terminus",
        ...(!hasDkim ? { detail: `TXT record exists but does not start with "v=DKIM1".` } : {}),
      });
    } catch {
      checks.push({ id: "dns-dkim", label: `DKIM TXT: ${dkimName}`, status: "fail", section: "terminus", detail: "No TXT record found." });
    }

    // Bounce SPF — bounce subdomain must have SPF
    const bounceName = `bounce.${domain}`;
    try {
      const txt = await dns.resolveTxt(bounceName);
      const joined = txt.map((parts) => parts.join("")).join("");
      const hasSpf = joined.includes("spf1");
      checks.push({
        id: "dns-bounce-spf",
        label: `SPF TXT: ${bounceName}`,
        status: hasSpf ? "pass" : "fail",
        section: "terminus",
        ...(!hasSpf ? { detail: `TXT record exists but does not contain "spf1".` } : {}),
      });
    } catch {
      checks.push({ id: "dns-bounce-spf", label: `SPF TXT: ${bounceName}`, status: "fail", section: "terminus", detail: "No TXT record found." });
    }

    // DMARC
    const dmarcName = `_dmarc.${domain}`;
    try {
      const txt = await dns.resolveTxt(dmarcName);
      const joined = txt.map((parts) => parts.join("")).join("");
      const hasDmarc = joined.startsWith("v=DMARC1");
      checks.push({
        id: "dns-dmarc",
        label: `DMARC TXT: ${dmarcName}`,
        status: hasDmarc ? "pass" : "fail",
        section: "terminus",
        ...(!hasDmarc ? { detail: `TXT record exists but does not start with "v=DMARC1".` } : {}),
      });
    } catch {
      checks.push({ id: "dns-dmarc", label: `DMARC TXT: ${dmarcName}`, status: "fail", section: "terminus", detail: "No TXT record found." });
    }

    return checks;
  }

  private async checkSesIdentity(): Promise<HealthCheckItem[]> {
    const domain = this.deps.mailDomain;
    try {
      const result = await this.deps.sesChecker.canSendFrom(domain);
      const checks: HealthCheckItem[] = [
        {
          id: "ses-identity-verified",
          label: `SES identity verified: ${domain}`,
          status: result.verified ? "pass" : "fail",
          section: "ses",
          ...(!result.verified ? { detail: result.detail ?? `Domain "${domain}" is not verified in SES.` } : {}),
        },
        {
          id: "ses-dkim",
          label: `SES DKIM signing: ${domain}`,
          status: result.dkimEnabled ? "pass" : "fail",
          section: "ses",
          ...(!result.dkimEnabled ? { detail: result.detail ?? `DKIM signing is not enabled for "${domain}".` } : {}),
        },
        {
          id: "ses-sending-enabled",
          label: `SES account sending enabled`,
          status: result.accountSendingEnabled ? "pass" : "fail",
          section: "ses",
          ...(!result.accountSendingEnabled ? { detail: result.detail ?? `Account-level sending is disabled in SES.` } : {}),
        },
      ];
      return checks;
    } catch (e) {
      this.deps.logger.error("SES identity check threw unexpected error.", {
        code: "healthcheck.ses_check_error",
        domain,
        error: e,
      });
      return [{ id: "ses-error", label: "SES identity validation", status: "unknown" as HealthCheckStatus, section: "ses" as const, detail: "SES identity check failed unexpectedly." }];
    }
  }

  private async checkDelegation(): Promise<HealthCheckItem[]> {
    const healthcheckDomain: Domain = {
      accountId: SYSTEM_ACCOUNT_ID,
      domain: `healthcheck.${this.deps.mailDomain}`,
      receivingSetupComplete: true,
      senderSetupComplete: true,
      receivingHealthy: true,
      senderHealthy: true,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    try {
      const records = await this.deps.dnsChecker.checkDomain(healthcheckDomain);
      return records.map(record => ({
        id: `delegation-${record.type.toLowerCase()}-${record.name.split(".")[0]}`,
        label: `Delegation ${record.type}: ${record.name}`,
        status: (record.status === "verified" ? "pass" : "fail") as HealthCheckStatus,
        section: "delegation" as const,
        ...(record.status !== "verified" ? {
          detail: record.currentValue
            ? `Expected "${record.value}", got "${record.currentValue}"`
            : `No ${record.type} record found at ${record.name}`,
        } : {}),
      }));
    } catch (e) {
      this.deps.logger.error("DNS delegation check threw unexpected error.", {
        code: "healthcheck.delegation_check_error",
        error: e,
      });
      return [{ id: "delegation-error", label: "DNS delegation check", status: "unknown" as HealthCheckStatus, section: "delegation" as const, detail: "Delegation check failed unexpectedly." }];
    }
  }

  private errorChecks(detail: string): HealthCheckItem[] {
    return [
      { id: "thread-created", label: CHECK_LABELS.threadCreated, status: "unknown", section: "pipeline", detail },
      { id: "workflow-classified", label: CHECK_LABELS.workflowClassified, status: "unknown", section: "pipeline" },
      { id: "embedding-indexed", label: CHECK_LABELS.embeddingIndexed, status: "unknown", section: "pipeline" },
    ];
  }
}
