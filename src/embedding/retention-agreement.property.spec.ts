import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "../testing/property-runner.js";
import { getRetentionForPlan, getUserDisplayedRetention, type BillingPlan, type RetentionForPlan } from "./retention-tier.js";

// ---------------------------------------------------------------------------
// Property 18: Retention tier on S3 tag and DynamoDB record always agree
// **Validates: Requirements 8.4, 8.5**
// ---------------------------------------------------------------------------

/**
 * The new model stores `retentionDuration` (ISO 8601) on the DynamoDB record.
 * `userDisplayedRetention` is NEVER stored — it's derived at API response time.
 * This property verifies that the S3 tag and the stored retentionDuration always
 * agree according to the plan-to-retention mapping.
 */

describe("Property 18: Retention tier on S3 tag and DynamoDB record always agree", () => {
  const arbBillingPlan: fc.Arbitrary<BillingPlan> = fc.oneof(
    fc.constant('Free' as BillingPlan),
    fc.constant('Beta' as BillingPlan),
    fc.constant('Paid' as BillingPlan),
    fc.constant('Lifetime' as BillingPlan),
    fc.constant('Premium' as BillingPlan),
    fc.constant('Internal' as BillingPlan),
  );

  it("for any plan, retentionDuration matches the plan-to-retention mapping", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const retention = getRetentionForPlan(plan);

        // Free/Beta → P1Y
        if (plan === 'Free' || plan === 'Beta') {
          expect(retention.retentionDuration).toBe('P1Y');
        }
        // Paid/Lifetime → P5Y
        if (plan === 'Paid' || plan === 'Lifetime') {
          expect(retention.retentionDuration).toBe('P5Y');
        }
        // Premium/Internal → P1000Y
        if (plan === 'Premium' || plan === 'Internal') {
          expect(retention.retentionDuration).toBe('P1000Y');
        }

        return true;
      }),
    );
  });

  it("for any plan, S3 tag and retentionDuration always agree on the tier", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const retention = getRetentionForPlan(plan);

        // Free/Beta: P1Y tag + P1Y duration
        if (plan === 'Free' || plan === 'Beta') {
          expect(retention.s3Tag).toBe('retention-tier=P1Y');
          expect(retention.retentionDuration).toBe('P1Y');
        }

        // Paid/Lifetime: no tag + P5Y duration
        if (plan === 'Paid' || plan === 'Lifetime') {
          expect(retention.s3Tag).toBeNull();
          expect(retention.retentionDuration).toBe('P5Y');
        }

        // Premium/Internal: no tag + P1000Y duration + copy to saved
        if (plan === 'Premium' || plan === 'Internal') {
          expect(retention.s3Tag).toBeNull();
          expect(retention.retentionDuration).toBe('P1000Y');
          expect(retention.copyToSaved).toBe(true);
        }

        return true;
      }),
    );
  });

  it("S3 tag presence correlates with retention duration", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const retention = getRetentionForPlan(plan);

        // Free/Beta (P1Y) has a tag
        if (plan === 'Free' || plan === 'Beta') {
          expect(retention.s3Tag).not.toBeNull();
          expect(retention.retentionDuration).toBe('P1Y');
        }

        // Paid+ (P5Y or P1000Y) has no tag
        if (plan === 'Paid' || plan === 'Lifetime' || plan === 'Premium' || plan === 'Internal') {
          expect(retention.s3Tag).toBeNull();
          expect(['P5Y', 'P1000Y']).toContain(retention.retentionDuration);
        }

        return true;
      }),
    );
  });

  it("plan type determines both S3 tag and retentionDuration consistently", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const retention = getRetentionForPlan(plan);

        const expectedTag = (plan === 'Free' || plan === 'Beta') ? 'retention-tier=P1Y' : null;
        const expectedDuration =
          (plan === 'Free' || plan === 'Beta') ? 'P1Y' :
          (plan === 'Paid' || plan === 'Lifetime') ? 'P5Y' :
          'P1000Y';

        expect(retention.s3Tag).toBe(expectedTag);
        expect(retention.retentionDuration).toBe(expectedDuration);

        return true;
      }),
    );
  });

  it("determinism: same plan always produces same tag and retentionDuration", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const retention1 = getRetentionForPlan(plan);
        const retention2 = getRetentionForPlan(plan);

        expect(retention1.s3Tag).toBe(retention2.s3Tag);
        expect(retention1.retentionDuration).toBe(retention2.retentionDuration);
        expect(retention1.copyToSaved).toBe(retention2.copyToSaved);

        return true;
      }),
    );
  });

  it("getUserDisplayedRetention correctly derives display from retentionDuration", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbBillingPlan, async (plan) => {
        const retention = getRetentionForPlan(plan);
        const display = getUserDisplayedRetention(retention.retentionDuration);

        if (retention.retentionDuration === 'P1Y') expect(display).toBe('1 year');
        if (retention.retentionDuration === 'P5Y') expect(display).toBe('5 years');
        if (retention.retentionDuration === 'P1000Y') expect(display).toBe('forever');

        return true;
      }),
    );
  });
});
