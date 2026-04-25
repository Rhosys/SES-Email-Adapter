import { getDomain } from "tldts";
import type { EmailAddressConfig, SenderFilterMode, BlockReason, NewAddressHandling } from "../types/index.js";

export const SPAM_SCORE_THRESHOLD = 0.5;

export type FilterResult =
  | { allowed: true; autoApprove: boolean }
  | { allowed: false; reason: BlockReason };

export interface FilterOptions {
  newAddressHandling?: NewAddressHandling;  // default "auto_allow"
  defaultFilterMode?: SenderFilterMode;    // used when newAddressHandling is "block_until_approved"
}

// Extract eTLD+1 from an email address or domain string
export function getETLD1(emailOrDomain: string): string {
  const domain = emailOrDomain.includes("@")
    ? emailOrDomain.split("@").pop()!
    : emailOrDomain;
  return getDomain(domain) ?? domain;
}

export function evaluateFilter(
  emailConfig: EmailAddressConfig | null,
  senderETLD1: string,
  spamScore: number,
  opts: FilterOptions = {},
): FilterResult {
  const { newAddressHandling = "auto_allow", defaultFilterMode = "notify_new" } = opts;

  if (!emailConfig) {
    if (newAddressHandling === "block_until_approved") {
      // Treat like a known address with an empty approved-sender list.
      return evaluateWithMode(defaultFilterMode, [], senderETLD1, spamScore);
    }
    // Default: first contact always allowed; auto-approve the sender.
    return { allowed: true, autoApprove: true };
  }

  return evaluateWithMode(emailConfig.filterMode, emailConfig.approvedSenders, senderETLD1, spamScore);
}

function evaluateWithMode(
  mode: SenderFilterMode,
  approvedSenders: string[],
  senderETLD1: string,
  spamScore: number,
): FilterResult {
  const senderKnown = approvedSenders.includes(senderETLD1);

  if (mode === "allow_all") {
    return { allowed: true, autoApprove: !senderKnown };
  }

  if (!senderKnown) {
    return { allowed: false, reason: "new_sender" };
  }

  // Known sender: strict mode also enforces spam threshold.
  if (mode === "strict" && spamScore >= SPAM_SCORE_THRESHOLD) {
    return { allowed: false, reason: "spam" };
  }

  return { allowed: true, autoApprove: false };
}
