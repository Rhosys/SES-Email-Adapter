import { getDomain } from "tldts";
import type { EmailAddressConfig, SenderFilterMode, BlockReason } from "../types/index.js";

export const SPAM_SCORE_THRESHOLD = 0.5;

export type FilterResult =
  | { allowed: true; autoApprove: boolean }
  | { allowed: false; reason: BlockReason };

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
): FilterResult {
  // Brand new address (no config yet): always allow and auto-approve the sender
  if (!emailConfig) {
    return { allowed: true, autoApprove: true };
  }

  const senderKnown = emailConfig.approvedSenders.includes(senderETLD1);

  // allow_all: always pass through, auto-approve unknown senders
  if (emailConfig.filterMode === "allow_all") {
    return { allowed: true, autoApprove: !senderKnown };
  }

  // All other modes: block if sender is unknown
  if (!senderKnown) {
    return { allowed: false, reason: "new_sender" };
  }

  // Sender is known. strict mode also enforces spam threshold.
  if (emailConfig.filterMode === "strict" && spamScore >= SPAM_SCORE_THRESHOLD) {
    return { allowed: false, reason: "spam" };
  }

  return { allowed: true, autoApprove: false };
}

// Resolve effective filter mode given an optional per-address config and account default
export function resolveFilterMode(
  emailConfig: EmailAddressConfig | null,
  accountDefault: SenderFilterMode | undefined,
): SenderFilterMode {
  return emailConfig?.filterMode ?? accountDefault ?? "notify_new";
}
