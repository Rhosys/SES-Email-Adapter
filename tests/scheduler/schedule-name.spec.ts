import { describe, it, expect } from "vitest";
import { buildScheduleName } from "../../src/scheduler/schedule-name.js";

/**
 * Property 1: Schedule name is always valid
 * Validates: Requirements 7.3, 7.4, 8.2, 8.3, 8.4
 *
 * For any accountId, signalId, and suffix (composed of [0-9a-zA-Z-_.]),
 * the output matches ^[0-9a-zA-Z-_.]+$ and length ≤ 64.
 * When combined length ≤ 64, output equals {accountId}.{signalId}.{suffix}.
 */

const VALID_PATTERN = /^[0-9a-zA-Z\-_.]+$/;
const MAX_LENGTH = 64;

describe("buildScheduleName — normal case", () => {
  it("short inputs produce {accountId}.{signalId}.{suffix}", () => {
    expect(buildScheduleName("acc-abc", "sgn-xyz", "followup")).toBe("acc-abc.sgn-xyz.followup");
  });

  it("calendar suffix produces dotted format", () => {
    expect(buildScheduleName("acc-abc", "sgn-xyz", "calendar.20250715")).toBe("acc-abc.sgn-xyz.calendar.20250715");
  });

  it("single-char inputs produce correct format", () => {
    expect(buildScheduleName("a", "b", "c")).toBe("a.b.c");
  });
});

describe("buildScheduleName — truncation", () => {
  it("combined length > 64 triggers hash-slice suffix", () => {
    const accountId = "acc-long-account-id";
    const signalId = "sgn-long-signal-identifier";
    const suffix = "very-long-suffix-that-will-definitely-exceed-64-chars";

    const result = buildScheduleName(accountId, signalId, suffix);
    // Should NOT be the naive concatenation
    expect(result).not.toBe(`${accountId}.${signalId}.${suffix}`);
    // But must still start with the prefix
    expect(result.startsWith(`${accountId}.${signalId}.`)).toBe(true);
  });

  it("truncated suffix uses base64url characters only", () => {
    const result = buildScheduleName("acc-12345678", "sgn-12345678", "a".repeat(60));
    // base64url uses [A-Za-z0-9_-] which is a subset of the allowed pattern
    expect(result).toMatch(VALID_PATTERN);
  });
});

describe("buildScheduleName — output always ≤ 64 chars (boundary enumeration)", () => {
  // Deterministic boundary inputs: max-length components that force truncation
  const boundaryCases = [
    { accountId: "a".repeat(20), signalId: "b".repeat(20), suffix: "c".repeat(30), label: "20+20+30" },
    { accountId: "a".repeat(30), signalId: "b".repeat(30), suffix: "c".repeat(30), label: "30+30+30" },
    { accountId: "a".repeat(10), signalId: "b".repeat(10), suffix: "c".repeat(60), label: "10+10+60" },
    { accountId: "a".repeat(1), signalId: "b".repeat(1), suffix: "c".repeat(64), label: "1+1+64" },
    { accountId: "acc-12345", signalId: "sgn-67890", suffix: "calendar.20250715T080000Z.reminder.urgent", label: "realistic long" },
    { accountId: "a".repeat(31), signalId: "b".repeat(31), suffix: "x", label: "31+31+1 (prefix alone near limit)" },
    { accountId: "a".repeat(25), signalId: "b".repeat(25), suffix: "z".repeat(40), label: "25+25+40" },
  ];

  it.each(boundaryCases)("$label → length ≤ 64", ({ accountId, signalId, suffix }) => {
    const result = buildScheduleName(accountId, signalId, suffix);
    expect(result.length).toBeLessThanOrEqual(MAX_LENGTH);
  });
});

describe("buildScheduleName — output matches [0-9a-zA-Z-_.]+", () => {
  // Exhaustive boundary enumeration of input characters that are valid
  const patternCases = [
    { accountId: "acc-123", signalId: "sgn-456", suffix: "followup", label: "alphanumeric + dash" },
    { accountId: "acc_under", signalId: "sgn_score", suffix: "my_suffix", label: "underscores" },
    { accountId: "acc.dot", signalId: "sgn.dot", suffix: "a.b.c", label: "dots in all parts" },
    { accountId: "MiXeD-CaSe", signalId: "SiGnAl", suffix: "SuFfIx", label: "mixed case" },
    { accountId: "0123456789", signalId: "9876543210", suffix: "0000", label: "all digits" },
    { accountId: "a-b_c.d", signalId: "e-f_g.h", suffix: "i-j_k.l", label: "all special chars combined" },
    // Long inputs that trigger truncation — output must still match pattern
    { accountId: "acc-12345678901234", signalId: "sgn-12345678901234", suffix: "x".repeat(50), label: "truncated output" },
    { accountId: "A".repeat(20), signalId: "B".repeat(20), suffix: "C".repeat(40), label: "uppercase truncated" },
  ];

  it.each(patternCases)("$label → matches valid pattern", ({ accountId, signalId, suffix }) => {
    const result = buildScheduleName(accountId, signalId, suffix);
    expect(result).toMatch(VALID_PATTERN);
  });
});

describe("buildScheduleName — passthrough when within limit", () => {
  // Exact boundary: name that is exactly 64 chars should NOT trigger truncation
  it("exactly 64 chars → passthrough (no truncation)", () => {
    // prefix = accountId + "." + signalId + "." = needs careful sizing
    // "acc-1234" (8) + "." (1) + "sgn-5678" (8) + "." (1) + suffix = 18 + suffix
    // 64 - 18 = 46 chars for suffix
    const suffix = "s".repeat(46);
    const result = buildScheduleName("acc-1234", "sgn-5678", suffix);
    expect(result).toBe(`acc-1234.sgn-5678.${suffix}`);
    expect(result.length).toBe(64);
  });

  it("65 chars → triggers truncation", () => {
    // Same prefix (18 chars) + 47 char suffix = 65 total
    const suffix = "s".repeat(47);
    const result = buildScheduleName("acc-1234", "sgn-5678", suffix);
    expect(result).not.toBe(`acc-1234.sgn-5678.${suffix}`);
    expect(result.length).toBeLessThanOrEqual(MAX_LENGTH);
  });
});
