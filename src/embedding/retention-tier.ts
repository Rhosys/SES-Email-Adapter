import { DateTime, Duration } from 'luxon';

// ---------------------------------------------------------------------------
// Retention tiers
// ---------------------------------------------------------------------------

// S3 retention tag values
export const RETENTION_TAGS = {
  P1Y: 'retention-tier=P1Y', // 1 year for free tier
} as const;

export type RetentionTag = typeof RETENTION_TAGS[keyof typeof RETENTION_TAGS];

// S3 prefixes for email storage. SES writes inbound mail under emails/ (see the
// receipt rule's object_key_prefix). Long-retention plans keep a durable copy
// under saved/, which has no lifecycle expiry.
export const S3_PREFIXES = {
  EMAILS: 'emails/',
  SAVED: 'saved/',
} as const;

export type S3Prefix = typeof S3_PREFIXES[keyof typeof S3_PREFIXES];

// The default lifecycle rule expires emails/ objects after 5 years (1825 days).
// Past that horizon only the saved/ copy (copy-to-saved plans) survives.
export const LIFECYCLE_EXPIRY_DAYS = 1825;

/**
 * Maps an `emails/{name}` key to its durable `saved/{name}` counterpart. The
 * emails/ prefix is stripped so the saved copy mirrors the object name rather
 * than nesting under saved/emails/. Keys without the emails/ prefix are mapped
 * as-is under saved/.
 */
export function toSavedKey(s3Key: string): string {
  const objectName = s3Key.startsWith(S3_PREFIXES.EMAILS)
    ? s3Key.slice(S3_PREFIXES.EMAILS.length)
    : s3Key;
  return `${S3_PREFIXES.SAVED}${objectName}`;
}

/**
 * Resolves the S3 key to actually read for a raw email. Objects live under
 * emails/ until the lifecycle rule expires them; after LIFECYCLE_EXPIRY_DAYS the
 * emails/ object is gone, so signals older than that resolve to the saved/ copy.
 * This is derived at read time — the signal's stored s3Key is never rewritten.
 */
export function effectiveEmailKey(s3Key: string, createdAt: string, now: DateTime = DateTime.utc()): string {
  const ageDays = now.diff(DateTime.fromISO(createdAt)).as('days');
  return ageDays > LIFECYCLE_EXPIRY_DAYS ? toSavedKey(s3Key) : s3Key;
}

// ISO 8601 durations stored on DynamoDB Signal records
export type RetentionDuration = 'P1Y' | 'P5Y' | 'P1000Y';

// User-facing retention labels — NEVER stored, derived at API response time
export type UserDisplayedRetention = '1 year' | '5 years' | 'forever';

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export type BillingPlan = 'Trial' | 'Free' | 'Beta' | 'Paid' | 'Lifetime' | 'Premium' | 'Internal' | 'Enterprise';

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
    case 'Trial':
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
    case 'Enterprise':
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
 * Converts an ISO 8601 duration to seconds using luxon Duration parsing.
 */
export function retentionDurationToSeconds(duration: RetentionDuration): number {
  const d = Duration.fromISO(duration);
  if (!d.isValid) throw new Error(`Invalid ISO 8601 duration: ${duration}`);
  return Math.floor(d.as('seconds'));
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
  Trial: 'P1Y',
  Free: 'P1Y',
  Beta: 'P1Y',
  Paid: 'P5Y',
  Lifetime: 'P5Y',
  Premium: 'P1000Y',
  Internal: 'P1000Y',
  Enterprise: 'P1000Y',
};

/**
 * Checks if a requested retention duration is within the plan's limits.
 */
export function isWithinPlanLimit(requestedDuration: RetentionDuration, plan: BillingPlan): boolean {
  const maxDuration = PLAN_MAX_TIER[plan];
  return tierIndex(requestedDuration) <= tierIndex(maxDuration);
}
