import { getDomain } from "tldts";
import type { EmailAddressConfig, SenderFilterMode, BlockReason, GlobalSenderReputation } from "../types/index.js";

export const SPAM_SCORE_THRESHOLD = 0.5;

// Minimum signal observations before reputation score is trusted
export const MIN_REPUTATION_SIGNALS = 5;
// Reputation score above this threshold blocks the sender (0–1, higher = spammier)
export const REPUTATION_BLOCK_THRESHOLD = 0.7;

export type FilterResult =
  | { allowed: true; autoApprove: boolean }
  | { allowed: false; reason: BlockReason };

export interface FilterOptions {
  // When false, new addresses (no EmailAddressConfig yet) no longer get a
  // first-contact free pass — they are evaluated with an empty approved-sender
  // list and the account's defaultFilterMode instead.
  allowNewAddresses?: boolean;
  defaultFilterMode?: SenderFilterMode;
  reputation?: GlobalSenderReputation | null;
}

// Extract eTLD+1 from an email address or domain string
export function getETLD1(emailOrDomain: string): string {
  const domain = emailOrDomain.includes("@")
    ? emailOrDomain.split("@").pop()!
    : emailOrDomain;
  return getDomain(domain) ?? domain;
}

// Reputation score: 0 = clean, 1 = definitely spam.
// Returns 0 when the domain has too little history to be reliable.
export function computeReputationScore(rep: GlobalSenderReputation): number {
  if (rep.signalCount < MIN_REPUTATION_SIGNALS) return 0;
  return Math.min(1, (rep.spamCount + rep.blockCount * 0.5) / rep.signalCount);
}

export function evaluateFilter(
  emailConfig: EmailAddressConfig | null,
  senderETLD1: string,
  spamScore: number,
  opts: FilterOptions = {},
): FilterResult {
  const { reputation, allowNewAddresses = true, defaultFilterMode = "notify_new" } = opts;

  // Explicit global deny always blocks — even account-approved senders.
  if (reputation?.verdict === "deny") {
    return { allowed: false, reason: "reputation" };
  }

  if (!emailConfig) {
    if (!allowNewAddresses) {
      // No first-contact exemption: treat like a known address with empty approved list.
      return evaluateWithMode(defaultFilterMode, [], senderETLD1, spamScore, reputation);
    }

    // Default first-contact exemption: allow, but check reputation as a safety net.
    if (reputation && computeReputationScore(reputation) >= REPUTATION_BLOCK_THRESHOLD) {
      return { allowed: false, reason: "reputation" };
    }
    return { allowed: true, autoApprove: true };
  }

  // Explicit global allow overrides account-level blocking (but not a global deny, handled above).
  if (reputation?.verdict === "allow") {
    return { allowed: true, autoApprove: false };
  }

  return evaluateWithMode(emailConfig.filterMode, emailConfig.approvedSenders, senderETLD1, spamScore, reputation);
}

function evaluateWithMode(
  mode: SenderFilterMode,
  approvedSenders: string[],
  senderETLD1: string,
  spamScore: number,
  reputation?: GlobalSenderReputation | null,
): FilterResult {
  const senderKnown = approvedSenders.includes(senderETLD1);

  if (mode === "allow_all") {
    return { allowed: true, autoApprove: !senderKnown };
  }

  if (!senderKnown) {
    // Reputation score only applies to unknown senders.
    if (reputation && computeReputationScore(reputation) >= REPUTATION_BLOCK_THRESHOLD) {
      return { allowed: false, reason: "reputation" };
    }
    return { allowed: false, reason: "new_sender" };
  }

  // Known sender: strict mode also enforces spam threshold.
  if (mode === "strict" && spamScore >= SPAM_SCORE_THRESHOLD) {
    return { allowed: false, reason: "spam" };
  }

  return { allowed: true, autoApprove: false };
}
