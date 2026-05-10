// ---------------------------------------------------------------------------
// Retention tiers
// ---------------------------------------------------------------------------

// S3 retention tag values
export const RETENTION_TAGS = {
  P6M: 'retention-tier=P6M', // 6 months for free tier
} as const;

export type RetentionTag = typeof RETENTION_TAGS[keyof typeof RETENTION_TAGS];

// S3 prefix for email storage
export const S3_PREFIXES = {
  INBOX: 'inbox/',
  SAVED: 'saved/',
} as const;

export type S3Prefix = typeof S3_PREFIXES[keyof typeof S3_PREFIXES];

export type UserDisplayedRetention = '6 months' | '5 years' | 'forever';

export interface RetentionDecision {
  s3Tag: RetentionTag | null;
  s3Prefix: S3Prefix;
  userDisplayedRetention: UserDisplayedRetention;
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface FreePlan { type: 'free'; }
export interface PaidPlan { type: 'paid'; indefinite?: boolean; }

export type BillingPlan = FreePlan | PaidPlan;

// ---------------------------------------------------------------------------
// Plan → tier mapping
// ---------------------------------------------------------------------------

/**
 * Resolves the retention decision for a given billing plan.
 *
 * - Free tier: P6M tag on inbox/, user sees "6 months"
 * - Paid tier (default): no tag on inbox/, user sees "5 years"
 * - Paid tier (indefinite): no tag on saved/, user sees "forever"
 */
export function resolveRetentionForPlan(plan: BillingPlan): RetentionDecision {
  switch (plan.type) {
    case 'free':
      return {
        s3Tag: RETENTION_TAGS.P6M,
        s3Prefix: S3_PREFIXES.INBOX,
        userDisplayedRetention: '6 months',
      };
    case 'paid':
      if (plan.indefinite) {
        return {
          s3Tag: null,
          s3Prefix: S3_PREFIXES.SAVED,
          userDisplayedRetention: 'forever',
        };
      }
      return {
        s3Tag: null,
        s3Prefix: S3_PREFIXES.INBOX,
        userDisplayedRetention: '5 years',
      };
  }
}

/**
 * Returns true if the plan has indefinite retention (saved/ prefix).
 */
export function planHasIndefiniteRetention(plan: BillingPlan): boolean {
  return plan.type === 'paid' && plan.indefinite === true;
}

// ---------------------------------------------------------------------------
// Tier ordering for plan limit validation
// ---------------------------------------------------------------------------

// Tier index mapping (higher index = more retention)
const TIER_INDEX: Record<UserDisplayedRetention, number> = {
  '6 months': 0,
  '5 years': 1,
  'forever': 2,
};

/**
 * Returns the numeric index for a retention tier.
 * Higher index = more retention.
 */
export function tierIndex(tier: UserDisplayedRetention): number {
  return TIER_INDEX[tier];
}

/**
 * Plan max tiers (what each plan type allows)
 */
const PLAN_MAX_TIER: Record<BillingPlan['type'], UserDisplayedRetention> = {
  free: '6 months',
  paid: 'forever',
};

/**
 * Checks if a requested tier is within the plan's limits.
 *
 * Returns true if tierIndex(requestedTier) <= tierIndex(PLAN_MAX_TIER[plan.type]).
 */
export function isWithinPlanLimit(requestedTier: UserDisplayedRetention, plan: BillingPlan): boolean {
  const maxTier = PLAN_MAX_TIER[plan.type];
  return tierIndex(requestedTier) <= tierIndex(maxTier);
}
