import dns from "node:dns/promises";
import { DateTime } from "luxon";
import type { Logger } from "../logger.js";
import type { Domain, DnsRecord } from "../types/index.js";
import { SYSTEM_ACCOUNT_ID } from "../database/system-account-db.js";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { ThreadDatabase } from "../database/thread-database.js";
import type { ThreadMatcher } from "../database/thread-matcher.js";
import type { SesIdentityChecker } from "../email/ses-identity-checker.js";

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
  /**
   * Diagnostic context when the healthcheck thread is not found. Contains the
   * top 10 SYSTEM threads (by createdAt, newest first) and the DDB query used
   * to find them. Present only on pipeline failure when thread is missing.
   */
  diagnostics?: HealthCheckDiagnostics;
}

export interface HealthCheckDiagnostics {
  /** Top 10 SYSTEM threads returned by the query, sorted by createdAt descending. */
  recentThreads: Array<{ id: string; createdAt: string; workflow: string; lastSignalAt?: string }>;
  /** The exact DynamoDB query (as JSON) used to look for healthcheck threads. */
  ddbQuery: Record<string, unknown>;
  /** S3 objects found in the emails/ prefix during the expected delivery window. */
  s3Objects?: Array<{ key: string; lastModified: string; size: number }>;
  /** CloudWatch Log Insights results for inbound processing of healthcheck emails. */
  logInsightsResults?: Array<Record<string, string>>;
  /** Signals found across all SYSTEM threads, grouped by date (yyyy-MM-dd). */
  signalsByDate?: Record<string, Array<{ id: string; createdAt: string }>>;
}

export interface ValidationChecks {
  hasThreadId: boolean;
  workflowIsHealthcheck: boolean;
  hasEmbedding: boolean;
}

export interface HealthcheckValidatorDeps {
  threadDb: ThreadDatabase;
  searchDatabase: ThreadMatcher;
  sesChecker: SesIdentityChecker;
  dnsChecker: { checkDomain(domain: Domain): Promise<DnsRecord[]> };
  mailDomain: string;
  emailBucket: string;
  logGroupName: string;
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
    const today = now.toFormat("yyyy-MM-dd");

    // Infra checks are point-in-time — run once
    const dnsChecks = await this.checkPlatformDns();
    const delegationChecks = await this.checkDelegation();
    const sesChecks = await this.checkSesIdentity();
    const infraChecks = [...dnsChecks, ...delegationChecks, ...sesChecks];

    // Fetch active SYSTEM threads from the last 7 days (bounded query, single DDB call)
    const sinceDate = now.minus({ days: MAX_LOOKBACK_DAYS }).toFormat("yyyy-MM-dd");
    let threads: Array<{ id: string; createdAt: string; workflow: string; lastSignalAt?: string }>;
    try {
      const result = await this.deps.threadDb.listActiveThreadsSince(SYSTEM_ACCOUNT_ID, sinceDate);
      if (result.isErr()) {
        this.deps.logger.error("Healthcheck validation query failed — could not list SYSTEM threads.", {
          code: "healthcheck.validation_error",
          error: result.error,
        });
        return { checkedDate: today, checkedAt, status: "unknown", rawChecks: null, checks: [...infraChecks, ...this.errorChecks("Validation query failed — could not list threads.")] };
      }
      threads = result.value;
    } catch (e) {
      this.deps.logger.error("Healthcheck validation threw unexpected error.", {
        code: "healthcheck.validation_error",
        error: e,
      });
      return { checkedDate: today, checkedAt, status: "unknown", rawChecks: null, checks: [...infraChecks, ...this.errorChecks("Validation threw an unexpected error.")] };
    }

    // Fetch signals for all SYSTEM threads to validate by signal createdAt (not thread lastSignalAt)
    const allSignals = await this.fetchSignalsForThreads(threads);

