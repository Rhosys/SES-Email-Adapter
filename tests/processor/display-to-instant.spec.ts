import { describe, it, expect } from "vitest";
import { displayToInstant } from "../../src/classifier/display-to-instant.js";

/**
 * Regression oracle for the display-string -> UTC-instant conversion.
 *
 * This suite pins the *conversion contract* as its own unit. The expected values
 * are identical to those originally asserted through deriveResourceInfo before
 * the instant computation was moved upstream into the coercer — only the call
 * surface changed (now the canonical displayToInstant function). The (display, tz)
 * -> instant mapping may not change.
 *
 * Invariant being frozen:
 *   - display carries an offset  -> tz ignored, converted directly to UTC
 *   - display has time, no offset -> interpreted in account tz, then UTC
 *   - display is date-only        -> midnight in account tz, then UTC
 *   - display unparseable         -> null
 */

describe("displayToInstant (frozen contract)", () => {
  describe("offset present -> timezone ignored", () => {
    it("positive offset converts directly to UTC", () => {
      expect(displayToInstant("2027-03-15T14:00+02:00", "Europe/London")).toBe("2027-03-15T12:00:00.000Z");
    });

    it("positive offset is tz-independent (same result under a different account tz)", () => {
      expect(displayToInstant("2027-03-15T14:00+02:00", "America/New_York")).toBe("2027-03-15T12:00:00.000Z");
    });

    it("Z offset converts directly to UTC", () => {
      expect(displayToInstant("2027-06-01T08:00+00:00", "America/New_York")).toBe("2027-06-01T08:00:00.000Z");
    });

    it("negative offset converts directly to UTC", () => {
      expect(displayToInstant("2027-03-15T09:00-05:00", "Europe/Zurich")).toBe("2027-03-15T14:00:00.000Z");
    });
  });

  describe("time, no offset -> account timezone applied", () => {
    it("CET winter (+01:00): 14:00 Zurich -> 13:00 UTC", () => {
      expect(displayToInstant("2027-03-15T14:00", "Europe/Zurich")).toBe("2027-03-15T13:00:00.000Z");
    });

    it("London winter (GMT): 09:00 -> 09:00 UTC", () => {
      expect(displayToInstant("2027-01-15T09:00", "Europe/London")).toBe("2027-01-15T09:00:00.000Z");
    });

    it("New York EST (-05:00): 09:00 -> 14:00 UTC", () => {
      expect(displayToInstant("2027-01-15T09:00", "America/New_York")).toBe("2027-01-15T14:00:00.000Z");
    });
  });

  describe("date-only -> midnight in account timezone", () => {
    it("CET winter: midnight Zurich -> 23:00 previous day UTC", () => {
      expect(displayToInstant("2027-03-15", "Europe/Zurich")).toBe("2027-03-14T23:00:00.000Z");
    });

    it("CEST summer (DST, +02:00): midnight Zurich -> 22:00 previous day UTC", () => {
      expect(displayToInstant("2027-07-01", "Europe/Zurich")).toBe("2027-06-30T22:00:00.000Z");
    });

    it("London winter: midnight -> midnight UTC", () => {
      expect(displayToInstant("2027-01-15", "Europe/London")).toBe("2027-01-15T00:00:00.000Z");
    });
  });

  describe("unparseable -> null", () => {
    it("garbage string yields no instant", () => {
      expect(displayToInstant("not-a-date", "Europe/Zurich")).toBeNull();
    });
  });
});
