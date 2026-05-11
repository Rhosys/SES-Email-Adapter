import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "../testing/property-runner.js";
import { isOutstandingArc, buildAccountLogEntry, type AccountStalenessReport } from "./staleness-logic.js";
import type { Arc, ArcStatus, ArcUrgency, Workflow } from "../types/index.js";
import { WORKFLOWS } from "../types/index.js";

// ---------------------------------------------------------------------------
// Property 1: Outstanding arc classification
// **Validates: Requirements 1.1, 1.2, 1.3**
// ---------------------------------------------------------------------------

/**
 * For any arc with any combination of status, urgency (including undefined),
 * workflow, and lastSignalAt, isOutstandingArc(arc, cutoff) returns true if
 * and only if:
 *   1. status === "active"
 *   2. urgency !== "silent" (undefined treated as "normal")
 *   3. lastSignalAt < cutoff
 * The workflow field has no effect on the result.
 */

const ARC_STATUSES: ArcStatus[] = ["active", "archived", "deleted"];
const ARC_URGENCIES: (ArcUrgency | undefined)[] = ["critical", "high", "normal", "low", "silent", undefined];

const arbArcStatus: fc.Arbitrary<ArcStatus> = fc.constantFrom(...ARC_STATUSES);
const arbArcUrgency: fc.Arbitrary<ArcUrgency | undefined> = fc.constantFrom(...ARC_URGENCIES);
const arbWorkflow: fc.Arbitrary<Workflow> = fc.constantFrom(...WORKFLOWS);

// Generate ISO timestamps in a reasonable range using integer milliseconds
const arbIsoTimestamp: fc.Arbitrary<string> = fc.integer({
  min: new Date("2020-01-01T00:00:00.000Z").getTime(),
  max: new Date("2030-12-31T23:59:59.999Z").getTime(),
}).map((ms) => new Date(ms).toISOString());

// Build a minimal Arc with the fields that matter for isOutstandingArc
function buildArc(status: ArcStatus, urgency: ArcUrgency | undefined, workflow: Workflow, lastSignalAt: string): Arc {
  return {
    id: "arc_test",
    accountId: "acc_test",
    workflow,
    labels: [],
    status,
    summary: "test arc",
    lastSignalAt,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...(urgency !== undefined ? { urgency } : {}),
  };
}

describe("Property 1: Outstanding arc classification", () => {
  it("isOutstandingArc returns true iff status=active AND urgency!==silent AND lastSignalAt < cutoff", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbArcStatus,
        arbArcUrgency,
        arbWorkflow,
        arbIsoTimestamp,
        arbIsoTimestamp,
        async (status, urgency, workflow, lastSignalAt, cutoffDate) => {
          const arc = buildArc(status, urgency, workflow, lastSignalAt);
          const result = isOutstandingArc(arc, cutoffDate);

          const isActive = status === "active";
          const isNotSilent = urgency !== "silent";
          const isOlderThanCutoff = lastSignalAt < cutoffDate;

          const expected = isActive && isNotSilent && isOlderThanCutoff;
          expect(result).toBe(expected);
        },
      ),
    );
  });

  it("workflow has no effect on the result", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbArcStatus,
        arbArcUrgency,
        arbWorkflow,
        arbWorkflow,
        arbIsoTimestamp,
        arbIsoTimestamp,
        async (status, urgency, workflow1, workflow2, lastSignalAt, cutoffDate) => {
          const arc1 = buildArc(status, urgency, workflow1, lastSignalAt);
          const arc2 = buildArc(status, urgency, workflow2, lastSignalAt);

          expect(isOutstandingArc(arc1, cutoffDate)).toBe(isOutstandingArc(arc2, cutoffDate));
        },
      ),
    );
  });

  it("undefined urgency is treated as normal (not silent) — arc can be outstanding", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbWorkflow,
        arbIsoTimestamp,
        arbIsoTimestamp,
        async (workflow, lastSignalAt, cutoffDate) => {
          const arcUndefined = buildArc("active", undefined, workflow, lastSignalAt);
          const arcNormal = buildArc("active", "normal", workflow, lastSignalAt);

          // Both should produce the same result since undefined is treated as "normal"
          expect(isOutstandingArc(arcUndefined, cutoffDate)).toBe(isOutstandingArc(arcNormal, cutoffDate));
        },
      ),
    );
  });
});


// ---------------------------------------------------------------------------
// Property 3: TRACK log entry structure
// **Validates: Requirements 2.1**
// ---------------------------------------------------------------------------

/**
 * For any valid AccountStalenessReport and timestamp, buildAccountLogEntry
 * produces an object containing exactly: level: "track",
 * message: "staleness_checker.outstanding_arcs", the report's accountId,
 * outstandingArcCount, oldestArcLastSignalAt, and the provided timestamp.
 */

/** Generates a valid AccountStalenessReport. */
const arbAccountStalenessReport: fc.Arbitrary<AccountStalenessReport> = fc.record({
  accountId: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes("\n")),
  outstandingArcCount: fc.integer({ min: 1, max: 10000 }),
  oldestArcLastSignalAt: arbIsoTimestamp,
});

describe("Property 3: TRACK log entry structure", () => {
  it("buildAccountLogEntry output contains exactly the required fields with correct values", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbAccountStalenessReport, arbIsoTimestamp, async (report, timestamp) => {
        const result = buildAccountLogEntry(report, timestamp) as Record<string, unknown>;

        // Assert output contains exactly 6 fields (no more, no less)
        const keys = Object.keys(result);
        expect(keys).toHaveLength(6);

        // Assert exact field names present
        expect(keys.sort()).toEqual(
          ["accountId", "level", "message", "oldestArcLastSignalAt", "outstandingArcCount", "timestamp"].sort(),
        );

        // Assert fixed values
        expect(result.level).toBe("track");
        expect(result.message).toBe("staleness_checker.outstanding_arcs");

        // Assert report values are passed through
        expect(result.accountId).toBe(report.accountId);
        expect(result.outstandingArcCount).toBe(report.outstandingArcCount);
        expect(result.oldestArcLastSignalAt).toBe(report.oldestArcLastSignalAt);

        // Assert timestamp is passed through
        expect(result.timestamp).toBe(timestamp);
      }),
    );
  });
});
