import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  statusToMetric,
  buildDiffUpdateParams,
  buildDiffPutParams,
  buildDiffSk,
  buildSnapshotSk,
  isDiffRow,
  isSnapshotRow,
  dateFromDiffSk,
  monthFromSnapshotSk,
  computeSnapshot,
  emptyMetrics,
  aggregateStatsRows,
  STATS_METRICS,
} from "../../src/database/stats-writer.js";
import type { StatsMetric, StatsDiffRow, StatsSnapshotRow, StatsRow } from "../../src/database/stats-writer.js";

// ---------------------------------------------------------------------------
// statusToMetric
// ---------------------------------------------------------------------------

describe("statusToMetric", () => {
  it.each([
    { status: "active", expected: "allowed" },
    { status: "block_hidden", expected: "blocked" },
    { status: "block_reject", expected: "blocked" },
    { status: "report_violation", expected: "reported" },
    { status: "quarantine_visible", expected: "quarantined" },
    { status: "quarantine_hidden", expected: "quarantined" },
  ] as const)("maps $status → $expected", ({ status, expected }) => {
    expect(statusToMetric(status)).toBe(expected);
  });

  it.each(["draft", "pending_send", "sent"] as const)("returns null for %s", (status) => {
    expect(statusToMetric(status)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SK helpers
// ---------------------------------------------------------------------------

describe("buildDiffSk", () => {
  it("produces STATS#YYYY-MM-DD format", () => {
    expect(buildDiffSk("2026-06-15")).toBe("STATS#2026-06-15");
  });
});

describe("buildSnapshotSk", () => {
  it("produces STATS#YYYY-MM-00-SNAPSHOT format", () => {
    expect(buildSnapshotSk("2026-06")).toBe("STATS#2026-06-00-SNAPSHOT");
  });
});

describe("isDiffRow / isSnapshotRow", () => {
  const diff: StatsDiffRow = { pk: "ACCT#x", sk: "STATS#2026-06-15", metrics: { allowed: 1 }, ttl: 123 };
  const snap: StatsSnapshotRow = { pk: "ACCT#x", sk: "STATS#2026-06-00-SNAPSHOT", metrics: emptyMetrics() };

  it("isDiffRow returns true for diff, false for snapshot", () => {
    expect(isDiffRow(diff)).toBe(true);
    expect(isDiffRow(snap)).toBe(false);
  });

  it("isSnapshotRow returns true for snapshot, false for diff", () => {
    expect(isSnapshotRow(snap)).toBe(true);
    expect(isSnapshotRow(diff)).toBe(false);
  });
});

describe("dateFromDiffSk", () => {
  it("extracts the date from a diff SK", () => {
    expect(dateFromDiffSk("STATS#2026-06-15")).toBe("2026-06-15");
  });
});

describe("monthFromSnapshotSk", () => {
  it("extracts year-month from a snapshot SK", () => {
    expect(monthFromSnapshotSk("STATS#2026-06-00-SNAPSHOT")).toBe("2026-06");
  });
});

// ---------------------------------------------------------------------------
// buildDiffUpdateParams
// ---------------------------------------------------------------------------

describe("buildDiffUpdateParams", () => {
  const now = DateTime.fromISO("2026-06-15T10:00:00.000Z", { zone: "utc" });
  const accountId = "acc-test";
  const tableName = "ses-accounts";

  it("produces correct Key with today's date", () => {
    const params = buildDiffUpdateParams(accountId, "allowed", 1, now, tableName);
    expect(params.Key).toEqual({ pk: "ACCT#acc-test", sk: "STATS#2026-06-15" });
    expect(params.TableName).toBe(tableName);
  });

  it("ADD expression targets the correct metric path", () => {
    const params = buildDiffUpdateParams(accountId, "blocked", 1, now, tableName);
    expect(params.UpdateExpression).toBe("ADD #metrics.#metricName :delta");
    expect(params.ExpressionAttributeNames["#metrics"]).toBe("metrics");
    expect(params.ExpressionAttributeNames["#metricName"]).toBe("blocked");
  });

  it("supports negative delta for decrements", () => {
    const params = buildDiffUpdateParams(accountId, "totalAliases", -1, now, tableName);
    expect(params.ExpressionAttributeValues[":delta"]).toBe(-1);
    expect(params.ExpressionAttributeNames["#metricName"]).toBe("totalAliases");
  });

  it("includes attribute_exists condition (row must exist)", () => {
    const params = buildDiffUpdateParams(accountId, "allowed", 1, now, tableName);
    expect(params.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it("each metric produces a distinct attribute name", () => {
    for (const metric of STATS_METRICS) {
      const params = buildDiffUpdateParams(accountId, metric, 1, now, tableName);
      expect(params.ExpressionAttributeNames["#metricName"]).toBe(metric);
    }
  });
});

// ---------------------------------------------------------------------------
// buildDiffPutParams
// ---------------------------------------------------------------------------

describe("buildDiffPutParams", () => {
  const now = DateTime.fromISO("2026-06-15T10:00:00.000Z", { zone: "utc" });
  const accountId = "acc-test";
  const tableName = "ses-accounts";

  it("produces Item with pk, sk, metrics map, and ttl", () => {
    const params = buildDiffPutParams(accountId, "allowed", 1, now, tableName);
    expect(params.Item.pk).toBe("ACCT#acc-test");
    expect(params.Item.sk).toBe("STATS#2026-06-15");
    expect(params.Item.metrics).toEqual({ allowed: 1 });
  });

  it("TTL is 5 years from now", () => {
    const params = buildDiffPutParams(accountId, "allowed", 1, now, tableName);
    const expectedTtl = now.plus({ years: 5 }).toUnixInteger();
    expect(params.Item.ttl).toBe(expectedTtl);
  });

  it("includes attribute_not_exists condition (row must NOT exist)", () => {
    const params = buildDiffPutParams(accountId, "allowed", 1, now, tableName);
    expect(params.ConditionExpression).toBe("attribute_not_exists(pk)");
  });

  it("supports negative delta in the initial metrics map", () => {
    const params = buildDiffPutParams(accountId, "totalAliases", -1, now, tableName);
    expect(params.Item.metrics).toEqual({ totalAliases: -1 });
  });

  it("only includes the single metric being incremented", () => {
    const params = buildDiffPutParams(accountId, "blocked", 3, now, tableName);
    expect(params.Item.metrics).toEqual({ blocked: 3 });
    expect(Object.keys(params.Item.metrics as object)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// emptyMetrics
// ---------------------------------------------------------------------------

describe("emptyMetrics", () => {
  it("returns zero for every registered metric", () => {
    const m = emptyMetrics();
    for (const metric of STATS_METRICS) {
      expect(m[metric]).toBe(0);
    }
  });

  it("has exactly STATS_METRICS.length keys", () => {
    expect(Object.keys(emptyMetrics())).toHaveLength(STATS_METRICS.length);
  });
});

// ---------------------------------------------------------------------------
// computeSnapshot
// ---------------------------------------------------------------------------

describe("computeSnapshot", () => {
  it("null base → starts from zero, applies diffs", () => {
    const result = computeSnapshot(null, [
      { allowed: 5, blocked: 2 },
      { allowed: 3, quarantined: 1 },
    ]);
    expect(result.allowed).toBe(8);
    expect(result.blocked).toBe(2);
    expect(result.quarantined).toBe(1);
    expect(result.reported).toBe(0);
    expect(result.totalAliases).toBe(0);
  });

  it("applies diffs to an existing base snapshot", () => {
    const base: Record<StatsMetric, number> = { allowed: 100, blocked: 20, quarantined: 5, reported: 1, totalAliases: 10 };
    const result = computeSnapshot(base, [
      { allowed: 10, totalAliases: 2 },
      { blocked: 3, totalAliases: -1 },
    ]);
    expect(result.allowed).toBe(110);
    expect(result.blocked).toBe(23);
    expect(result.quarantined).toBe(5);
    expect(result.totalAliases).toBe(11);
  });

  it("handles negative diffs correctly (metrics can go negative)", () => {
    const base: Record<StatsMetric, number> = { allowed: 2, blocked: 0, quarantined: 0, reported: 0, totalAliases: 3 };
    const result = computeSnapshot(base, [{ totalAliases: -5 }]);
    expect(result.totalAliases).toBe(-2);
  });

  it("empty diffs array returns the base unchanged (plus any missing metrics zeroed)", () => {
    const base: Record<StatsMetric, number> = { allowed: 50, blocked: 10, quarantined: 3, reported: 0, totalAliases: 7 };
    const result = computeSnapshot(base, []);
    expect(result).toEqual(base);
  });

  it("handles a base snapshot missing a metric (future-proofing)", () => {
    // Simulate an old snapshot that doesn't have totalAliases
    const oldBase = { allowed: 50, blocked: 10, quarantined: 3, reported: 0 } as unknown as Record<StatsMetric, number>;
    const result = computeSnapshot(oldBase, [{ totalAliases: 5 }]);
    expect(result.totalAliases).toBe(5);
    expect(result.allowed).toBe(50);
  });

  it("null base with empty diffs returns all zeros", () => {
    const result = computeSnapshot(null, []);
    expect(result).toEqual(emptyMetrics());
  });

  it("multiple diffs for same metric accumulate", () => {
    const result = computeSnapshot(null, [
      { allowed: 1 },
      { allowed: 1 },
      { allowed: 1 },
      { allowed: 1 },
      { allowed: 1 },
    ]);
    expect(result.allowed).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// aggregateStatsRows
// ---------------------------------------------------------------------------

describe("aggregateStatsRows", () => {
  function makeDiff(date: string, metrics: Partial<Record<StatsMetric, number>>): StatsDiffRow {
    return { pk: "ACCT#x", sk: buildDiffSk(date), metrics, ttl: 9999999999 };
  }

  function makeSnapshot(yearMonth: string, metrics: Record<StatsMetric, number>): StatsSnapshotRow {
    return { pk: "ACCT#x", sk: buildSnapshotSk(yearMonth), metrics };
  }

  it("empty rows → zeroed response", () => {
    const result = aggregateStatsRows([]);
    expect(result.totals).toEqual({ allowed: 0, quarantined: 0, blocked: 0, aliases: 0 });
    expect(result.daily).toEqual([]);
    expect(result.monthly).toEqual([]);
  });

  it("diffs only (no snapshot) — totals = sum of all diffs", () => {
    const rows: StatsRow[] = [
      makeDiff("2026-06-14", { allowed: 3, blocked: 1 }),
      makeDiff("2026-06-15", { allowed: 5, quarantined: 2, totalAliases: 1 }),
    ];
    const result = aggregateStatsRows(rows);
    expect(result.totals).toEqual({ allowed: 8, quarantined: 2, blocked: 1, aliases: 1 });
  });

  it("snapshot + diffs — totals = snapshot + diffs from snapshot month onward", () => {
    const rows: StatsRow[] = [
      // May snapshot (cumulative through April)
      makeSnapshot("2026-05", { allowed: 100, blocked: 20, quarantined: 5, reported: 1, totalAliases: 10 }),
      // May diffs (same month as snapshot — included in totals)
      makeDiff("2026-05-01", { allowed: 10 }),
      makeDiff("2026-05-15", { allowed: 5, blocked: 2 }),
      // June diffs
      makeDiff("2026-06-01", { allowed: 3, totalAliases: 1 }),
    ];
    const result = aggregateStatsRows(rows);
    // totals = snapshot(100,20,5,_,10) + may diffs(15,2,0,_,0) + june diffs(3,0,0,_,1)
    expect(result.totals).toEqual({ allowed: 118, blocked: 22, quarantined: 5, aliases: 11 });
  });

  it("daily breakdown is descending by date", () => {
    const rows: StatsRow[] = [
      makeDiff("2026-06-13", { allowed: 1 }),
      makeDiff("2026-06-14", { allowed: 2 }),
      makeDiff("2026-06-15", { allowed: 3 }),
    ];
    const result = aggregateStatsRows(rows);
    expect(result.daily).toHaveLength(3);
    expect(result.daily[0]!.date).toBe("2026-06-15");
    expect(result.daily[1]!.date).toBe("2026-06-14");
    expect(result.daily[2]!.date).toBe("2026-06-13");
  });

  it("daily buckets default missing metrics to 0", () => {
    const rows: StatsRow[] = [
      makeDiff("2026-06-15", { allowed: 5 }),
    ];
    const result = aggregateStatsRows(rows);
    expect(result.daily[0]).toEqual({ date: "2026-06-15", allowed: 5, quarantined: 0, blocked: 0, aliases: 0 });
  });

  it("monthly rollup sums all diffs within the same month", () => {
    const rows: StatsRow[] = [
      makeDiff("2026-05-10", { allowed: 3, blocked: 1 }),
      makeDiff("2026-05-20", { allowed: 7, quarantined: 2 }),
      makeDiff("2026-06-01", { allowed: 1 }),
    ];
    const result = aggregateStatsRows(rows);
    expect(result.monthly).toHaveLength(2);
    // Descending order
    expect(result.monthly[0]).toEqual({ date: "2026-06", allowed: 1, quarantined: 0, blocked: 0, aliases: 0 });
    expect(result.monthly[1]).toEqual({ date: "2026-05", allowed: 10, quarantined: 2, blocked: 1, aliases: 0 });
  });

  it("snapshot is not included in daily or monthly breakdown", () => {
    const rows: StatsRow[] = [
      makeSnapshot("2026-06", { allowed: 100, blocked: 20, quarantined: 5, reported: 1, totalAliases: 10 }),
      makeDiff("2026-06-15", { allowed: 3 }),
    ];
    const result = aggregateStatsRows(rows);
    // Only the diff appears in daily/monthly
    expect(result.daily).toHaveLength(1);
    expect(result.monthly).toHaveLength(1);
  });

  it("multiple snapshots — uses the latest one", () => {
    const rows: StatsRow[] = [
      makeSnapshot("2026-04", { allowed: 50, blocked: 10, quarantined: 2, reported: 0, totalAliases: 5 }),
      makeDiff("2026-04-15", { allowed: 10 }),
      makeSnapshot("2026-05", { allowed: 80, blocked: 15, quarantined: 3, reported: 0, totalAliases: 7 }),
      makeDiff("2026-05-10", { allowed: 5 }),
      makeDiff("2026-06-01", { allowed: 2 }),
    ];
    const result = aggregateStatsRows(rows);
    // totals = latest snapshot(80,15,3,_,7) + diffs from 2026-05 onward(5+2, 0, 0, _, 0)
    expect(result.totals).toEqual({ allowed: 87, blocked: 15, quarantined: 3, aliases: 7 });
    // daily includes ALL diffs (even those before latest snapshot — they're historical display data)
    expect(result.daily).toHaveLength(3);
  });

  it("diffs before the snapshot month are excluded from totals but included in daily/monthly", () => {
    const rows: StatsRow[] = [
      makeDiff("2026-04-20", { allowed: 50 }),
      makeSnapshot("2026-05", { allowed: 200, blocked: 30, quarantined: 10, reported: 2, totalAliases: 12 }),
      makeDiff("2026-05-05", { allowed: 8 }),
    ];
    const result = aggregateStatsRows(rows);
    // totals = snapshot + diffs from 2026-05 onward only
    expect(result.totals.allowed).toBe(208);
    // daily includes the April diff for chart display
    expect(result.daily).toHaveLength(2);
    expect(result.daily.find(d => d.date === "2026-04-20")!.allowed).toBe(50);
  });

  it("handles negative diff values in totals", () => {
    const rows: StatsRow[] = [
      makeSnapshot("2026-06", { allowed: 100, blocked: 20, quarantined: 5, reported: 0, totalAliases: 10 }),
      makeDiff("2026-06-10", { totalAliases: -3 }),
      makeDiff("2026-06-11", { totalAliases: 1 }),
    ];
    const result = aggregateStatsRows(rows);
    expect(result.totals.aliases).toBe(8);
  });

  it("handles a snapshot missing a newer metric (future-proofing)", () => {
    // Old snapshot doesn't know about totalAliases
    const oldSnap: StatsSnapshotRow = {
      pk: "ACCT#x",
      sk: buildSnapshotSk("2026-05"),
      metrics: { allowed: 100, blocked: 20, quarantined: 5, reported: 1 } as unknown as Record<StatsMetric, number>,
    };
    const rows: StatsRow[] = [
      oldSnap,
      makeDiff("2026-05-10", { totalAliases: 3, allowed: 2 }),
    ];
    const result = aggregateStatsRows(rows);
    expect(result.totals.aliases).toBe(3);
    expect(result.totals.allowed).toBe(102);
  });

  it("large dataset — 365 daily diffs produce 365 daily entries and ~12 monthly entries", () => {
    const base = DateTime.fromISO("2025-06-24", { zone: "utc" });
    const rows: StatsRow[] = [];
    for (let i = 0; i < 365; i++) {
      const date = base.plus({ days: i }).toISODate()!;
      rows.push(makeDiff(date, { allowed: 1, blocked: 0, quarantined: 0 }));
    }
    const result = aggregateStatsRows(rows);
    expect(result.daily).toHaveLength(365);
    expect(result.totals.allowed).toBe(365);
    // ~12 months between June 2025 and June 2026
    expect(result.monthly.length).toBeGreaterThanOrEqual(12);
    expect(result.monthly.length).toBeLessThanOrEqual(13);
  });

  it("single diff row — totals, daily, and monthly all reflect it", () => {
    const rows: StatsRow[] = [
      makeDiff("2026-06-15", { allowed: 7, blocked: 2, quarantined: 1 }),
    ];
    const result = aggregateStatsRows(rows);
    expect(result.totals).toEqual({ allowed: 7, quarantined: 1, blocked: 2, aliases: 0 });
    expect(result.daily).toEqual([{ date: "2026-06-15", allowed: 7, quarantined: 1, blocked: 2, aliases: 0 }]);
    expect(result.monthly).toEqual([{ date: "2026-06", allowed: 7, quarantined: 1, blocked: 2, aliases: 0 }]);
  });

  it("reported is tracked in totals but not exposed in daily/monthly buckets", () => {
    const rows: StatsRow[] = [
      makeDiff("2026-06-15", { reported: 3, allowed: 1 }),
    ];
    const result = aggregateStatsRows(rows);
    // reported contributes to internal computation but API totals don't expose it
    expect(result.daily[0]).toEqual({ date: "2026-06-15", allowed: 1, quarantined: 0, blocked: 0, aliases: 0 });
    // totals only include allowed, quarantined, blocked, totalAliases
    expect("reported" in result.totals).toBe(false);
  });

  it("rows passed in descending order produce identical results to ascending (defensive sort)", () => {
    const ascending: StatsRow[] = [
      makeSnapshot("2026-05", { allowed: 80, blocked: 15, quarantined: 3, reported: 0, totalAliases: 7 }),
      makeDiff("2026-05-10", { allowed: 5, totalAliases: 1 }),
      makeDiff("2026-06-01", { allowed: 2, blocked: 1 }),
      makeDiff("2026-06-15", { allowed: 3 }),
    ];
    const descending = [...ascending].reverse();

    const resultAsc = aggregateStatsRows(ascending);
    const resultDesc = aggregateStatsRows(descending);

    expect(resultAsc.totals).toEqual(resultDesc.totals);
    expect(resultAsc.daily).toEqual(resultDesc.daily);
    expect(resultAsc.monthly).toEqual(resultDesc.monthly);
  });

  it("rows in random order still produce correct totals", () => {
    const rows: StatsRow[] = [
      makeDiff("2026-06-15", { allowed: 3 }),
      makeSnapshot("2026-05", { allowed: 80, blocked: 15, quarantined: 3, reported: 0, totalAliases: 7 }),
      makeDiff("2026-05-10", { allowed: 5 }),
      makeDiff("2026-06-01", { allowed: 2 }),
    ];
    const result = aggregateStatsRows(rows);
    // snapshot(80,15,3,_,7) + diffs from 2026-05 onward (5+2+3, 0, 0, _, 0)
    expect(result.totals).toEqual({ allowed: 90, blocked: 15, quarantined: 3, aliases: 7 });
  });
});
