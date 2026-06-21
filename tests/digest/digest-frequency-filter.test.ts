import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { shouldDispatchDigest, buildDigestSubject } from "../../src/digest/digest-frequency-filter.js";

// Known dates:
// 2026-06-21 = Sunday, week 25
// 2026-06-01 = Monday, 1st of month
// 2026-06-15 = Monday, mid-month (15th)

const sunday = DateTime.fromISO("2026-06-21");
const mondayFirst = DateTime.fromISO("2026-06-01");
const mondayMid = DateTime.fromISO("2026-06-15");

describe("shouldDispatchDigest", () => {
  describe("daily", () => {
    it("returns true on any day", () => {
      expect(shouldDispatchDigest("daily", sunday)).toBe(true);
      expect(shouldDispatchDigest("daily", mondayFirst)).toBe(true);
      expect(shouldDispatchDigest("daily", mondayMid)).toBe(true);
    });
  });

  describe("weekly", () => {
    it("returns true on Sunday", () => {
      expect(shouldDispatchDigest("weekly", sunday)).toBe(true);
    });

    it("returns false on Monday", () => {
      expect(shouldDispatchDigest("weekly", mondayFirst)).toBe(false);
    });
  });

  describe("monthly", () => {
    it("returns true on the 1st", () => {
      expect(shouldDispatchDigest("monthly", mondayFirst)).toBe(true);
    });

    it("returns false on a non-1st day", () => {
      expect(shouldDispatchDigest("monthly", sunday)).toBe(false);
    });
  });
});

describe("buildDigestSubject", () => {
  it("daily: includes day name", () => {
    expect(buildDigestSubject("daily", sunday)).toBe("Daily Numaeel Digest for Sunday");
  });

  it("weekly: includes week number", () => {
    expect(buildDigestSubject("weekly", sunday)).toBe("Weekly Numaeel Digest for Week 25");
  });

  it("monthly: includes month name", () => {
    expect(buildDigestSubject("monthly", mondayFirst)).toBe("Monthly Numaeel Digest for June");
  });
});
