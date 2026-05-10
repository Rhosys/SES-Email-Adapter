import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "../testing/property-runner.js";
import { resolveRetentionForPlan, type BillingPlan, type FreePlan, type PaidPlan } from "./retention-tier.js";
import type { RetentionDecision } from "./retention-tier.js";

// ---------------------------------------------------------------------------
// Property 18: Retention tier on S3 tag and DynamoDB record always agree
// **Validates: Requirements 8.4, 8.5**
// ---------------------------------------------------------------------------

/**
 * Maps a retention decision to the expected DynamoDB userDisplayedRetention value.
 * This is the "agreement" check: the S3 tag and DynamoDB field should both reflect
 * the same plan-based retention decision.
 */
function userDisplayedRetentionFromDecision(decision: RetentionDecision): string {
  // The decision's userDisplayedRetention field IS the DynamoDB value
  return decision.userDisplayedRetention;
}

/**
 * Maps a retention decision to the expected S3 tag value.
 * Free tier: "retention-tier=P6M" tag
 * Paid tier: no tag (null)
 */
function s3TagFromDecision(decision: RetentionDecision): string | null {
  return decision.s3Tag;
}

describe("Property 18: Retention tier on S3 tag and DynamoDB record always agree", () => {
  // Generators for billing plans
  const arbFreePlan: fc.Arbitrary<FreePlan> = fc.constant({ type: 'free' } as FreePlan);
  
  const arbPaidPlan: fc.Arbitrary<PaidPlan> = fc.boolean().map(indefinite => ({
    type: 'paid' as const,
    indefinite,
  }));

  const arbBillingPlan: fc.Arbitrary<BillingPlan> = fc.oneof(arbFreePlan, arbPaidPlan);

  it("for any plan, userDisplayedRetention matches the plan-to-retention mapping", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const decision = resolveRetentionForPlan(plan);
        
        // The userDisplayedRetention field should match the expected value for this plan type
        if (plan.type === 'free') {
          expect(decision.userDisplayedRetention).toBe('6 months');
        } else if (plan.type === 'paid') {
          if (plan.indefinite) {
            expect(decision.userDisplayedRetention).toBe('forever');
          } else {
            expect(decision.userDisplayedRetention).toBe('5 years');
          }
        }
        
        return true;
      }),
    );
  });

  it("for any plan, S3 tag and DynamoDB retention always agree on the tier", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const decision = resolveRetentionForPlan(plan);
        
        // Free tier: P6M tag + '6 months' display
        if (plan.type === 'free') {
          expect(decision.s3Tag).toBe('retention-tier=P6M');
          expect(decision.userDisplayedRetention).toBe('6 months');
        }
        
        // Paid tier (default): no tag + '5 years' display
        if (plan.type === 'paid' && !plan.indefinite) {
          expect(decision.s3Tag).toBeNull();
          expect(decision.userDisplayedRetention).toBe('5 years');
        }
        
        // Paid tier (indefinite): no tag + 'forever' display
        if (plan.type === 'paid' && plan.indefinite) {
          expect(decision.s3Tag).toBeNull();
          expect(decision.userDisplayedRetention).toBe('forever');
        }
        
        return true;
      }),
    );
  });

  it("S3 tag presence correlates with user-facing retention duration", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const decision = resolveRetentionForPlan(plan);
        
        // Free tier (6 months) has a tag
        if (plan.type === 'free') {
          expect(decision.s3Tag).not.toBeNull();
          expect(decision.userDisplayedRetention).toBe('6 months');
        }
        
        // Paid tier (5 years or forever) has no tag
        if (plan.type === 'paid') {
          expect(decision.s3Tag).toBeNull();
          // But the retention duration is still reflected in userDisplayedRetention
          expect(['5 years', 'forever']).toContain(decision.userDisplayedRetention);
        }
        
        return true;
      }),
    );
  });

  it("plan type determines both S3 tag and DynamoDB field consistently", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const decision = resolveRetentionForPlan(plan);
        
        // The decision is derived solely from the plan type
        // Both S3 tag and DynamoDB field should be deterministic based on plan
        const expectedTag = plan.type === 'free' ? 'retention-tier=P6M' : null;
        const expectedDisplay = 
          plan.type === 'free' ? '6 months' :
          plan.type === 'paid' && plan.indefinite ? 'forever' :
          '5 years';
        
        expect(decision.s3Tag).toBe(expectedTag);
        expect(decision.userDisplayedRetention).toBe(expectedDisplay);
        
        return true;
      }),
    );
  });

  it("determinism: same plan always produces same tag and DynamoDB value", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const decision1 = resolveRetentionForPlan(plan);
        const decision2 = resolveRetentionForPlan(plan);
        
        // Both decisions should be identical
        expect(decision1.s3Tag).toBe(decision2.s3Tag);
        expect(decision1.userDisplayedRetention).toBe(decision2.userDisplayedRetention);
        
        return true;
      }),
    );
  });
});
