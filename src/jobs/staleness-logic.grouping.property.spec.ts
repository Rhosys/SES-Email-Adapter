import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildAccountReports, type OutstandingArc } from "./staleness-logic.js";
import { propertyRunner } from "../testing/property-runner.js";
import type { Workflow } from "../types/index.js";
import type { ArcUrgency } from "../types/index.js";

// ---------------------------------------------------------------------------
// Property 2: Account report grouping correctness
// **Validates: Requirements 1.4, 3.5**
// ---------------------------------------------------------------------------

const WORKFLOWS: Workflow[] = [
  "auth", "conversation", "crm", "package", "travel", "scheduling",
  "payments", "alert", "content", "onboarding", "status", "healthcare",
  "job", "support", "test",
];

const NON_SILENT_URGENCIES: (ArcUrgency | undefined)[] = [
  "critical", "high", "normal", "low", undefined,
];

/** Generate a valid ISO timestamp between 2020 and 2025 */
const MIN_TS = new Date("2020-01-01T00:00:00.000Z").getTime();
const MAX_TS = new Date("2025-12-31T23:59:59.999Z").getTime();
const arbTimestamp = fc.integer({ min: MIN_TS, max: MAX_TS }).map((ms) => new Date(ms).toISOString());

/** Generate a valid OutstandingArc */
const arbOutstandingArc: fc.Arbitrary<OutstandingArc> = fc.record({
  id: fc.uuid(),
  accountId: fc.constantFrom("acct_001", "acct_002", "acct_003", "acct_004", "acct_005", "acct_006", "acct_007", "acct_008"),
  lastSignalAt: arbTimestamp,
  urgency: fc.constantFrom(...NON_SILENT_URGENCIES),
  workflow: fc.constantFrom(...WORKFLOWS),
});

/** Generate a non-empty list of OutstandingArcs */
const arbOutstandingArcs = fc.array(arbOutstandingArc, { minLength: 1, maxLength: 50 });

/**
 * Property 2: Account report grouping correctness
 *
 * For any non-empty list of outstanding arcs with varying accountId and lastSignalAt values,
 * buildAccountReports produces exactly one entry per unique accountId, where outstandingArcCount
 * equals the number of arcs for that account, and oldestArcLastSignalAt equals the minimum
 * lastSignalAt among that account's arcs.
 *
 * Validates: Requirements 1.4, 3.5
 */
describe("Property 2: Account report grouping correctness", () => {
  it("produces exactly one report per unique accountId", () => {
    return propertyRunner.assert(
      fc.property(arbOutstandingArcs, (arcs) => {
        const reports = buildAccountReports(arcs);
        const uniqueAccountIds = new Set(arcs.map((a) => a.accountId));
        expect(reports.length).toBe(uniqueAccountIds.size);

        const reportAccountIds = new Set(reports.map((r) => r.accountId));
        expect(reportAccountIds).toEqual(uniqueAccountIds);
      }),
    );
  });

  it("outstandingArcCount equals the number of arcs for that account", () => {
    return propertyRunner.assert(
      fc.property(arbOutstandingArcs, (arcs) => {
        const reports = buildAccountReports(arcs);

        for (const report of reports) {
          const accountArcs = arcs.filter((a) => a.accountId === report.accountId);
          expect(report.outstandingArcCount).toBe(accountArcs.length);
        }
      }),
    );
  });

  it("oldestArcLastSignalAt equals the minimum lastSignalAt for that account", () => {
    return propertyRunner.assert(
      fc.property(arbOutstandingArcs, (arcs) => {
        const reports = buildAccountReports(arcs);

        for (const report of reports) {
          const accountArcs = arcs.filter((a) => a.accountId === report.accountId);
          const minLastSignalAt = accountArcs
            .map((a) => a.lastSignalAt)
            .sort()[0]!;
          expect(report.oldestArcLastSignalAt).toBe(minLastSignalAt);
        }
      }),
    );
  });
});
