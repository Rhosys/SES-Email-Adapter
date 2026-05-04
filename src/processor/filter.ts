import { getDomain } from "tldts";
import type { Alias, SenderFilterMode, BlockReason, NewAddressHandling } from "../types/index.js";

export const DEFAULT_SPAM_SCORE_THRESHOLD = 0.9;

export type FilterResult =
  | { allowed: true; autoApprove: boolean }
  | { allowed: false; reason: BlockReason };

export interface FilterOptions {
  newAddressHandling?: NewAddressHandling;  // default "auto_allow"
  defaultFilterMode?: SenderFilterMode;    // used when newAddressHandling is "block_until_approved"
  spamScoreThreshold?: number;             // default DEFAULT_SPAM_SCORE_THRESHOLD
}

// Extract eTLD+1 from an email address or domain string
export function getETLD1(emailOrDomain: string): string {
  const domain = emailOrDomain.includes("@")
    ? emailOrDomain.split("@").pop()!
    : emailOrDomain;
  return getDomain(domain) ?? domain;
}

export function evaluateFilter(
  emailConfig: Alias | null,
  senderETLD1: string,
  spamScore: number,
  opts: FilterOptions = {},
): FilterResult {
  const {
    newAddressHandling = "auto_allow",
    defaultFilterMode = "notify_new",
    spamScoreThreshold = emailConfig?.spamScoreThreshold ?? DEFAULT_SPAM_SCORE_THRESHOLD,
  } = opts;

  if (!emailConfig) {
    if (newAddressHandling === "block_until_approved") {
      return evaluateWithMode(defaultFilterMode, [], senderETLD1, spamScore, spamScoreThreshold);
    }
    return { allowed: true, autoApprove: true };
  }

  return evaluateWithMode(emailConfig.filterMode, emailConfig.approvedSenders, senderETLD1, spamScore, spamScoreThreshold);
}

function evaluateWithMode(
  mode: SenderFilterMode,
  approvedSenders: string[],
  senderETLD1: string,
  spamScore: number,
  spamScoreThreshold: number,
): FilterResult {
  const senderKnown = approvedSenders.includes(senderETLD1);

  if (mode === "allow_all") {
    return { allowed: true, autoApprove: !senderKnown };
  }

  if (!senderKnown) {
    return { allowed: false, reason: "new_sender" };
  }

  // Known sender: strict mode also enforces the spam threshold.
  if (mode === "strict" && spamScore >= spamScoreThreshold) {
    return { allowed: false, reason: "spam" };
  }

  return { allowed: true, autoApprove: false };
}
