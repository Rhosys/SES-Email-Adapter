import { DateTime } from "luxon";
import type { SuppressedAddress, SuppressionReason } from "../types/index.js";

// 7 days in seconds — soft bounces expire and can retry. Shared by every bounce source
// (SES's own send-time feedback loop, and any out-of-band bounce the processor detects
// itself) so there is exactly one definition of how long a soft bounce stays suppressed.
export const SOFT_BOUNCE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Builds a `SuppressedAddress` entry for a bounced address, regardless of which bounce
 * source produced it. A permanent bounce is suppressed indefinitely (no ttl); a
 * transient/soft one expires after `SOFT_BOUNCE_TTL_SECONDS` so the address can be retried.
 */
export function buildBounceSuppressionEntry(params: {
  address: string;
  isPermanent: boolean;
  reason: SuppressionReason;
  feedback?: unknown;
  sesMessageId?: string;
  linkedSignalId?: string;
}): SuppressedAddress {
  const { address, isPermanent, reason, feedback, sesMessageId, linkedSignalId } = params;
  return {
    address,
    reason,
    suppressedAt: DateTime.utc().toISO()!,
    ...(!isPermanent ? { ttl: Math.floor(Date.now() / 1000) + SOFT_BOUNCE_TTL_SECONDS } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
    ...(sesMessageId ? { sesMessageId } : {}),
    ...(linkedSignalId ? { linkedSignalId } : {}),
  };
}