    // Check day-by-day starting from today, going back up to MAX_LOOKBACK_DAYS.
    // Collect pipeline checks for each failed day (with date in detail). Stop on first success.
    const pipelineChecks: HealthCheckItem[] = [];
    let rawChecks: ValidationChecks | null = null;
    let diagnostics: HealthCheckDiagnostics | undefined;
    let todayOrYesterdayPassed = false;

    for (let daysBack = 0; daysBack <= MAX_LOOKBACK_DAYS; daysBack++) {
      const date = now.minus({ days: daysBack }).toFormat("yyyy-MM-dd");
      const dayResult = await this.validateDay(date, threads, { sinceDate }, allSignals);

      for (const check of dayResult.checks) {
        pipelineChecks.push(check);
      }
      rawChecks = dayResult.rawChecks;
      if (dayResult.diagnostics) diagnostics = dayResult.diagnostics;

      if (dayResult.status === "pass") {
        if (daysBack <= 1) todayOrYesterdayPassed = true;
        break;
      }
    }

    const allInfraPassed = infraChecks.every(c => c.status === "pass");
    const overallStatus: HealthCheckStatus = todayOrYesterdayPassed && allInfraPassed ? "pass" : "fail";

    // Always include all threads in diagnostics for observability
    if (!diagnostics) {
      diagnostics = {
        recentThreads: threads
          .slice()
          .sort((a, b) => (b.lastSignalAt ?? b.createdAt).localeCompare(a.lastSignalAt ?? a.createdAt))
          .slice(0, 10)
          .map(t => ({ id: t.id, createdAt: t.createdAt, workflow: t.workflow, ...(t.lastSignalAt ? { lastSignalAt: t.lastSignalAt } : {}) })),
        ddbQuery: {
          TableName: "signals",
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :pk AND gsi1sk >= :start",
          ExpressionAttributeValues: {
            ":pk": `ACCT#${SYSTEM_ACCOUNT_ID}`,
            ":start": `LASTACT#active#${sinceDate}`,
          },
          ScanIndexForward: false,
        },
      };
    }

    return { checkedDate: today, checkedAt, status: overallStatus, rawChecks, checks: [...infraChecks, ...pipelineChecks], ...(diagnostics ? { diagnostics } : {}) };
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
    let threads: Array<{ id: string; createdAt: string; workflow: string; lastSignalAt?: string }>;
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

    const dayResult = await this.validateDay(date, threads, { sinceDate });
    const allInfraPassed = infraChecks.every(c => c.status === "pass");
    const status: HealthCheckStatus = dayResult.status === "pass" && allInfraPassed ? "pass" : dayResult.status === "unknown" ? "unknown" : "fail";

