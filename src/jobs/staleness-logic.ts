import type { Arc, ArcUrgency, Workflow } from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutstandingArc {
  id: string;
  accountId: string;
  lastSignalAt: string;
  urgency: ArcUrgency | undefined;
  workflow: Workflow;
}

export interface AccountStalenessReport {
  accountId: string;
  outstandingArcCount: number;
  oldestArcLastSignalAt: string;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Determine if an arc qualifies as outstanding.
 * An arc is outstanding when ALL of:
 * 1. status === "active"
 * 2. urgency !== "silent" (undefined treated as "normal")
 * 3. lastSignalAt < cutoffDate
 */
export function isOutstandingArc(arc: Arc, cutoffDate: string): boolean {
  if (arc.status !== "active") return false;
  if (arc.urgency === "silent") return false;
  if (arc.lastSignalAt >= cutoffDate) return false;
  return true;
}

/** Group outstanding arcs by accountId and compute per-account report. */
export function buildAccountReports(arcs: OutstandingArc[]): AccountStalenessReport[] {
  const grouped = new Map<string, OutstandingArc[]>();
  for (const arc of arcs) {
    const existing = grouped.get(arc.accountId);
    if (existing) {
      existing.push(arc);
    } else {
      grouped.set(arc.accountId, [arc]);
    }
  }

  const reports: AccountStalenessReport[] = [];
  for (const [accountId, accountArcs] of grouped) {
    let oldest = accountArcs[0]!.lastSignalAt;
    for (let i = 1; i < accountArcs.length; i++) {
      if (accountArcs[i]!.lastSignalAt < oldest) {
        oldest = accountArcs[i]!.lastSignalAt;
      }
    }
    reports.push({
      accountId,
      outstandingArcCount: accountArcs.length,
      oldestArcLastSignalAt: oldest,
    });
  }

  return reports;
}

/** Build the TRACK-level log entry for an account with outstanding arcs. */
export function buildAccountLogEntry(report: AccountStalenessReport, timestamp: string): object {
  return {
    level: "track",
    message: "staleness_checker.outstanding_arcs",
    accountId: report.accountId,
    outstandingArcCount: report.outstandingArcCount,
    oldestArcLastSignalAt: report.oldestArcLastSignalAt,
    timestamp,
  };
}

/** Build the INFO-level run-complete log entry. */
export function buildRunCompleteLogEntry(
  reports: AccountStalenessReport[],
  durationMs: number,
  timestamp: string,
): object {
  let totalOutstandingArcs = 0;
  for (const report of reports) {
    totalOutstandingArcs += report.outstandingArcCount;
  }

  return {
    level: "info",
    message: "staleness_checker.run_complete",
    accountsWithOutstandingArcs: reports.length,
    totalOutstandingArcs,
    durationMs,
    timestamp,
  };
}
