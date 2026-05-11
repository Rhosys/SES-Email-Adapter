// Feature: user-engagement-tracking, Property 4: Run-complete log entry structure
// **Validates: Requirements 2.3**
//
// For any list of AccountStalenessReport values and any positive durationMs,
// buildRunCompleteLogEntry produces an object containing exactly: level: "info",
// message: "staleness_checker.run_complete", accountsWithOutstandingArcs equal to
// the list length, totalOutstandingArcs equal to the sum of all outstandingArcCount
// values, the provided durationMs, and the provided timestamp.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "../testing/property-runner.js";
import { buildRunCompleteLogEntry } from "./staleness-logic.js";
import type { AccountStalenessReport } from "./staleness-logic.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbAccountId = fc.stringMatching(/^acc_[a-z0-9]{4,12}$/);

const arbIsoTimestamp = fc.integer({
  min: new Date("2020-01-01T00:00:00.000Z").getTime(),
  max: new Date("2030-12-31T23:59:59.999Z").getTime(),
}).map(ms => new Date(ms).toISOString());

const arbAccountStalenessReport: fc.Arbitrary<AccountStalenessReport> = fc.record({
  accountId: arbAccountId,
  outstandingArcCount: fc.integer({ min: 1, max: 1000 }),
  oldestArcLastSignalAt: arbIsoTimestamp,
});

const arbReportList = fc.array(arbAccountStalenessReport, { minLength: 0, maxLength: 20 });

const arbPositiveDurationMs = fc.integer({ min: 1, max: 300_000 });

// ---------------------------------------------------------------------------
// Property 4: Run-complete log entry structure
// ---------------------------------------------------------------------------

describe("Property 4: Run-complete log entry structure", () => {
  it("buildRunCompleteLogEntry produces exactly the required fields with correct values", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbReportList,
        arbPositiveDurationMs,
        arbIsoTimestamp,
        async (reports, durationMs, timestamp) => {
          const result = buildRunCompleteLogEntry(reports, durationMs, timestamp);

          const expectedTotalArcs = reports.reduce((sum, r) => sum + r.outstandingArcCount, 0);

          // Assert exact field values
          expect(result).toEqual({
            level: "info",
            message: "staleness_checker.run_complete",
            accountsWithOutstandingArcs: reports.length,
            totalOutstandingArcs: expectedTotalArcs,
            durationMs,
            timestamp,
          });

          // Assert no extra fields (exactly 6 keys)
          const keys = Object.keys(result as object);
          expect(keys).toHaveLength(6);
          expect(new Set(keys)).toEqual(new Set([
            "level",
            "message",
            "accountsWithOutstandingArcs",
            "totalOutstandingArcs",
            "durationMs",
            "timestamp",
          ]));
        },
      ),
    );
  });
});
