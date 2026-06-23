// ---------------------------------------------------------------------------
// Stats Writer — row-per-day diff design with monthly snapshots
// ---------------------------------------------------------------------------

import { DateTime } from "luxon";
import type { SignalStatus } from "../types/index.js";

// ---------------------------------------------------------------------------
// Metric Registry — all tracked metrics. New metrics are added here.
// If a metric is missing from a snapshot, it defaults to zero.
// ---------------------------------------------------------------------------

export const STATS_METRICS = ["allowed", "blocked", "quarantined", "violationReport", "totalAliases"] as const;
export type StatsMetric = (typeof STATS_METRICS)[number];

// ---------------------------------------------------------------------------
// Status → Metric mapping (signal processing)
// ---------------------------------------------------------------------------

const STATUS_TO_METRIC: Record<Exclude<SignalStatus, "draft" | "pending_send" | "sent">, StatsMetric> = {
  active: "allowed",
  block_hidden: "blocked",
  block_reject: "blocked",
  report_violation: "violationReport",
  quarantine_visible: "quarantined",
  quarantine_hidden: "quarantined",
};

export function statusToMetric(status: SignalStatus): StatsMetric | null {
  if (status === "draft" || status === "pending_send" || status === "sent") return null;
  return STATUS_TO_METRIC[status];
}

/** @deprecated Use statusToMetric — kept for backward compat during migration */
export const statusToCategory = statusToMetric;

// ---------------------------------------------------------------------------
// DynamoDB row types
// ---------------------------------------------------------------------------

/** A daily diff row: `sk = STATS#YYYY-MM-DD` */
export interface StatsDiffRow {
  pk: string;
  sk: string;
  /** Diff values for each metric that changed this day */
  metrics: Partial<Record<StatsMetric, number>>;
  /** DynamoDB TTL — epoch seconds, 5 years from creation */
  ttl: number;
}

/** A monthly snapshot row: `sk = STATS#YYYY-MM-DD-SNAPSHOT` where DD is always 00 */
export interface StatsSnapshotRow {
  pk: string;
  sk: string;
  /** Cumulative totals through end of previous month */
  metrics: Record<StatsMetric, number>;
}

export type StatsRow = StatsDiffRow | StatsSnapshotRow;

// ---------------------------------------------------------------------------
// SK helpers
// ---------------------------------------------------------------------------

export function buildDiffSk(date: string): string {
  return `STATS#${date}`;
}

export function buildSnapshotSk(yearMonth: string): string {
  return `STATS#${yearMonth}-00-SNAPSHOT`;
}

export function isDiffRow(row: StatsRow): row is StatsDiffRow {
  return !row.sk.endsWith("-SNAPSHOT");
}

export function isSnapshotRow(row: StatsRow): row is StatsSnapshotRow {
  return row.sk.endsWith("-SNAPSHOT");
}

/** Extract the date string from a diff SK: `STATS#2026-06-15` → `2026-06-15` */
export function dateFromDiffSk(sk: string): string {
  return sk.slice(6); // "STATS#".length = 6
}

/** Extract the year-month from a snapshot SK: `STATS#2026-06-00-SNAPSHOT` → `2026-06` */
export function monthFromSnapshotSk(sk: string): string {
  return sk.slice(6, 13); // "STATS#YYYY-MM"
}

// ---------------------------------------------------------------------------
// Build DynamoDB params for diff row writes (three-level conditional strategy)
// ---------------------------------------------------------------------------

export interface DiffKey {
  TableName: string;
  Key: { pk: string; sk: string };
}

export interface DiffUpdateParams extends DiffKey {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
  ConditionExpression: string;
}

export interface DiffPutParams extends DiffKey {
  Item: Record<string, unknown>;
  ConditionExpression: string;
}

/**
 * Step 1: UpdateItem with condition that the row already exists.
 * ADD increments the metric on the existing nested map.
 */
export function buildDiffUpdateParams(
  accountId: string,
  metric: StatsMetric,
  delta: number,
  now: DateTime,
  tableName: string,
): DiffUpdateParams {
  const today = now.toISODate()!;

  return {
    TableName: tableName,
    Key: { pk: `ACCT#${accountId}`, sk: buildDiffSk(today) },
    UpdateExpression: "ADD #metric :delta",
    ExpressionAttributeNames: {
      "#metric": `metrics.${metric}`,
    },
    ExpressionAttributeValues: {
      ":delta": delta,
    },
    ConditionExpression: "attribute_exists(pk)",
  };
}

/**
 * Step 2: PutItem to create the row (first signal of the day).
 * Condition: row must NOT exist (another Lambda might have created it concurrently).
 */
