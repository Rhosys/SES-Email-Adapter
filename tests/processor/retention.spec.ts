import { describe, it, expect } from "vitest";
import {
  retentionToS3Tag,
  durationToSeconds,
  resolveRetention,
  type RetentionDuration,
} from "../../src/processor/retention.js";

describe("retentionToS3Tag", () => {
  it.each([
    ["P1M", "365"],
    ["P2M", "365"],
    ["P3M", "365"],
    ["P5M", "365"],
    ["P6M", "365"],
    ["P1Y", "365"],
    ["P2Y", "3650"],
    ["P5Y", "3650"],
    ["P10Y", "3650"],
    ["P100Y", null],
    ["Infinity", null],
  ] as const)("%s → %s", (duration, expected) => {
    expect(retentionToS3Tag(duration)).toBe(expected);
  });
});

describe("durationToSeconds", () => {
  it.each([
    ["P1M", 30 * 86400],
    ["P2M", 60 * 86400],
    ["P3M", 90 * 86400],
    ["P5M", 150 * 86400],
    ["P6M", 180 * 86400],
    ["P1Y", 365 * 86400],
    ["P2Y", 730 * 86400],
    ["P5Y", 1825 * 86400],
    ["P10Y", 3650 * 86400],
    ["P100Y", 36500 * 86400],
    ["Infinity", null],
  ] as const)("%s → %s seconds", (duration, expected) => {
    expect(durationToSeconds(duration as RetentionDuration)).toBe(expected);
  });
});

describe("resolveRetention", () => {
  it("returns rule override when provided (highest priority)", () => {
    expect(resolveRetention(
      { retentionDuration: "P1Y" },
      { retentionDuration: "P2Y" },
      "P10Y",
    )).toBe("P10Y");
  });

  it("returns alias-level retention when no rule override", () => {
    expect(resolveRetention(
      { retentionDuration: "P1Y" },
      { retentionDuration: "P5Y" },
    )).toBe("P5Y");
  });

  it("returns account-level retention when no alias config", () => {
    expect(resolveRetention(
      { retentionDuration: "P2Y" },
      null,
    )).toBe("P2Y");
  });

  it("returns account-level retention when alias has no retention set", () => {
    expect(resolveRetention(
      { retentionDuration: "P2Y" },
      {},
    )).toBe("P2Y");
  });

  it("returns default P3M when nothing is configured", () => {
    expect(resolveRetention({}, null)).toBe("P3M");
  });

  it("returns default P3M when account and alias have no retention", () => {
    expect(resolveRetention({}, {})).toBe("P3M");
  });
});
