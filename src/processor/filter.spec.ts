import { describe, it, expect } from "vitest";
import { evaluateFilter, getETLD1, SPAM_SCORE_THRESHOLD } from "./filter.js";
import type { EmailAddressConfig } from "../types/index.js";

const LOW_SPAM = 0.1;
const HIGH_SPAM = SPAM_SCORE_THRESHOLD + 0.1;

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
