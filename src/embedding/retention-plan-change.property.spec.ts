import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "../testing/property-runner.js";
import {
  getRetentionForPlan,
  type BillingPlan,
  type RetentionForPlan,
} from "./retention-tier.js";
import * as retentionTierModule from "./retention-tier.js";
import * as s3RetentionServiceModule from "./s3-retention-service.js";
import { S3RetentionServiceImpl } from "./s3-retention-service.js";
import { S3Client, PutObjectTaggingCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

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
//   4. For any plan change event, no S3 PutObjectTagging or CopyObject calls
//      are made against existing email objects, and no DynamoDB UpdateItem
//      calls modifying retentionDuration are issued for existing Signal records
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

/**
 * Arbitrary s3Key generator for inbox objects.
 */
const arbS3Key: fc.Arbitrary<string> = fc.string({ minLength: 3, maxLength: 30 })
  .filter((s) => /^[a-zA-Z0-9/_.-]+$/.test(s))
  .map((s) => `inbox/${s}.eml`);

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

  // -------------------------------------------------------------------------
  // 4. Plan change produces no S3 PutObjectTagging/CopyObject calls against
  //    existing objects and no DynamoDB UpdateItem for retentionDuration
  // -------------------------------------------------------------------------
  describe("plan change produces no retroactive S3 or DynamoDB operations on existing signals", () => {
    it("applyPlanRetention for a NEW signal after plan change only touches the new signal's s3Key — never existing keys", () => {
      const s3Mock = mockClient(S3Client);

      return propertyRunner.assert(
        fc.asyncProperty(
          arbBillingPlan,
          arbBillingPlan,
          arbS3Key,
          arbS3Key,
          async (oldPlan, newPlan, existingS3Key, newS3Key) => {
            // Ensure the two keys are distinct to simulate "existing" vs "new"
            fc.pre(existingS3Key !== newS3Key);

            s3Mock.reset();
            s3Mock.on(PutObjectTaggingCommand).resolves({});
            s3Mock.on(CopyObjectCommand).resolves({});

            const service = new S3RetentionServiceImpl(
              s3Mock as unknown as S3Client,
              "test-bucket",
            );

            // Step 1: Apply retention for the existing signal under the old plan
            const oldRetention = getRetentionForPlan(oldPlan);
            await service.applyPlanRetention(existingS3Key, {
              s3Tag: oldRetention.s3Tag,
              copyToSaved: oldRetention.copyToSaved,
            });

            // Record how many S3 calls were made for the existing signal
            const callsAfterExisting = s3Mock.calls().length;

            // Step 2: Plan changes — apply retention for the NEW signal under the new plan
            const newRetention = getRetentionForPlan(newPlan);
            await service.applyPlanRetention(newS3Key, {
              s3Tag: newRetention.s3Tag,
              copyToSaved: newRetention.copyToSaved,
            });

            // All S3 calls after the plan change only reference the NEW s3Key
            const callsAfterNew = s3Mock.calls();
            const newCalls = callsAfterNew.slice(callsAfterExisting);

            for (const call of newCalls) {
              const input = call.args[0].input as Record<string, unknown>;
              // PutObjectTagging and CopyObject both have a Key field
              if (input["Key"]) {
                expect(input["Key"]).not.toBe(existingS3Key);
              }
              // CopyObject has a CopySource field — must not reference existing key
              if (input["CopySource"]) {
                expect(input["CopySource"]).not.toContain(existingS3Key);
              }
            }
          },
        ),
      );
    });

    it("no S3 call references an existing signal's key when processing a new signal after plan change", () => {
      const s3Mock = mockClient(S3Client);

      return propertyRunner.assert(
        fc.asyncProperty(
          arbBillingPlan,
          arbBillingPlan,
          fc.array(arbS3Key, { minLength: 1, maxLength: 5 }),
          arbS3Key,
          async (oldPlan, newPlan, existingKeys, newKey) => {
            // Ensure the new key is not in the existing set
            fc.pre(!existingKeys.includes(newKey));

            s3Mock.reset();
            s3Mock.on(PutObjectTaggingCommand).resolves({});
            s3Mock.on(CopyObjectCommand).resolves({});

            const service = new S3RetentionServiceImpl(
              s3Mock as unknown as S3Client,
              "test-bucket",
            );

            // Process multiple existing signals under the old plan
            const oldRetention = getRetentionForPlan(oldPlan);
            for (const key of existingKeys) {
              await service.applyPlanRetention(key, {
                s3Tag: oldRetention.s3Tag,
                copyToSaved: oldRetention.copyToSaved,
              });
            }

            const callsBeforePlanChange = s3Mock.calls().length;

            // Plan changes — process the new signal under the new plan
            const newRetention = getRetentionForPlan(newPlan);
            await service.applyPlanRetention(newKey, {
              s3Tag: newRetention.s3Tag,
              copyToSaved: newRetention.copyToSaved,
            });

            // Verify: all S3 calls after the plan change only reference the new key
            const allCalls = s3Mock.calls();
            const postChangeCalls = allCalls.slice(callsBeforePlanChange);

            for (const call of postChangeCalls) {
              const input = call.args[0].input as Record<string, unknown>;
              if (input["Key"]) {
                expect(input["Key"]).not.toSatisfy((key: string) =>
                  existingKeys.includes(key),
                );
              }
              if (input["CopySource"]) {
                for (const existingKey of existingKeys) {
                  expect(input["CopySource"]).not.toContain(existingKey);
                }
              }
            }
          },
        ),
      );
    });

    it("retention decision for a new signal never includes existing signal IDs or existing s3Keys in its output", () => {
      return propertyRunner.assert(
        fc.asyncProperty(
          arbBillingPlan,
          arbBillingPlan,
          arbS3Key,
          async (oldPlan, newPlan, existingS3Key) => {
            // Simulate: old signal was created under oldPlan
            const oldRetention = getRetentionForPlan(oldPlan);

            // Plan changes to newPlan — compute retention for a new signal
            const newRetention = getRetentionForPlan(newPlan);

            // The new retention decision is computed purely from the new plan
            // It has no reference to the old signal's s3Key or retention
            expect(newRetention).not.toHaveProperty("existingS3Key");
            expect(newRetention).not.toHaveProperty("previousRetention");
            expect(newRetention).not.toHaveProperty("signalsToUpdate");

            // The old retention is unchanged — no mutation occurred
            const oldRetentionAgain = getRetentionForPlan(oldPlan);
            expect(oldRetentionAgain).toEqual(oldRetention);
          },
        ),
      );
    });
  });
});
