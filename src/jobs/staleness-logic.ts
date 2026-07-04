import type { Thread, ThreadUrgency, Workflow } from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutstandingThread {
  id: string;
  accountId: string;
  lastSignalAt: string;
  urgency: ThreadUrgency | undefined;
  workflow: Workflow;
}

export interface AccountStalenessReport {
  accountId: string;
  outstandingThreadCount: number;
  oldestThreadLastSignalAt: string;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Determine if a thread qualifies as outstanding.
 * A thread is outstanding when ALL of:
 * 1. status === "active"
 * 2. urgency !== "silent" (undefined treated as "normal")
 * 3. lastSignalAt < cutoffDate
 */
export function isOutstandingThread(thread: Thread, cutoffDate: string): boolean {
  if (thread.status !== "active") return false;
  if (thread.urgency === "silent") return false;
  if (thread.lastSignalAt >= cutoffDate) return false;
  return true;
}

/** Group outstanding threads by accountId and compute per-account report. */
export function buildAccountReports(threads: OutstandingThread[]): AccountStalenessReport[] {
  const grouped = new Map<string, OutstandingThread[]>();
  for (const thread of threads) {
    const existing = grouped.get(thread.accountId);
    if (existing) {
      existing.push(thread);
    } else {
      grouped.set(thread.accountId, [thread]);
    }
  }

  const reports: AccountStalenessReport[] = [];
  for (const [accountId, accountThreads] of grouped) {
    let oldest = accountThreads[0]!.lastSignalAt;
    for (let i = 1; i < accountThreads.length; i++) {
      if (accountThreads[i]!.lastSignalAt < oldest) {
        oldest = accountThreads[i]!.lastSignalAt;
      }
    }
    reports.push({
      accountId,
      outstandingThreadCount: accountThreads.length,
      oldestThreadLastSignalAt: oldest,
    });
  }

  return reports;
}

/** Build the TRACK-level log entry for an account with outstanding threads. */
export function buildAccountLogEntry(report: AccountStalenessReport, timestamp: string): object {
  return {
    level: "track",
    message: "staleness_checker.outstanding_threads",
    accountId: report.accountId,
    outstandingThreadCount: report.outstandingThreadCount,
    oldestThreadLastSignalAt: report.oldestThreadLastSignalAt,
    timestamp,
  };
}

/** Build the INFO-level run-complete log entry. */
export function buildRunCompleteLogEntry(
  reports: AccountStalenessReport[],
  durationMs: number,
  timestamp: string,
): object {
  let totalOutstandingThreads = 0;
  for (const report of reports) {
    totalOutstandingThreads += report.outstandingThreadCount;
  }

  return {
    level: "info",
    message: "staleness_checker.run_complete",
    accountsWithOutstandingThreads: reports.length,
    totalOutstandingThreads,
    durationMs,
    timestamp,
  };
}
