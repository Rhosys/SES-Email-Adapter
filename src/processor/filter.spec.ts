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
