import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "../testing/property-runner.js";
import {
  getRetentionForPlan,
  getUserDisplayedRetention,
  retentionDurationToSeconds,
  tierIndex,
  isWithinPlanLimit,
  BillingPlan,
  RetentionDuration,
  RETENTION_TAGS,
  S3_PREFIXES,
} from "./retention-tier.js";

// ---------------------------------------------------------------------------
// Tests for getRetentionForPlan
// ---------------------------------------------------------------------------

describe("getRetentionForPlan", () => {
  describe("Free tier", () => {
    it("returns P1Y tag, P1Y duration, no copy", () => {
      const result = getRetentionForPlan('Free');
      expect(result).toEqual({
        s3Tag: RETENTION_TAGS.P1Y,
        retentionDuration: 'P1Y',
        copyToSaved: false,
      });
    });
  });

  describe("Beta tier", () => {
    it("returns P1Y tag, P1Y duration, no copy", () => {
      const result = getRetentionForPlan('Beta');
      expect(result).toEqual({
        s3Tag: RETENTION_TAGS.P1Y,
        retentionDuration: 'P1Y',
        copyToSaved: false,
      });
    });
  });

  describe("Paid tier", () => {
    it("returns no tag, P5Y duration, no copy", () => {
      const result = getRetentionForPlan('Paid');
      expect(result).toEqual({
        s3Tag: null,
        retentionDuration: 'P5Y',
        copyToSaved: false,
      });
    });
  });

  describe("Lifetime tier", () => {
    it("returns no tag, P5Y duration, no copy", () => {
      const result = getRetentionForPlan('Lifetime');
      expect(result).toEqual({
        s3Tag: null,
        retentionDuration: 'P5Y',
        copyToSaved: false,
      });
    });
  });

  describe("Premium tier", () => {
    it("returns no tag, P1000Y duration, copy to saved", () => {
      const result = getRetentionForPlan('Premium');
      expect(result).toEqual({
        s3Tag: null,
        retentionDuration: 'P1000Y',
        copyToSaved: true,
      });
    });
  });

  describe("Internal tier", () => {
    it("returns no tag, P1000Y duration, copy to saved", () => {
      const result = getRetentionForPlan('Internal');
      expect(result).toEqual({
        s3Tag: null,
        retentionDuration: 'P1000Y',
        copyToSaved: true,
      });
    });
  });

  it("handles all plan combinations correctly", () => {
    expect(getRetentionForPlan('Free').s3Tag).toBe(RETENTION_TAGS.P1Y);
    expect(getRetentionForPlan('Beta').s3Tag).toBe(RETENTION_TAGS.P1Y);
    expect(getRetentionForPlan('Paid').s3Tag).toBeNull();
    expect(getRetentionForPlan('Lifetime').s3Tag).toBeNull();
    expect(getRetentionForPlan('Premium').s3Tag).toBeNull();
    expect(getRetentionForPlan('Internal').s3Tag).toBeNull();

    expect(getRetentionForPlan('Free').copyToSaved).toBe(false);
    expect(getRetentionForPlan('Paid').copyToSaved).toBe(false);
    expect(getRetentionForPlan('Premium').copyToSaved).toBe(true);
    expect(getRetentionForPlan('Internal').copyToSaved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests for getUserDisplayedRetention
// ---------------------------------------------------------------------------

describe("getUserDisplayedRetention", () => {
  it("returns '1 year' for P1Y", () => {
    expect(getUserDisplayedRetention('P1Y')).toBe('1 year');
  });

  it("returns '5 years' for P5Y", () => {
    expect(getUserDisplayedRetention('P5Y')).toBe('5 years');
  });

  it("returns 'forever' for P1000Y", () => {
    expect(getUserDisplayedRetention('P1000Y')).toBe('forever');
  });
});

// ---------------------------------------------------------------------------
// Tests for retentionDurationToSeconds
// ---------------------------------------------------------------------------

describe("retentionDurationToSeconds", () => {
  it("returns 365 days in seconds for P1Y", () => {
    expect(retentionDurationToSeconds('P1Y')).toBe(365 * 24 * 60 * 60);
  });

  it("returns 5*365 days in seconds for P5Y", () => {
    expect(retentionDurationToSeconds('P5Y')).toBe(5 * 365 * 24 * 60 * 60);
  });

  it("returns 1000*365 days in seconds for P1000Y", () => {
    expect(retentionDurationToSeconds('P1000Y')).toBe(1000 * 365 * 24 * 60 * 60);
  });
});

// ---------------------------------------------------------------------------
// Tests for tierIndex
// ---------------------------------------------------------------------------

describe("tierIndex", () => {
  it("returns 0 for P1Y", () => {
    expect(tierIndex('P1Y')).toBe(0);
  });

  it("returns 1 for P5Y", () => {
    expect(tierIndex('P5Y')).toBe(1);
  });

  it("returns 2 for P1000Y", () => {
    expect(tierIndex('P1000Y')).toBe(2);
  });

  it("higher index means more retention", () => {
    expect(tierIndex('P1Y')).toBeLessThan(tierIndex('P5Y'));
    expect(tierIndex('P5Y')).toBeLessThan(tierIndex('P1000Y'));
  });
});

// ---------------------------------------------------------------------------
// Tests for isWithinPlanLimit
// ---------------------------------------------------------------------------

describe("isWithinPlanLimit", () => {
  describe("Free tier", () => {
    it("allows P1Y", () => {
      expect(isWithinPlanLimit('P1Y', 'Free')).toBe(true);
    });

    it("does not allow P5Y", () => {
      expect(isWithinPlanLimit('P5Y', 'Free')).toBe(false);
    });

    it("does not allow P1000Y", () => {
      expect(isWithinPlanLimit('P1000Y', 'Free')).toBe(false);
    });
  });

  describe("Paid tier", () => {
    it("allows P1Y", () => {
      expect(isWithinPlanLimit('P1Y', 'Paid')).toBe(true);
    });

    it("allows P5Y", () => {
      expect(isWithinPlanLimit('P5Y', 'Paid')).toBe(true);
    });

    it("does not allow P1000Y", () => {
      expect(isWithinPlanLimit('P1000Y', 'Paid')).toBe(false);
    });
  });

  describe("Premium tier", () => {
    it("allows P1Y", () => {
      expect(isWithinPlanLimit('P1Y', 'Premium')).toBe(true);
    });

    it("allows P5Y", () => {
      expect(isWithinPlanLimit('P5Y', 'Premium')).toBe(true);
    });

    it("allows P1000Y", () => {
      expect(isWithinPlanLimit('P1000Y', 'Premium')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

const arbBillingPlan: fc.Arbitrary<BillingPlan> = fc.oneof(
  fc.constant('Free' as BillingPlan),
  fc.constant('Beta' as BillingPlan),
  fc.constant('Paid' as BillingPlan),
  fc.constant('Lifetime' as BillingPlan),
  fc.constant('Premium' as BillingPlan),
  fc.constant('Internal' as BillingPlan),
);

const arbRetentionDuration: fc.Arbitrary<RetentionDuration> = fc.oneof(
  fc.constant('P1Y' as RetentionDuration),
  fc.constant('P5Y' as RetentionDuration),
  fc.constant('P1000Y' as RetentionDuration),
);

describe("Property 20: Tier requests above plan max are rejected", () => {
  it("isWithinPlanLimit returns true iff tierIndex(requested) <= tierIndex(planMax)", () => {
    const property = fc.property(
      arbBillingPlan,
      arbRetentionDuration,
      (plan, requestedDuration) => {
        const planMaxMap: Record<BillingPlan, RetentionDuration> = {
          Free: 'P1Y', Beta: 'P1Y', Paid: 'P5Y', Lifetime: 'P5Y', Premium: 'P1000Y', Internal: 'P1000Y',
        };
        const maxDuration = planMaxMap[plan];
        const expected = tierIndex(requestedDuration) <= tierIndex(maxDuration);
        return isWithinPlanLimit(requestedDuration, plan) === expected;
      }
    );

    propertyRunner.assert(property);
  });
});

describe("Determinism: getRetentionForPlan is pure", () => {
  it("returns same result for same plan", () => {
    const property = fc.property(
      arbBillingPlan,
      (plan) => {
        const result1 = getRetentionForPlan(plan);
        const result2 = getRetentionForPlan(plan);
        return JSON.stringify(result1) === JSON.stringify(result2);
      }
    );

    propertyRunner.assert(property);
  });
});

describe("Consistency: getUserDisplayedRetention matches getRetentionForPlan", () => {
  it("getUserDisplayedRetention(getRetentionForPlan(plan).retentionDuration) is always a valid display string", () => {
    const property = fc.property(
      arbBillingPlan,
      (plan) => {
        const retention = getRetentionForPlan(plan);
        const display = getUserDisplayedRetention(retention.retentionDuration);
        return ['1 year', '5 years', 'forever'].includes(display);
      }
    );

    propertyRunner.assert(property);
  });
});
