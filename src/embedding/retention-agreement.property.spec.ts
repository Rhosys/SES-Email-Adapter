import { describe, it, expect } from "vitest";
import { getRetentionForPlan, getUserDisplayedRetention, type BillingPlan } from "./retention-tier.js";

const ALL_PLANS: BillingPlan[] = ["Free", "Beta", "Paid", "Lifetime", "Premium", "Internal"];

describe("Retention tier on S3 tag and DynamoDB record always agree", () => {
  it.each(ALL_PLANS.map((plan) => ({ plan })))("plan=$plan — retentionDuration matches plan-to-retention mapping", ({ plan }) => {
    const retention = getRetentionForPlan(plan);

    if (plan === "Free" || plan === "Beta") {
      expect(retention.retentionDuration).toBe("P1Y");
      expect(retention.s3Tag).toBe("retention-tier=P1Y");
    }
    if (plan === "Paid" || plan === "Lifetime") {
      expect(retention.retentionDuration).toBe("P5Y");
      expect(retention.s3Tag).toBeNull();
    }
    if (plan === "Premium" || plan === "Internal") {
      expect(retention.retentionDuration).toBe("P1000Y");
      expect(retention.s3Tag).toBeNull();
      expect(retention.copyToSaved).toBe(true);
    }
  });

  it.each(ALL_PLANS.map((plan) => ({ plan })))("plan=$plan — S3 tag presence correlates with retention duration", ({ plan }) => {
    const retention = getRetentionForPlan(plan);

    if (plan === "Free" || plan === "Beta") {
      expect(retention.s3Tag).not.toBeNull();
    } else {
      expect(retention.s3Tag).toBeNull();
    }
  });

  it.each(ALL_PLANS.map((plan) => ({ plan })))("plan=$plan — deterministic (same plan → same result)", ({ plan }) => {
    const r1 = getRetentionForPlan(plan);
    const r2 = getRetentionForPlan(plan);
    expect(r1).toEqual(r2);
  });

  it.each(ALL_PLANS.map((plan) => ({ plan })))("plan=$plan — getUserDisplayedRetention derives valid display", ({ plan }) => {
    const retention = getRetentionForPlan(plan);
    const display = getUserDisplayedRetention(retention.retentionDuration);
    expect(["1 year", "5 years", "forever"]).toContain(display);
  });
});
