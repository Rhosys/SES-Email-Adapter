import { describe, it, expect } from "vitest";
import { evaluateFilter, getETLD1, DEFAULT_SPAM_SCORE_THRESHOLD } from "./filter.js";
import type { EmailAddressConfig } from "../types/index.js";

const LOW_SPAM = 0.1;
const HIGH_SPAM = DEFAULT_SPAM_SCORE_THRESHOLD + 0.01;

function makeConfig(overrides: Partial<EmailAddressConfig> = {}): EmailAddressConfig {
  return {
    id: "cfg-001",
    accountId: "acct-001",
    address: "me@mydomain.com",
    filterMode: "notify_new",
    approvedSenders: ["amazon.com"],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getETLD1
// ---------------------------------------------------------------------------

describe("getETLD1", () => {
  it("extracts eTLD+1 from a plain email address", () => {
    expect(getETLD1("user@mail.amazon.co.uk")).toBe("amazon.co.uk");
  });

  it("extracts eTLD+1 from a subdomain email", () => {
    expect(getETLD1("noreply@accounts.google.com")).toBe("google.com");
  });

  it("works with a bare domain (no @)", () => {
    expect(getETLD1("evil.attacker.com")).toBe("attacker.com");
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — null config (brand new address)
// ---------------------------------------------------------------------------

describe("evaluateFilter — null config (brand new address)", () => {
  it("auto_allow (default): always allows and sets autoApprove", () => {
    expect(evaluateFilter(null, "anyone.com", LOW_SPAM)).toEqual({ allowed: true, autoApprove: true });
  });

  it("auto_allow: allows even high-spam signals on first contact", () => {
    expect(evaluateFilter(null, "spam.com", HIGH_SPAM)).toEqual({ allowed: true, autoApprove: true });
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — newAddressHandling: "block_until_approved"
// ---------------------------------------------------------------------------

describe("evaluateFilter — newAddressHandling: block_until_approved", () => {
  const opts = { newAddressHandling: "block_until_approved" } as const;

  it("blocks new address from any sender instead of auto-allowing", () => {
    expect(evaluateFilter(null, "newdomain.com", LOW_SPAM, opts)).toEqual({
      allowed: false,
      reason: "new_sender",
    });
  });

  it("allows new address sender when defaultFilterMode is allow_all", () => {
    expect(evaluateFilter(null, "anyone.com", LOW_SPAM, {
      newAddressHandling: "block_until_approved",
      defaultFilterMode: "allow_all",
    })).toEqual({ allowed: true, autoApprove: true });
  });

  it("still allows when the address already has a config with that sender approved", () => {
    const config = makeConfig({ approvedSenders: ["amazon.com"] });
    expect(evaluateFilter(config, "amazon.com", LOW_SPAM, opts)).toEqual({ allowed: true, autoApprove: false });
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — notify_new mode (default)
// ---------------------------------------------------------------------------

describe("evaluateFilter — notify_new mode", () => {
  it("allows a known sender", () => {
    expect(evaluateFilter(makeConfig(), "amazon.com", LOW_SPAM)).toEqual({ allowed: true, autoApprove: false });
  });

  it("blocks an unknown sender", () => {
    expect(evaluateFilter(makeConfig(), "unknown.com", LOW_SPAM)).toEqual({ allowed: false, reason: "new_sender" });
  });

  it("allows a known sender even with high spam score", () => {
    expect(evaluateFilter(makeConfig(), "amazon.com", HIGH_SPAM)).toEqual({ allowed: true, autoApprove: false });
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — sender_match mode
// ---------------------------------------------------------------------------

describe("evaluateFilter — sender_match mode", () => {
  const config = makeConfig({ filterMode: "sender_match" });

  it("allows a known sender regardless of spam", () => {
    expect(evaluateFilter(config, "amazon.com", HIGH_SPAM)).toEqual({ allowed: true, autoApprove: false });
  });

  it("blocks an unknown sender", () => {
    expect(evaluateFilter(config, "phisher.com", LOW_SPAM)).toEqual({ allowed: false, reason: "new_sender" });
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — strict mode
// ---------------------------------------------------------------------------

describe("evaluateFilter — strict mode", () => {
  const config = makeConfig({ filterMode: "strict" });

  it("allows a known sender with low spam", () => {
    expect(evaluateFilter(config, "amazon.com", LOW_SPAM)).toEqual({ allowed: true, autoApprove: false });
  });

  it("blocks a known sender with spam score at or above threshold", () => {
    expect(evaluateFilter(config, "amazon.com", HIGH_SPAM)).toEqual({ allowed: false, reason: "spam" });
    expect(evaluateFilter(config, "amazon.com", DEFAULT_SPAM_SCORE_THRESHOLD)).toEqual({ allowed: false, reason: "spam" });
  });

  it("blocks an unknown sender", () => {
    expect(evaluateFilter(config, "unknown.com", LOW_SPAM)).toEqual({ allowed: false, reason: "new_sender" });
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — allow_all mode
// ---------------------------------------------------------------------------

describe("evaluateFilter — allow_all mode", () => {
  const config = makeConfig({ filterMode: "allow_all" });

  it("allows any sender; no autoApprove when sender already known", () => {
    expect(evaluateFilter(config, "amazon.com", HIGH_SPAM)).toEqual({ allowed: true, autoApprove: false });
  });

  it("allows unknown sender and sets autoApprove", () => {
    expect(evaluateFilter(config, "new.com", LOW_SPAM)).toEqual({ allowed: true, autoApprove: true });
  });
});

// ---------------------------------------------------------------------------
// getETLD1 — additional edge cases
// ---------------------------------------------------------------------------

describe("getETLD1 — edge cases", () => {
  it("falls back to the raw domain string for unrecognized TLDs (e.g. .internal)", () => {
    // getDomain returns null for private/non-ICANN TLDs; getETLD1 uses the raw string
    expect(getETLD1("service@api.internal")).toBe("api.internal");
  });

  it("extracts eTLD+1 when local part contains a dot", () => {
    expect(getETLD1("first.last@subdomain.example.com")).toBe("example.com");
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — per-address spamScoreThreshold override
// ---------------------------------------------------------------------------

describe("evaluateFilter — per-address spamScoreThreshold", () => {
  it("blocks known sender in strict mode when score exceeds the lower per-address threshold", () => {
    const config = makeConfig({ filterMode: "strict", spamScoreThreshold: 0.5 });
    // 0.6 > per-address threshold (0.5), below default (0.9)
    expect(evaluateFilter(config, "amazon.com", 0.6)).toEqual({ allowed: false, reason: "spam" });
  });

  it("allows known sender in strict mode when score is above default but below the higher per-address threshold", () => {
    const config = makeConfig({ filterMode: "strict", spamScoreThreshold: 0.99 });
    // 0.95 > default threshold (0.9) but < per-address threshold (0.99)
    expect(evaluateFilter(config, "amazon.com", 0.95)).toEqual({ allowed: true, autoApprove: false });
  });

  it("opts.spamScoreThreshold takes precedence over emailConfig.spamScoreThreshold", () => {
    const config = makeConfig({ filterMode: "strict", spamScoreThreshold: 0.5 });
    // emailConfig says block at 0.5, but opts raises threshold to 0.8 → 0.6 passes
    expect(evaluateFilter(config, "amazon.com", 0.6, { spamScoreThreshold: 0.8 })).toEqual({ allowed: true, autoApprove: false });
  });

  it("threshold of 0 causes strict mode to block any known sender regardless of spam score", () => {
    const config = makeConfig({ filterMode: "strict" });
    // score 0.0 >= threshold 0 → spam
    expect(evaluateFilter(config, "amazon.com", 0.0, { spamScoreThreshold: 0 })).toEqual({ allowed: false, reason: "spam" });
  });

  it("threshold of 1 means no email ever reaches the spam threshold in strict mode", () => {
    const config = makeConfig({ filterMode: "strict" });
    // score must be >= 1.0 to trigger spam; 0.99 < 1.0 → allowed
    expect(evaluateFilter(config, "amazon.com", 0.99, { spamScoreThreshold: 1 })).toEqual({ allowed: true, autoApprove: false });
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — allow_all is immune to spam scoring
// ---------------------------------------------------------------------------

describe("evaluateFilter — allow_all ignores spam threshold", () => {
  const config = makeConfig({ filterMode: "allow_all" });

  it("allows a known sender even when spam score is well above the default threshold", () => {
    expect(evaluateFilter(config, "amazon.com", 0.99)).toEqual({ allowed: true, autoApprove: false });
  });

  it("allows an unknown sender with above-threshold spam and still sets autoApprove", () => {
    expect(evaluateFilter(config, "spammy.biz", 0.99)).toEqual({ allowed: true, autoApprove: true });
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — notify_new with empty approvedSenders
// ---------------------------------------------------------------------------

describe("evaluateFilter — notify_new with empty approvedSenders", () => {
  it("blocks every sender when no one has been approved yet", () => {
    const config = makeConfig({ filterMode: "notify_new", approvedSenders: [] });
    expect(evaluateFilter(config, "amazon.com", LOW_SPAM)).toEqual({ allowed: false, reason: "new_sender" });
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter — block_until_approved × strict: spam check only fires for known senders
// ---------------------------------------------------------------------------

describe("evaluateFilter — block_until_approved with strict defaultFilterMode", () => {
  it("returns new_sender (not spam) for unknown sender even when spam score is very high", () => {
    // In evaluateWithMode: the unknown-sender check runs before the spam check.
    // null config means approvedSenders=[] so every sender is unknown → new_sender wins.
    expect(evaluateFilter(null, "amazon.com", HIGH_SPAM, {
      newAddressHandling: "block_until_approved",
      defaultFilterMode: "strict",
    })).toEqual({ allowed: false, reason: "new_sender" });
  });
});
