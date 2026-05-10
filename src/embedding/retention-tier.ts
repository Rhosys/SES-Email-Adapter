// ---------------------------------------------------------------------------
// Retention tiers
// ---------------------------------------------------------------------------

// S3 retention tag values
export const RETENTION_TAGS = {
  P1Y: 'retention-tier=P1Y', // 1 year for free tier
} as const;

export type RetentionTag = typeof RETENTION_TAGS[keyof typeof RETENTION_TAGS];

// S3 prefix for email storage
export const S3_PREFIXES = {
  INBOX: 'inbox/',
  SAVED: 'saved/',
} as const;

export type S3Prefix = typeof S3_PREFIXES[keyof typeof S3_PREFIXES];

// ISO 8601 durations stored on DynamoDB Signal records
export type RetentionDuration = 'P1Y' | 'P5Y' | 'P1000Y';

// User-facing retention labels — NEVER stored, derived at API response time
export type UserDisplayedRetention = '1 year' | '5 years' | 'forever';

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export type BillingPlan = 'Free' | 'Beta' | 'Paid' | 'Lifetime' | 'Premium' | 'Internal';

// ---------------------------------------------------------------------------
// RetentionForPlan — the new interface
// ---------------------------------------------------------------------------

export interface RetentionForPlan {
  s3Tag: RetentionTag | null;
  retentionDuration: RetentionDuration;
  copyToSaved: boolean;
}

// ---------------------------------------------------------------------------
// Plan → retention mapping
// ---------------------------------------------------------------------------

/**
 * Returns the retention configuration for a given billing plan.
 *
 * - Free/Beta: P1Y tag on inbox/, 1 year retention
 * - Paid/Lifetime: no tag on inbox/, 5 year retention
 * - Premium/Internal: copy to saved/, 1000 year retention (effectively forever)
 */
export function getRetentionForPlan(plan: BillingPlan): RetentionForPlan {
  switch (plan) {
    case 'Free':
    case 'Beta':
      return {
        s3Tag: RETENTION_TAGS.P1Y,
        retentionDuration: 'P1Y',
        copyToSaved: false,
      };
    case 'Paid':
    case 'Lifetime':
      return {
        s3Tag: null,
        retentionDuration: 'P5Y',
        copyToSaved: false,
      };
    case 'Premium':
    case 'Internal':
      return {
        s3Tag: null,
        retentionDuration: 'P1000Y',
        copyToSaved: true,
      };
  }
}

/**
 * Derives the user-facing retention label from a stored retentionDuration.
 * This is NEVER stored — only computed at API response time.
 */
export function getUserDisplayedRetention(retentionDuration: RetentionDuration): UserDisplayedRetention {
  switch (retentionDuration) {
    case 'P1Y': return '1 year';
    case 'P5Y': return '5 years';
    case 'P1000Y': return 'forever';
  }
}

/**
 * Converts an ISO 8601 duration to seconds.
 * Only supports the retention durations used in this system.
 */
export function retentionDurationToSeconds(duration: RetentionDuration): number {
  switch (duration) {
    case 'P1Y': return 365 * 24 * 60 * 60;       // 31,536,000
    case 'P5Y': return 5 * 365 * 24 * 60 * 60;   // 157,680,000
    case 'P1000Y': return 1000 * 365 * 24 * 60 * 60; // 31,536,000,000
  }
}

// ---------------------------------------------------------------------------
// Tier ordering for plan limit validation
// ---------------------------------------------------------------------------

// Tier index mapping (higher index = more retention)
const TIER_INDEX: Record<RetentionDuration, number> = {
  'P1Y': 0,
  'P5Y': 1,
  'P1000Y': 2,
};

/**
 * Returns the numeric index for a retention duration.
 * Higher index = more retention.
 */
export function tierIndex(duration: RetentionDuration): number {
  return TIER_INDEX[duration];
}

/**
 * Plan max tiers (what each plan type allows)
 */
const PLAN_MAX_TIER: Record<BillingPlan, RetentionDuration> = {
  Free: 'P1Y',
  Beta: 'P1Y',
  Paid: 'P5Y',
  Lifetime: 'P5Y',
  Premium: 'P1000Y',
  Internal: 'P1000Y',
};

/**
 * Checks if a requested retention duration is within the plan's limits.
 */
export function isWithinPlanLimit(requestedDuration: RetentionDuration, plan: BillingPlan): boolean {
  const maxDuration = PLAN_MAX_TIER[plan];
  return tierIndex(requestedDuration) <= tierIndex(maxDuration);
}
