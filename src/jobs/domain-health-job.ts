import { DateTime } from "luxon";
import { AccountDatabase } from "../database/account-database.js";
import { ThreadDatabase } from "../database/thread-database.js";
import { checkDomain } from "../dns/dns-checker.js";
import { isOutstandingThread, buildAccountLogEntry, buildAccountReports, buildRunCompleteLogEntry } from "./staleness-logic.js";
import type { AccountStalenessReport } from "./staleness-logic.js";
import { computeSnapshot, isSnapshotRow, isDiffRow, monthFromSnapshotSk, dateFromDiffSk, buildSnapshotSk } from "../database/stats-writer.js";
import type { StatsMetric } from "../database/stats-writer.js";
import type { Logger } from "../logger.js";

export class DomainHealthJob {
  constructor(
    private readonly db: AccountDatabase,
    private readonly threadDb: ThreadDatabase,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    const startTime = Date.now();

    const accountsResult = await this.db.scanAllDomains();
    if (accountsResult.isErr()) {
      this.logger.track("Failed to fetch account list for domain health check run. The DynamoDB scan of all domains returned an error. No domains will be checked in this invocation. [Action Required] Investigate DynamoDB table health.", {
        code: "domain_health.accounts_fetch_failed",
        error: accountsResult.error,
      });
      return;
    }

    const allAccounts = accountsResult.value;
    const reports: AccountStalenessReport[] = [];

    for (const { accountId, domains } of allAccounts) {
      const accountResult = await this.db.getAccount(accountId);
      if (accountResult.isErr()) {
        this.logger.track("Failed to fetch account details during domain health check. The DynamoDB get for the account record returned an error. This account's domains will be skipped. [Action Required] Check DynamoDB read capacity.", {
          code: "domain_health.account_fetch_failed",
          accountId,
          error: accountResult.error,
        });
        continue;
      }

      for (const domain of domains) {
        const records = await checkDomain(domain);
        const now = DateTime.utc().toISO()!;
        const failingRecords = records.filter((r) => r.status === "failing").map((r) => r.name);
        const receivingHealthy = records.find((r) => r.type === "MX")?.status === "verified";
        const senderHealthy = records.filter((r) => r.type !== "MX").every((r) => r.status === "verified");
        const allHealthy = failingRecords.length === 0;

        const updateResult = await this.db.updateDomainHealth(accountId, domain.domain, {
          receivingHealthy,
          senderHealthy,
          failingRecords,
          lastCheckedAt: now,
          ...(allHealthy ? { lastHealthyAt: now } : {}),
        });
        if (updateResult.isErr()) {
          this.logger.track("Failed to persist domain health check results. The DynamoDB update for the domain record returned an error. Health status won't be reflected in the UI until the next successful check. [Action Required] Check DynamoDB write capacity.", {
            code: "domain_health.update_health_failed",
            accountId,
            domainId: domain.domain,
            error: updateResult.error,
          });
          continue;
        }

        if (!allHealthy) {
          this.logger.track(`[Action Required] Domain has failing DNS records. Account owner needs to be notified. domain=${domain.domain}, accountId=${accountId}`, {
            code: "domain_health.dns_alert_needed",
            accountId,
            domain: domain.domain,
            failingRecords,
          });
        }
      }

      // Staleness check: identify outstanding threads for this account
      const cutoffDate = DateTime.utc().minus({ days: 7 }).toISO()!;
      const staleThreadsResult = await this.threadDb.listActiveThreadsBefore(accountId, cutoffDate);
      if (staleThreadsResult.isErr()) {
        this.logger.track("Failed to query stale threads for account during staleness check. The DynamoDB query returned an error. This account's staleness report will be skipped. [Action Required] Check DynamoDB read capacity.", {
          code: "staleness_checker.account_error",
          accountId,
          error: staleThreadsResult.error,
        });
        continue;
      }

      const staleThreads = staleThreadsResult.value;
      const outstanding = staleThreads.filter(thread => isOutstandingThread(thread, cutoffDate));
      if (outstanding.length >= 10) {
        const [report] = buildAccountReports(outstanding.map(thread => ({
          id: thread.id,
          accountId: thread.accountId,
          lastSignalAt: thread.lastSignalAt,
          urgency: thread.urgency,
          workflow: thread.workflow,
        })));
        reports.push(report!);
        const logEntry = buildAccountLogEntry(report!, DateTime.utc().toISO()!);
        // buildAccountLogEntry returns { level: "track", message, ...context }
        const { level: _level, message, timestamp: _ts, ...context } = logEntry as Record<string, unknown>;
        this.logger.track(message as string, context);
      }

      // Stats snapshot generation: create current month's snapshot if missing
      await this.ensureStatsSnapshot(accountId);
    }

    const durationMs = Date.now() - startTime;
    const runCompleteEntry = buildRunCompleteLogEntry(reports, durationMs, DateTime.utc().toISO()!);
    // buildRunCompleteLogEntry returns { level: "info", message, ...context }
    const { level: _level, message, timestamp: _ts, ...context } = runCompleteEntry as Record<string, unknown>;
    this.logger.info(message as string, context);
  }