    return { ...base, status, rawChecks: dayResult.rawChecks, checks: [...infraChecks, ...dayResult.checks], ...(dayResult.diagnostics ? { diagnostics: dayResult.diagnostics } : {}) };
  }

  private async validateDay(date: string, threads: Array<{ id: string; createdAt: string; workflow: string; lastSignalAt?: string }>, queryContext?: { sinceDate: string }, allSignals?: Map<string, Array<{ id: string; createdAt: string }>>): Promise<{ status: HealthCheckStatus; rawChecks: ValidationChecks | null; checks: HealthCheckItem[]; diagnostics?: HealthCheckDiagnostics }> {
    // Signal-based matching: find a signal created on the target date within any SYSTEM thread.
    // This is immune to the lastSignalAt-advancement problem where subsequent signals shift
    // the thread's lastSignalAt to a newer day, making older days invisible.
    let thread: { id: string; createdAt: string; workflow: string; lastSignalAt?: string } | undefined;

    if (allSignals) {
      for (const t of threads) {
        const signals = allSignals.get(t.id) ?? [];
        const hasSignalOnDay = signals.some(s => s.createdAt.slice(0, 10) === date);
        if (hasSignalOnDay) {
          thread = t;
          break;
        }
      }
    }

    // Fallback to the original thread-level matching if no signals map provided
    if (!thread) {
      const activeOnDay = threads.filter((t) => (t.lastSignalAt ?? t.createdAt).slice(0, 10) === date);
      const createdOnDay = threads.filter((t) => t.createdAt.slice(0, 10) === date);
      const candidatePool = activeOnDay.length > 0 ? activeOnDay : createdOnDay;
      thread = candidatePool.find((t) => t.workflow === "healthcheck") ?? candidatePool[0];
    }

    if (!thread) {
      this.deps.logger.error(`Healthcheck thread not found for ${date}.`, {
        code: "healthcheck.thread_not_found",
        date,
        allThreads: threads.map(t => ({ id: t.id, createdAt: t.createdAt, workflow: t.workflow, ...(t.lastSignalAt ? { lastSignalAt: t.lastSignalAt } : {}) })),
      });

      // Automated delivery diagnostics — check S3 and CloudWatch for evidence of the
      // healthcheck email arriving (or not) at the inbound pipeline.
      const deliveryDiagnostics = await this.checkDeliveryEvidence(date);

      const sinceDate = queryContext?.sinceDate ?? date;

      // Build signalsByDate from allSignals for diagnostics
      const signalsByDate: Record<string, Array<{ id: string; createdAt: string }>> = {};
      if (allSignals) {
        for (const signals of allSignals.values()) {
          for (const s of signals) {
            const day = s.createdAt.slice(0, 10);
            if (!signalsByDate[day]) signalsByDate[day] = [];
            signalsByDate[day].push({ id: s.id, createdAt: s.createdAt });
          }
        }
      }

      const diagnostics: HealthCheckDiagnostics = {
        recentThreads: threads
          .slice()
          .sort((a, b) => (b.lastSignalAt ?? b.createdAt).localeCompare(a.lastSignalAt ?? a.createdAt))
          .slice(0, 10)
          .map(t => ({ id: t.id, createdAt: t.createdAt, workflow: t.workflow, ...(t.lastSignalAt ? { lastSignalAt: t.lastSignalAt } : {}) })),
        ddbQuery: {
          TableName: "signals",
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :pk AND gsi1sk >= :start",
          ExpressionAttributeValues: {
            ":pk": `ACCT#${SYSTEM_ACCOUNT_ID}`,
            ":start": `LASTACT#active#${sinceDate}`,
          },
          ScanIndexForward: false,
        },
        ...(Object.keys(signalsByDate).length > 0 ? { signalsByDate } : {}),
        ...(deliveryDiagnostics.s3Objects ? { s3Objects: deliveryDiagnostics.s3Objects } : {}),
        ...(deliveryDiagnostics.logInsightsResults ? { logInsightsResults: deliveryDiagnostics.logInsightsResults } : {}),
      };

      return {
        status: "fail",
        rawChecks: null,
        diagnostics,
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

  private async fetchSignalsForThreads(threads: Array<{ id: string }>): Promise<Map<string, Array<{ id: string; createdAt: string }>>> {
    const result = new Map<string, Array<{ id: string; createdAt: string }>>();
    for (const thread of threads) {
      const signalsResult = await this.deps.threadDb.listSignals(SYSTEM_ACCOUNT_ID, thread.id, { limit: 30 });
      if (signalsResult.isOk()) {
        result.set(thread.id, signalsResult.value.items.map(s => ({ id: s.id, createdAt: s.createdAt })));
      }
    }
    return result;
  }

  private async checkDeliveryEvidence(date: string): Promise<{ s3Objects?: Array<{ key: string; lastModified: string; size: number }>; logInsightsResults?: Array<Record<string, string>> }> {
    // The healthcheck email is sent at 06:00 UTC on `date`. SES delivers it within seconds
    // back to the inbound endpoint, so look from 05:55 to 06:30 UTC on `date`.
    const windowStart = DateTime.fromISO(date, { zone: "utc" }).set({ hour: 5, minute: 55 });
    const windowEnd = DateTime.fromISO(date, { zone: "utc" }).set({ hour: 6, minute: 30 });

    const result: { s3Objects?: Array<{ key: string; lastModified: string; size: number }>; logInsightsResults?: Array<Record<string, string>> } = {};

    // 1. Check S3 for objects written during the delivery window
    try {
      const s3 = new S3Client({});
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: this.deps.emailBucket,
        Prefix: "emails/",
        // S3 doesn't support time-range filtering natively — list recent objects
        // and filter by LastModified. Use MaxKeys to cap cost.
        MaxKeys: 100,
      }));

      const objects = (listResult.Contents ?? [])
        .filter(obj => {
          if (!obj.LastModified) return false;
          const modified = DateTime.fromJSDate(obj.LastModified, { zone: "utc" });
          return modified >= windowStart && modified <= windowEnd;
        })
        .map(obj => ({
          key: obj.Key ?? "",
          lastModified: obj.LastModified?.toISOString() ?? "",
          size: obj.Size ?? 0,
        }));

      if (objects.length > 0) {
        result.s3Objects = objects;
        this.deps.logger.info("S3 delivery evidence found — healthcheck email was stored by SES inbound.", {
          code: "healthcheck.s3_evidence_found",
          date,
          objectCount: objects.length,
          objects,
        });
      } else {
        this.deps.logger.error("No S3 objects found in delivery window — SES inbound never stored the healthcheck email.", {
          code: "healthcheck.s3_evidence_missing",
          date,
          bucket: this.deps.emailBucket,
          prefix: "emails/",
          windowStart: windowStart.toISO(),
          windowEnd: windowEnd.toISO(),
        });
      }
    } catch (e) {
      this.deps.logger.warn("S3 delivery evidence check failed.", { code: "healthcheck.s3_check_error", date, error: e });
    }

    // 2. Check CloudWatch Logs for inbound processing of healthcheck emails
    try {
      const cwl = new CloudWatchLogsClient({});
      const query = `fields @timestamp, @message
        | filter @message like "healthcheck" or @message like "no_account_for_recipient"
        | sort @timestamp desc
        | limit 20`;

      const startQuery = await cwl.send(new StartQueryCommand({
        logGroupName: this.deps.logGroupName,
        startTime: Math.floor(windowStart.toSeconds()),
        endTime: Math.floor(windowEnd.toSeconds()),
        queryString: query,
      }));

      if (startQuery.queryId) {
        // Poll for results (Log Insights is async)
        let status = "Running";
        let queryRows: Array<Array<{ field?: string; value?: string }>> | undefined;
        for (let attempt = 0; attempt < 10 && status === "Running"; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const getResults = await cwl.send(new GetQueryResultsCommand({ queryId: startQuery.queryId }));
          status = getResults.status ?? "Complete";
          queryRows = (getResults.results ?? []) as Array<Array<{ field?: string; value?: string }>>;
        }

        if (queryRows && queryRows.length > 0) {
          const formatted = queryRows.map(row => {
            const entry: Record<string, string> = {};
            for (const field of row) {
              if (field.field && field.value) entry[field.field] = field.value;
            }
            return entry;
          });
          result.logInsightsResults = formatted;
          this.deps.logger.info("CloudWatch log evidence found for healthcheck delivery window.", {
            code: "healthcheck.log_evidence_found",
            date,
            resultCount: formatted.length,
            results: formatted.slice(0, 5),
          });
        } else {
          this.deps.logger.error("No CloudWatch log entries found for healthcheck in delivery window — Lambda was never invoked for the healthcheck email.", {
            code: "healthcheck.log_evidence_missing",
            date,
            logGroupName: this.deps.logGroupName,
            windowStart: windowStart.toISO(),
            windowEnd: windowEnd.toISO(),
          });
        }
      }
    } catch (e) {
      this.deps.logger.warn("CloudWatch Logs delivery evidence check failed.", { code: "healthcheck.log_check_error", date, error: e });
    }

    return result;
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
