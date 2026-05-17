import { describe, it, expect, vi } from "vitest";
import { getRetentionForPlan, type BillingPlan, type RetentionForPlan } from "../../src/embedding/retention-tier.js";
import * as retentionTierModule from "../../src/embedding/retention-tier.js";
import * as s3RetentionServiceModule from "../../src/embedding/s3-retention-service.js";
import { S3RetentionServiceImpl } from "../../src/embedding/s3-retention-service.js";
import { S3Client, PutObjectTaggingCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

const ALL_PLANS: BillingPlan[] = ["Free", "Beta", "Paid", "Lifetime", "Premium", "Internal"];

describe("Plan changes never retroactively retag", () => {
  describe("getRetentionForPlan is pure", () => {
    it.each(ALL_PLANS.map((plan) => ({ plan })))("plan=$plan — same plan always produces same result", ({ plan }) => {
      expect(getRetentionForPlan(plan)).toEqual(getRetentionForPlan(plan));
    });

    it("interleaved calls do not affect each other", () => {
      const beforeA = getRetentionForPlan("Free");
      getRetentionForPlan("Premium");
      const afterA = getRetentionForPlan("Free");
      expect(beforeA).toEqual(afterA);
    });

    it("mutating returned object does not affect subsequent calls", () => {
      const result1 = getRetentionForPlan("Paid");
      (result1 as unknown as Record<string, unknown>).s3Tag = "MUTATED";
      const result2 = getRetentionForPlan("Paid");
      expect(result2.s3Tag).not.toBe("MUTATED");
    });
  });

  describe("no exported update-retention-by-signal-ID function exists", () => {
    it("retention-tier module has no signal mutation functions", () => {
      const exportedFunctions = Object.entries(retentionTierModule)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => name);

      const signalMutationPatterns = [/updateRetention/i, /changeRetention/i, /retagSignal/i, /setRetention/i, /modifyRetention/i];
      for (const fnName of exportedFunctions) {
        for (const pattern of signalMutationPatterns) {
          expect(fnName).not.toMatch(pattern);
        }
      }
    });

    it("s3-retention-service module has no batch-retag functions", () => {
      const exportedNames = Object.keys(s3RetentionServiceModule);
      const batchPatterns = [/batchRetag/i, /retagAll/i, /updateRetentionForAccount/i, /retroactiveRetag/i];
      for (const name of exportedNames) {
        for (const pattern of batchPatterns) {
          expect(name).not.toMatch(pattern);
        }
      }
    });
  });

  describe("applyPlanRetention operates on a single s3Key only", () => {
    it("method accepts exactly 2 parameters (s3Key, input)", () => {
      const instance = new S3RetentionServiceImpl(undefined as unknown as S3Client, "test-bucket");
      expect(typeof instance.applyPlanRetention).toBe("function");
      expect(instance.applyPlanRetention.length).toBe(2);
    });

    it.each(ALL_PLANS.map((plan) => ({ plan })))("plan=$plan — retention decision has exactly 3 fields, no batch state", ({ plan }) => {
      const retention = getRetentionForPlan(plan);
      const keys = Object.keys(retention);
      expect(keys).toContain("s3Tag");
      expect(keys).toContain("retentionDuration");
      expect(keys).toContain("copyToSaved");
      expect(keys.length).toBe(3);
    });
  });

  describe("plan change produces no retroactive S3 operations on existing signals", () => {
    const planTransitions = [
      { oldPlan: "Free" as BillingPlan, newPlan: "Paid" as BillingPlan },
      { oldPlan: "Paid" as BillingPlan, newPlan: "Premium" as BillingPlan },
      { oldPlan: "Premium" as BillingPlan, newPlan: "Free" as BillingPlan },
    ];

    it.each(planTransitions)("$oldPlan → $newPlan — new signal's S3 calls never reference existing key", async ({ oldPlan, newPlan }) => {
      const s3Mock = mockClient(S3Client);
      s3Mock.on(PutObjectTaggingCommand).resolves({});
      s3Mock.on(CopyObjectCommand).resolves({});

      const service = new S3RetentionServiceImpl(s3Mock as unknown as S3Client, "test-bucket");

      const existingS3Key = "inbox/existing-signal.eml";
      const newS3Key = "inbox/new-signal.eml";

      // Apply retention for existing signal under old plan
      const oldRetention = getRetentionForPlan(oldPlan);
      await service.applyPlanRetention(existingS3Key, { s3Tag: oldRetention.s3Tag, copyToSaved: oldRetention.copyToSaved });

      const callsAfterExisting = s3Mock.calls().length;

      // Plan changes — apply retention for new signal under new plan
      const newRetention = getRetentionForPlan(newPlan);
      await service.applyPlanRetention(newS3Key, { s3Tag: newRetention.s3Tag, copyToSaved: newRetention.copyToSaved });

      // All S3 calls after plan change only reference the new key
      const allCalls = s3Mock.calls();
      const newCalls = allCalls.slice(callsAfterExisting);
      for (const call of newCalls) {
        const input = call.args[0].input as Record<string, unknown>;
        if (input["Key"]) expect(input["Key"]).not.toBe(existingS3Key);
        if (input["CopySource"]) expect(input["CopySource"]).not.toContain(existingS3Key);
      }
    });
  });
});
