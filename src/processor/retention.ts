// ---------------------------------------------------------------------------
// Retention model for extracted content bucket
//
// This module handles retention for the extracted content S3 bucket (images,
// attachments). It uses S3 lifecycle tags to control object expiration:
//   - "365"  → 1 year lifecycle rule
//   - "3650" → 10 year lifecycle rule
//   - null   → no tag, object lives forever
//
// Separate from embedding/retention-tier.ts which handles the email inbox bucket.
// ---------------------------------------------------------------------------

/**
 * ISO 8601 durations allowed for signal/arc retention.
 * These map to S3 lifecycle tags on the extracted content bucket.
 */
export type RetentionDuration =
  | "P1M" | "P2M" | "P3M" | "P5M" | "P6M"
  | "P1Y" | "P2Y" | "P5Y" | "P10Y"
  | "P100Y" | "Infinity";

/**
 * S3 lifecycle tag value for the extracted content bucket.
 * - "365"  → expires after 365 days
 * - "3650" → expires after 3650 days
 * - null   → no lifecycle rule applies (forever)
 */
export type S3RetentionTag = "365" | "3650" | null;

/**
 * Maps a retention duration to the appropriate S3 lifecycle tag.
 * Durations ≤ 1 year get the 365-day tag, 2–10 years get the 3650-day tag,
 * and 100Y/Infinity get no tag (live forever).
 */
export function retentionToS3Tag(duration: RetentionDuration): S3RetentionTag {
  switch (duration) {
    case "P1M": case "P2M": case "P3M": case "P5M": case "P6M": case "P1Y":
      return "365";
    case "P2Y": case "P5Y": case "P10Y":
      return "3650";
    case "P100Y": case "Infinity":
      return null;
  }
}

// Approximate seconds per duration (uses 30-day months, 365-day years)
const DURATION_SECONDS: Record<RetentionDuration, number | null> = {
  "P1M": 30 * 24 * 60 * 60,
  "P2M": 60 * 24 * 60 * 60,
  "P3M": 90 * 24 * 60 * 60,
  "P5M": 150 * 24 * 60 * 60,
  "P6M": 180 * 24 * 60 * 60,
  "P1Y": 365 * 24 * 60 * 60,
  "P2Y": 2 * 365 * 24 * 60 * 60,
  "P5Y": 5 * 365 * 24 * 60 * 60,
  "P10Y": 10 * 365 * 24 * 60 * 60,
  "P100Y": 100 * 365 * 24 * 60 * 60,
  "Infinity": null,
};

/**
 * Converts a retention duration to seconds (for computing DynamoDB TTL).
 * Returns null for "Infinity" (item lives forever, no TTL set).
 */
export function durationToSeconds(duration: RetentionDuration): number | null {
  return DURATION_SECONDS[duration];
}

/**
 * Context needed to resolve retention — subset of ProcessorAccountContext.
 */
export interface RetentionAccountContext {
  /** Account-level default retention, if configured */
  retentionDuration?: RetentionDuration;
}

/**
 * Email/alias config relevant to retention resolution.
 */
export interface RetentionEmailConfig {
  /** Alias-level retention override, if configured */
  retentionDuration?: RetentionDuration;
}

/**
 * Resolves the effective retention duration using priority:
 *   1. Rule action override (explicit per-signal)
 *   2. Alias-level retention (per receiving address)
 *   3. Account-level default
 *   4. System default: P1Y
 */
export function resolveRetention(
  accountCtx: RetentionAccountContext,
  aliasConfig: RetentionEmailConfig | null,
  ruleOverride?: RetentionDuration,
): RetentionDuration {
  if (ruleOverride) return ruleOverride;
  if (aliasConfig?.retentionDuration) return aliasConfig.retentionDuration;
  if (accountCtx.retentionDuration) return accountCtx.retentionDuration;
  return "P3M";
}
