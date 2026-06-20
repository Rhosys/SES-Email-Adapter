// Closed vocabulary of recognized spam-related tags.
// The classifier validates LLM output against this list — unknown tags are logged and discarded.
// Adding a new tag: append here. No migration needed.
export const SPAM_TAGS = [
  "phishing",
  "bulk-unsolicited",
  "spoofed-sender",
  "tracking-heavy",
  "deceptive-subject",
  "credential-harvest",
  "malware-link",
  "impersonation",
  "urgency-manipulation",
  "hidden-content",
  "known-spam-domain",
  "pump-and-dump",
  "lottery-scam",
  "advance-fee",
  "sextortion",
  "pharming",
] as const;

export type SpamTag = (typeof SPAM_TAGS)[number];
