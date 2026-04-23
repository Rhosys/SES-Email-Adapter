import { describe, it, expect } from "vitest";
import { evaluateFilter, getETLD1, computeReputationScore, SPAM_SCORE_THRESHOLD, MIN_REPUTATION_SIGNALS, REPUTATION_BLOCK_THRESHOLD } from "./filter.js";
import type { EmailAddressConfig, GlobalSenderReputation } from "../types/index.js";

const LOW_SPAM = 0.1;
const HIGH_SPAM = SPAM_SCORE_THRESHOLD + 0.1;

function makeReputation(overrides: Partial<GlobalSenderReputation> = {}): GlobalSenderReputation {
  return {
    domain: "spam.com",
    signalCount: MIN_REPUTATION_SIGNALS,
    spamCount: 0,
    blockCount: 0,
    lastSeenAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

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
// evaluateFilter
// ---------------------------------------------------------------------------

describe("evaluateFilter", () => {
  describe("null config (brand new address)", () => {
    it("always allows and flags autoApprove", () => {
      const result = evaluateFilter(null, "anyone.com", LOW_SPAM);
      expect(result).toEqual({ allowed: true, autoApprove: true });
    });

    it("allows even high-spam signals (first-time exemption)", () => {
      const result = evaluateFilter(null, "spam.com", HIGH_SPAM);
      expect(result).toEqual({ allowed: true, autoApprove: true });
    });
  });

  describe("notify_new mode (default)", () => {
    it("allows a known sender", () => {
      const result = evaluateFilter(makeConfig(), "amazon.com", LOW_SPAM);
      expect(result).toEqual({ allowed: true, autoApprove: false });
    });

    it("blocks an unknown sender", () => {
      const result = evaluateFilter(makeConfig(), "unknown.com", LOW_SPAM);
      expect(result).toEqual({ allowed: false, reason: "new_sender" });
    });

    it("allows a known sender even with high spam score", () => {
      const result = evaluateFilter(makeConfig(), "amazon.com", HIGH_SPAM);
      expect(result).toEqual({ allowed: true, autoApprove: false });
    });
  });

  describe("sender_match mode", () => {
    const config = makeConfig({ filterMode: "sender_match" });

    it("allows a known sender regardless of spam", () => {
      expect(evaluateFilter(config, "amazon.com", HIGH_SPAM)).toEqual({ allowed: true, autoApprove: false });
    });

    it("blocks an unknown sender", () => {
      expect(evaluateFilter(config, "phisher.com", LOW_SPAM)).toEqual({ allowed: false, reason: "new_sender" });
    });
  });

  describe("strict mode", () => {
    const config = makeConfig({ filterMode: "strict" });

    it("allows a known sender with low spam", () => {
      expect(evaluateFilter(config, "amazon.com", LOW_SPAM)).toEqual({ allowed: true, autoApprove: false });
    });

    it("blocks a known sender with spam score at or above threshold", () => {
      expect(evaluateFilter(config, "amazon.com", HIGH_SPAM)).toEqual({ allowed: false, reason: "spam" });
      expect(evaluateFilter(config, "amazon.com", SPAM_SCORE_THRESHOLD)).toEqual({ allowed: false, reason: "spam" });
    });

    it("blocks an unknown sender", () => {
      expect(evaluateFilter(config, "unknown.com", LOW_SPAM)).toEqual({ allowed: false, reason: "new_sender" });
    });
  });

  describe("allow_all mode", () => {
    const config = makeConfig({ filterMode: "allow_all" });

    it("allows any sender, no autoApprove when sender is already known", () => {
      expect(evaluateFilter(config, "amazon.com", HIGH_SPAM)).toEqual({ allowed: true, autoApprove: false });
    });

    it("allows unknown sender and sets autoApprove", () => {
      expect(evaluateFilter(config, "new.com", LOW_SPAM)).toEqual({ allowed: true, autoApprove: true });
    });
  });
});

// ---------------------------------------------------------------------------
// allowNewAddresses = false
// ---------------------------------------------------------------------------

describe("allowNewAddresses = false", () => {
  const opts = { allowNewAddresses: false, defaultFilterMode: "notify_new" } as const;

  it("blocks new address from unknown sender instead of auto-allowing", () => {
    expect(evaluateFilter(null, "newdomain.com", LOW_SPAM, opts)).toEqual({
      allowed: false,
      reason: "new_sender",
    });
  });

  it("allows new address sender when defaultFilterMode is allow_all", () => {
    const result = evaluateFilter(null, "anyone.com", LOW_SPAM, {
      allowNewAddresses: false,
      defaultFilterMode: "allow_all",
    });
    expect(result).toEqual({ allowed: true, autoApprove: true });
  });

  it("still allows when sender is in approvedSenders (existing config)", () => {
    const config = makeConfig({ approvedSenders: ["amazon.com"] });
    expect(evaluateFilter(config, "amazon.com", LOW_SPAM, opts)).toEqual({ allowed: true, autoApprove: false });
  });

  it("allowNewAddresses = true (default) still auto-allows new addresses", () => {
    expect(evaluateFilter(null, "anyone.com", LOW_SPAM, { allowNewAddresses: true })).toEqual({
      allowed: true,
      autoApprove: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Global reputation
// ---------------------------------------------------------------------------

describe("computeReputationScore", () => {
  it("returns 0 when signal count is below minimum", () => {
    expect(computeReputationScore(makeReputation({ signalCount: MIN_REPUTATION_SIGNALS - 1 }))).toBe(0);
  });

  it("computes score from spam + weighted block count", () => {
    const rep = makeReputation({ signalCount: 10, spamCount: 6, blockCount: 4 });
    // (6 + 4*0.5) / 10 = 0.8
    expect(computeReputationScore(rep)).toBe(0.8);
  });

  it("caps at 1.0", () => {
    expect(computeReputationScore(makeReputation({ signalCount: 5, spamCount: 10, blockCount: 10 }))).toBe(1);
  });
});

describe("evaluateFilter — global reputation", () => {
  const badRep = makeReputation({
    signalCount: 20,
    spamCount: 16,
    blockCount: 0,
    // score = 16/20 = 0.8 > REPUTATION_BLOCK_THRESHOLD
  });

  it("global deny verdict blocks even account-approved senders", () => {
    const config = makeConfig({ approvedSenders: ["amazon.com"] });
    const rep = makeReputation({ domain: "amazon.com", verdict: "deny" });
    expect(evaluateFilter(config, "amazon.com", LOW_SPAM, { reputation: rep })).toEqual({
      allowed: false,
      reason: "reputation",
    });
  });

  it("global allow verdict overrides account-level blocking of unknown sender", () => {
    const config = makeConfig({ filterMode: "notify_new", approvedSenders: [] });
    const rep = makeReputation({ verdict: "allow" });
    expect(evaluateFilter(config, "newdomain.com", LOW_SPAM, { reputation: rep })).toEqual({
      allowed: true,
      autoApprove: false,
    });
  });

  it("high reputation score blocks an unknown sender on a known address", () => {
    const config = makeConfig({ approvedSenders: ["trusted.com"] });
    expect(evaluateFilter(config, "spammer.com", LOW_SPAM, { reputation: badRep })).toEqual({
      allowed: false,
      reason: "reputation",
    });
  });

  it("high reputation score does NOT block a sender already in approvedSenders", () => {
    const config = makeConfig({ approvedSenders: ["amazon.com"] });
    const rep = makeReputation({ domain: "amazon.com", signalCount: 20, spamCount: 16, blockCount: 0 });
    expect(evaluateFilter(config, "amazon.com", LOW_SPAM, { reputation: rep })).toEqual({
      allowed: true,
      autoApprove: false,
    });
  });

  it("blocks new address from high-reputation sender even with allowNewAddresses = true", () => {
    expect(evaluateFilter(null, "spammer.com", LOW_SPAM, { reputation: badRep })).toEqual({
      allowed: false,
      reason: "reputation",
    });
  });

  it("insufficient data (below minimum signals) is treated as clean", () => {
    const thinRep = makeReputation({
      signalCount: MIN_REPUTATION_SIGNALS - 1,
      spamCount: MIN_REPUTATION_SIGNALS - 1,
      blockCount: 0,
    });
    expect(evaluateFilter(null, "newdomain.com", LOW_SPAM, { reputation: thinRep })).toEqual({
      allowed: true,
      autoApprove: true,
    });
  });

  it("reputation score exactly at threshold is blocked", () => {
    const borderRep = makeReputation({
      signalCount: 10,
      spamCount: Math.round(REPUTATION_BLOCK_THRESHOLD * 10),
      blockCount: 0,
    });
    expect(evaluateFilter(null, "borderline.com", LOW_SPAM, { reputation: borderRep })).toEqual({
      allowed: false,
      reason: "reputation",
    });
  });
});
