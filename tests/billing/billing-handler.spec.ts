import { describe, it, expect } from "vitest";
import { BillingHandler, Feature } from "../../src/billing/billing-handler.js";
import { BillingPlan } from "../../src/embedding/retention-tier.js";

describe("BillingHandler", () => {
  const handler = new BillingHandler();

  const ALL_PLANS: BillingPlan[] = ["Trial", "Free", "Beta", "Paid", "Lifetime", "Premium", "Internal", "Enterprise"];

  const cases: Array<{ plan: BillingPlan; feature: Feature; expected: boolean }> = ALL_PLANS.map((plan) => ({
    plan,
    feature: "webhook" as const,
    expected: plan !== "Trial" && plan !== "Free",
  }));

  it.each(cases)(
    "isFeatureEnabled($plan, $feature) = $expected",
    ({ plan, feature, expected }) => {
      expect(handler.isFeatureEnabled(plan, feature)).toBe(expected);
    },
  );
});
