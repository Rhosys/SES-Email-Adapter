import { describe, it, expect } from "vitest";
import { buildRunCompleteLogEntry } from "./staleness-logic.js";
import type { AccountStalenessReport } from "./staleness-logic.js";

describe("Run-complete log entry structure", () => {
  const cases = [
    {
      label: "empty report list",
      reports: [] as AccountStalenessReport[],
      durationMs: 150,
      timestamp: "2024-06-01T12:00:00.000Z",
    },
    {
      label: "single account report",
      reports: [{ accountId: "acc_001", outstandingArcCount: 3, oldestArcLastSignalAt: "2024-03-01T00:00:00.000Z" }],
      durationMs: 500,
      timestamp: "2024-06-01T12:00:00.000Z",
    },
    {
      label: "multiple account reports — totals sum correctly",
      reports: [
        { accountId: "acc_001", outstandingArcCount: 5, oldestArcLastSignalAt: "2024-02-01T00:00:00.000Z" },
        { accountId: "acc_002", outstandingArcCount: 12, oldestArcLastSignalAt: "2024-01-15T00:00:00.000Z" },
        { accountId: "acc_003", outstandingArcCount: 1, oldestArcLastSignalAt: "2024-04-01T00:00:00.000Z" },
      ],
      durationMs: 2500,
      timestamp: "2024-06-15T08:30:00.000Z",
    },
  ];

  it.each(cases)("$label", ({ reports, durationMs, timestamp }) => {
    const result = buildRunCompleteLogEntry(reports, durationMs, timestamp);
    const expectedTotalArcs = reports.reduce((sum, r) => sum + r.outstandingArcCount, 0);

    expect(result).toEqual({
      level: "info",
      message: "staleness_checker.run_complete",
      accountsWithOutstandingArcs: reports.length,
      totalOutstandingArcs: expectedTotalArcs,
      durationMs,
      timestamp,
    });

    const keys = Object.keys(result as object);
    expect(keys).toHaveLength(6);
  });
});