export function buildDiffPutParams(
  accountId: string,
  metric: StatsMetric,
  delta: number,
  now: DateTime,
  tableName: string,
): DiffPutParams {
  const today = now.toISODate()!;
  const fiveYearsFromNow = now.plus({ years: 5 }).toUnixInteger();

  return {
    TableName: tableName,
    Key: { pk: `ACCT#${accountId}`, sk: buildDiffSk(today) },
    Item: {
      pk: `ACCT#${accountId}`,
      sk: buildDiffSk(today),
      metrics: { [metric]: delta },
      ttl: fiveYearsFromNow,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  };
}

// ---------------------------------------------------------------------------
// Snapshot computation — sums a base snapshot (or zeros) + all diffs
// ---------------------------------------------------------------------------

export function emptyMetrics(): Record<StatsMetric, number> {
  const m: Record<string, number> = {};
  for (const metric of STATS_METRICS) {
    m[metric] = 0;
  }
  return m as Record<StatsMetric, number>;
}

/**
 * Compute a new snapshot by applying diffs to a base.
 * If baseSnapshot is null, starts from all zeros.
 * Diffs are applied in chronological order (ascending SK).
 */
export function computeSnapshot(
  baseSnapshot: Record<StatsMetric, number> | null,
  diffs: Array<Partial<Record<StatsMetric, number>>>,
): Record<StatsMetric, number> {
  const result = baseSnapshot ? { ...baseSnapshot } : emptyMetrics();

  // Ensure all current metrics exist (handles metrics added after the snapshot was created)
  for (const metric of STATS_METRICS) {
    if (!(metric in result)) {
      (result as Record<string, number>)[metric] = 0;
    }
  }

  for (const diff of diffs) {
    for (const metric of STATS_METRICS) {
      if (metric in diff) {
        result[metric] += diff[metric]!;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// API response types — matches the site's expected contract
// ---------------------------------------------------------------------------

export interface ApiStatsTotals {
  allowed: number;
  quarantined: number;
  blocked: number;
  totalAliases: number;
}

export interface ApiStatsDailyBucket {
  date: string;
  allowed: number;
  quarantined: number;
  blocked: number;
}

export interface ApiStatsResponse {
  totals: ApiStatsTotals;
  daily: ApiStatsDailyBucket[];
  monthly: ApiStatsDailyBucket[];
}

// ---------------------------------------------------------------------------
// Aggregate raw stats rows into the API response shape
// ---------------------------------------------------------------------------

/**
 * Given a set of stats rows (snapshots + diffs) sorted ascending by SK,
 * produces the API response with totals, daily breakdowns, and monthly rollups.
 *
 * The rows should span at least the last 365 days of diffs.
 * The latest snapshot (if any) provides the base for totals computation.
 */
export function aggregateStatsRows(rows: StatsRow[]): ApiStatsResponse {
  // Defensive sort: correctness depends on ascending SK order.
  // DDB query returns ascending when ScanIndexForward=true, but we don't trust callers.
  const sorted = [...rows].sort((a, b) => a.sk.localeCompare(b.sk));

  // Find the latest snapshot (rows are ascending by SK, snapshot sorts before same-month diffs)
  let latestSnapshot: Record<StatsMetric, number> | null = null;
  let snapshotMonth: string | null = null;
  const diffs: Array<{ date: string; metrics: Partial<Record<StatsMetric, number>> }> = [];

  for (const row of sorted) {
    if (isSnapshotRow(row)) {
      latestSnapshot = row.metrics;
      snapshotMonth = monthFromSnapshotSk(row.sk);
    } else {
      diffs.push({ date: dateFromDiffSk(row.sk), metrics: row.metrics });
    }
  }

  // Compute totals: snapshot + all diffs after the snapshot
  // If no snapshot exists, sum all diffs from zero
  const diffsAfterSnapshot = snapshotMonth
    ? diffs.filter(d => d.date.slice(0, 7) >= snapshotMonth!)
    : diffs;

  const totals = computeSnapshot(latestSnapshot, diffsAfterSnapshot.map(d => d.metrics));

  // Build daily breakdown (all diffs, regardless of snapshot)
  const daily: ApiStatsDailyBucket[] = diffs.map(d => ({
    date: d.date,
    allowed: d.metrics.allowed ?? 0,
    quarantined: d.metrics.quarantined ?? 0,
    blocked: d.metrics.blocked ?? 0,
  })).sort((a, b) => b.date.localeCompare(a.date)); // descending

  // Build monthly rollups from diffs
  const monthlyMap = new Map<string, { allowed: number; quarantined: number; blocked: number }>();
  for (const d of diffs) {
    const month = d.date.slice(0, 7);
    const existing = monthlyMap.get(month) ?? { allowed: 0, quarantined: 0, blocked: 0 };
    existing.allowed += d.metrics.allowed ?? 0;
    existing.quarantined += d.metrics.quarantined ?? 0;
    existing.blocked += d.metrics.blocked ?? 0;
    monthlyMap.set(month, existing);
  }

  const monthly: ApiStatsDailyBucket[] = [...monthlyMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, counts]) => ({ date: month, ...counts }));

  return {
    totals: {
      allowed: totals.allowed,
      quarantined: totals.quarantined,
      blocked: totals.blocked,
      totalAliases: totals.totalAliases,
    },
    daily,
    monthly,
  };
}