  /**
   * Ensure the current month's stats snapshot exists for the given account.
   *
   * Logic:
   * 1. Fetch all STATS# rows (ascending, limit 400 — covers recent history)
   * 2. Check if current month snapshot already exists → skip if so
   * 3. Find the latest previous snapshot (if any)
   * 4. Sum that snapshot + all diffs between the snapshot month and end of previous month
   * 5. Write the new snapshot for the current month
   */
  private async ensureStatsSnapshot(accountId: string): Promise<void> {
    const now = DateTime.utc();
    const currentMonth = now.toFormat("yyyy-MM");
    const previousMonth = now.minus({ months: 1 }).toFormat("yyyy-MM");
    const currentMonthSnapshotSk = buildSnapshotSk(currentMonth);
    // Only fetch rows from previous month's snapshot position onward
    const fromSk = buildSnapshotSk(previousMonth);

    const statsResult = await this.db.getStats(accountId, fromSk);
    if (statsResult.isErr()) {
      this.logger.warn("Failed to fetch stats rows for snapshot generation.", {
        code: "domain_health.stats_snapshot_fetch_failed",
        accountId,
        error: statsResult.error,
      });
      return;
    }

    const rows = statsResult.value;

    // Check if current month snapshot already exists
    if (rows.some(r => r.sk === currentMonthSnapshotSk)) return;

    // Find the latest previous snapshot and collect diffs before current month
    let latestSnapshot: Record<StatsMetric, number> | null = null;
    let snapshotMonth: string | null = null;
    const diffsBeforeCurrentMonth: Array<Partial<Record<StatsMetric, number>>> = [];

    for (const row of rows) {
      if (isSnapshotRow(row)) {
        latestSnapshot = row.metrics;
        snapshotMonth = monthFromSnapshotSk(row.sk);
      } else if (isDiffRow(row)) {
        const diffDate = dateFromDiffSk(row.sk);
        const diffMonth = diffDate.slice(0, 7);
        // Include diffs from the snapshot month onward, up to but NOT including current month
        if (diffMonth < currentMonth) {
          if (!snapshotMonth || diffMonth >= snapshotMonth) {
            diffsBeforeCurrentMonth.push(row.metrics);
          }
        }
      }
    }

    // Compute the new snapshot: previous snapshot + all diffs through end of last month
    const newMetrics = computeSnapshot(latestSnapshot, diffsBeforeCurrentMonth);

    const writeResult = await this.db.writeSnapshot(accountId, currentMonth, newMetrics);
    if (writeResult.isErr()) {
      this.logger.warn("Failed to write stats snapshot.", {
        code: "domain_health.stats_snapshot_write_failed",
        accountId,
        currentMonth,
        error: writeResult.error,
      });
      return;
    }

    this.logger.info("Stats snapshot created.", {
      code: "domain_health.stats_snapshot_created",
      accountId,
      currentMonth,
      metrics: newMetrics,
    });
  }
}
