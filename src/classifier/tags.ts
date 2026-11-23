// Recognized spam-related tags (shown to the LLM in the prompt).
// The LLM may return other tags — those are kept and logged as WARN (classifier.unknown_tag).
// Frequently seen unknown tags can be promoted by appending here. No migration needed.
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
