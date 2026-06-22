import { describe, it, expect } from "vitest"
import { DateTime } from "luxon"
import { shouldDispatchDigest, buildDigestSubject } from "../../src/digest/digest-frequency-filter.js"

// Known dates:
// 2026-06-21 = Sunday, week 25
// 2026-06-22 = Monday
// 2026-06-24 = Wednesday
// 2026-06-20 = Saturday
// 2026-06-01 = Monday, 1st of month
// 2026-06-15 = Monday, mid-month (15th)

const sunday = DateTime.fromISO("2026-06-21")
const monday = DateTime.fromISO("2026-06-22")
const wednesday = DateTime.fromISO("2026-06-24")
const saturday = DateTime.fromISO("2026-06-20")
const mondayFirst = DateTime.fromISO("2026-06-01")
const mondayMid = DateTime.fromISO("2026-06-15")

describe("shouldDispatchDigest", () => {
  describe("daily", () => {
    it("returns true on Monday, Wednesday, and Saturday", () => {
      expect(shouldDispatchDigest("daily", monday)).toBe(true)
      expect(shouldDispatchDigest("daily", wednesday)).toBe(true)
      expect(shouldDispatchDigest("daily", saturday)).toBe(true)
    })
  })

  describe("weekly", () => {
    it("returns true on Sunday", () => {
      expect(shouldDispatchDigest("weekly", sunday)).toBe(true)
    })

    it("returns false on Monday through Saturday", () => {
      expect(shouldDispatchDigest("weekly", monday)).toBe(false)
      expect(shouldDispatchDigest("weekly", wednesday)).toBe(false)
      expect(shouldDispatchDigest("weekly", saturday)).toBe(false)
    })
  })

  describe("monthly", () => {
    it("returns true on the 1st", () => {
      expect(shouldDispatchDigest("monthly", mondayFirst)).toBe(true)
    })

    it("returns false on 2nd through 31st", () => {
      expect(shouldDispatchDigest("monthly", mondayMid)).toBe(false)
      expect(shouldDispatchDigest("monthly", sunday)).toBe(false)
    })
  })
})

describe("buildDigestSubject", () => {
  it("daily on 2026-06-22 (Monday) → includes day name", () => {
    expect(buildDigestSubject("daily", monday)).toBe("Daily Numaeel Digest for Monday")
  })

  it("weekly on 2026-06-21 (Sunday, Week 25) → includes week number", () => {
    expect(buildDigestSubject("weekly", sunday)).toBe("Weekly Numaeel Digest for Week 25")
  })

  it("monthly on 2026-06-01 → includes month name", () => {
    expect(buildDigestSubject("monthly", mondayFirst)).toBe("Monthly Numaeel Digest for June")
  })
})
