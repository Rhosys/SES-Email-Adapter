import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "../testing/property-runner.js";
import {
  getRetentionForPlan,
  type BillingPlan,
  type RetentionForPlan,
} from "./retention-tier.js";
import * as retentionTierModule from "./retention-tier.js";
import * as s3RetentionServiceModule from "./s3-retention-service.js";

// ---------------------------------------------------------------------------
// Property 19: Plan changes never retroactively retag
// **Validates: Requirements 8.7**
//
// The retention decision is computed once at signal creation time from the plan.
// If the plan changes later, existing signals are NOT re-tagged. This is
// enforced architecturally:
//   1. getRetentionForPlan is a pure function called once at creation
//   2. There is no "update retention" API that takes a signal ID
//   3. S3RetentionService.applyPlanRetention only operates on a single s3Key
// ---------------------------------------------------------------------------

/**
 * Arbitrary billing plan generator covering all 6 plan types.
 */
const arbBillingPlan: fc.Arbitrary<BillingPlan> = fc.oneof(
  fc.constant('Free' as BillingPlan),
  fc.constant('Beta' as BillingPlan),
  fc.constant('Paid' as BillingPlan),
  fc.constant('Lifetime' as BillingPlan),
  fc.constant('Premium' as BillingPlan),
  fc.constant('Internal' as BillingPlan),
);

describe("Property 19: Plan changes never retroactively retag", () => {
  // -------------------------------------------------------------------------
  // 1. getRetentionForPlan is pure (same plan → same result, always)
  // -------------------------------------------------------------------------
  describe("getRetentionForPlan is pure", () => {
    it("same plan always produces the same retention decision", () => {
      return propertyRunner.assert(
        fc.asyncProperty(arbBillingPlan, async (plan) => {
          const result1 = getRetentionForPlan(plan);
          const result2 = getRetentionForPlan(plan);

          // Structural equality: same plan → identical decision every time
          expect(result1).toEqual(result2);
        }),
      );
    });

    it("result is independent of call order — calling with plan B between two plan A calls does not change plan A's result", () => {
      return propertyRunner.assert(
        fc.asyncProperty(arbBillingPlan, arbBillingPlan, async (planA, planB) => {
          const beforeInterleave = getRetentionForPlan(planA);
          getRetentionForPlan(planB); // interleaved call with different plan
          const afterInterleave = getRetentionForPlan(planA);

          expect(beforeInterleave).toEqual(afterInterleave);
        }),
      );
    });

    it("result contains no mutable state — modifying the returned object does not affect subsequent calls", () => {
      return propertyRunner.assert(
        fc.asyncProperty(arbBillingPlan, async (plan) => {
          const result1 = getRetentionForPlan(plan);
          // Mutate the returned object
          (result1 as Record<string, unknown>).s3Tag = "MUTATED";
          (result1 as Record<string, unknown>).retentionDuration = "MUTATED";
          (result1 as Record<string, unknown>).copyToSaved = "MUTATED";

          // A fresh call should still return the correct, unmutated result
          const result2 = getRetentionForPlan(plan);
          expect(result2.s3Tag).not.toBe("MUTATED");
          expect(result2.retentionDuration).not.toBe("MUTATED");
          expect(result2.copyToSaved).not.toBe("MUTATED");
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. No exported function takes a signal ID and changes its retention
  // -------------------------------------------------------------------------
  describe("no exported 'update retention by signal ID' function exists", () => {
    it("retention-tier module exports no function accepting a signal ID to mutate retention", () => {
      const exportedFunctions = Object.entries(retentionTierModule)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => name);

      // None of the exported functions should accept a signal ID for mutation.
      const signalMutationPatterns = [
        /updateRetention/i,
        /changeRetention/i,
        /retagSignal/i,
        /setRetention/i,
        /modifyRetention/i,
        /updateSignalRetention/i,
      ];

      for (const fnName of exportedFunctions) {
        for (const pattern of signalMutationPatterns) {
          expect(fnName).not.toMatch(pattern);
        }
      }
    });

    it("s3-retention-service module exports no function that batch-retags signals by ID", () => {
      const exportedNames = Object.keys(s3RetentionServiceModule);

      const batchRetentionPatterns = [
        /batchRetag/i,
        /retagAll/i,
        /updateRetentionForAccount/i,
        /retroactiveRetag/i,
        /batchApply/i,
        /retagExisting/i,
      ];

      for (const name of exportedNames) {
        for (const pattern of batchRetentionPatterns) {
          expect(name).not.toMatch(pattern);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. S3RetentionService.applyPlanRetention only operates on the current
  //    s3Key (no batch/retroactive operations)
  // -------------------------------------------------------------------------
  describe("applyPlanRetention operates on a single s3Key only", () => {
    it("interface accepts exactly one s3Key — no array, no account-wide parameter", () => {
      // The S3RetentionService interface has a single method: applyPlanRetention(s3Key, input)
      const instance = new s3RetentionServiceModule.S3RetentionServiceImpl(
        undefined as any, // S3Client (not used in this structural test)
        "test-bucket",
      );

      // The method exists and is a function
      expect(typeof instance.applyPlanRetention).toBe("function");

      // The method has exactly 2 parameters (s3Key: string, input: S3RetentionInput)
      expect(instance.applyPlanRetention.length).toBe(2);
    });

    it("for any plan, the retention decision is self-contained — no signal ID or account ID needed", () => {
      return propertyRunner.assert(
        fc.asyncProperty(arbBillingPlan, async (plan) => {
          const retention: RetentionForPlan = getRetentionForPlan(plan);

          // The retention object contains only s3Tag, retentionDuration, and copyToSaved
          const keys = Object.keys(retention);
          expect(keys).toContain("s3Tag");
          expect(keys).toContain("retentionDuration");
          expect(keys).toContain("copyToSaved");

          // No batch-related fields
          expect(keys).not.toContain("signalIds");
          expect(keys).not.toContain("accountId");
          expect(keys).not.toContain("existingKeys");
          expect(keys).not.toContain("retroactive");

          // Exactly 3 fields — no hidden state
          expect(keys.length).toBe(3);
        }),
      );
    });

    it("plan change between two getRetentionForPlan calls produces independent decisions with no cross-contamination", () => {
      return propertyRunner.assert(
        fc.asyncProperty(arbBillingPlan, arbBillingPlan, async (planBefore, planAfter) => {
          const retentionBefore = getRetentionForPlan(planBefore);
          const retentionAfter = getRetentionForPlan(planAfter);

          // Each decision is computed solely from its own plan input
          const freshRetentionBefore = getRetentionForPlan(planBefore);
          expect(retentionBefore).toEqual(freshRetentionBefore);

          const freshRetentionAfter = getRetentionForPlan(planAfter);
          expect(retentionAfter).toEqual(freshRetentionAfter);
        }),
      );
    });
  });
});
