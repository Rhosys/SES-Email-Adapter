import { BillingPlan } from "../embedding/retention-tier.js";

export type Feature = "webhook";

export class BillingHandler {
  private static readonly PLAN_FEATURES: Record<BillingPlan, Set<Feature>> = {
    Trial: new Set(),
    Free: new Set(),
    Beta: new Set(["webhook"]),
    Paid: new Set(["webhook"]),
    Lifetime: new Set(["webhook"]),
    Premium: new Set(["webhook"]),
    Internal: new Set(["webhook"]),
    Enterprise: new Set(["webhook"]),
  };

  isFeatureEnabled(accountPlan: BillingPlan, feature: Feature): boolean {
    return BillingHandler.PLAN_FEATURES[accountPlan]?.has(feature) ?? false;
  }
}
