/** Centralised tag prefix — single source of truth for the codename namespace. */
export const TAG_PREFIX = "X-Numaeel-";

/** Pre-built tag name constants for use in feedback processing. */
export const TAG_TYPE = `${TAG_PREFIX}Type`;
export const TAG_ACCOUNT_ID = `${TAG_PREFIX}AccountId`;
export const TAG_SIGNAL_ID = `${TAG_PREFIX}SignalId`;
export const TAG_ARC_ID = `${TAG_PREFIX}ArcId`;

export interface TagContext {
  accountId?: string;
  signalId?: string;
  arcId?: string;
}

export type OutboundType = "reply" | "forward" | "draft-send";

/**
 * Build the full set of SES message tags for an outbound email.
 * Omits correlation tags whose values are empty/undefined.
 */
export function buildOutboundTags(
  type: OutboundType,
  context?: TagContext,
): Array<{ Name: string; Value: string }> {
  const tags: Array<{ Name: string; Value: string }> = [
    { Name: TAG_TYPE, Value: type },
  ];

  if (context?.accountId) {
    tags.push({ Name: TAG_ACCOUNT_ID, Value: context.accountId });
  }
  if (context?.signalId) {
    tags.push({ Name: TAG_SIGNAL_ID, Value: context.signalId });
  }
  if (context?.arcId) {
    tags.push({ Name: TAG_ARC_ID, Value: context.arcId });
  }

  return tags;
}
