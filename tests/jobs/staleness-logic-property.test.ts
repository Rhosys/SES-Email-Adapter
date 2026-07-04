import { describe, it, expect } from "vitest";
import { buildRunCompleteLogEntry } from "../../src/jobs/staleness-logic.js";
import type { AccountStalenessReport } from "../../src/jobs/staleness-logic.js";

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
      reports: [{ accountId: "acc_001", outstandingThreadCount: 3, oldestThreadLastSignalAt: "2024-03-01T00:00:00.000Z" }],
      durationMs: 500,
      timestamp: "2024-06-01T12:00:00.000Z",
    },
    {
      label: "multiple account reports — totals sum correctly",
      reports: [
        { accountId: "acc_001", outstandingThreadCount: 5, oldestThreadLastSignalAt: "2024-02-01T00:00:00.000Z" },
        { accountId: "acc_002", outstandingThreadCount: 12, oldestThreadLastSignalAt: "2024-01-15T00:00:00.000Z" },
        { accountId: "acc_003", outstandingThreadCount: 1, oldestThreadLastSignalAt: "2024-04-01T00:00:00.000Z" },
      ],
      durationMs: 2500,
      timestamp: "2024-06-15T08:30:00.000Z",
    },
  ];

  it.each(cases)("$label", ({ reports, durationMs, timestamp }) => {
    const result = buildRunCompleteLogEntry(reports, durationMs, timestamp);
    const expectedTotalThreads = reports.reduce((sum, r) => sum + r.outstandingThreadCount, 0);

    expect(result).toEqual({
      level: "info",
      message: "staleness_checker.run_complete",
      accountsWithOutstandingThreads: reports.length,
      totalOutstandingThreads: expectedTotalThreads,
      durationMs,
      timestamp,
    });

    const keys = Object.keys(result as object);
    expect(keys).toHaveLength(6);
  });
});
