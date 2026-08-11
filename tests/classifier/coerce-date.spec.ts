import { describe, it, expect } from "vitest";
import { coerceDate } from "../../src/classifier/coerce-workflow-data.js";

const RECEIVED_AT = "2024-06-15T10:00:00Z";

describe("coerceDate", () => {
  // ---------------------------------------------------------------------------
  // ISO 8601 parsing
  // ---------------------------------------------------------------------------

  describe("ISO 8601", () => {
    it("date only → YYYY-MM-DD", () => {
      expect(coerceDate("2025-03-15", RECEIVED_AT)).toBe("2025-03-15");
    });

    it("date+time without offset → YYYY-MM-DDTHH:mm", () => {
      expect(coerceDate("2025-03-15T14:30", RECEIVED_AT)).toBe("2025-03-15T14:30");
    });

    it("date+time+Z → preserves offset as +00:00", () => {
      expect(coerceDate("2025-03-15T14:30:00Z", RECEIVED_AT)).toBe("2025-03-15T14:30+00:00");
    });

    it("date+time+positive offset → preserves offset", () => {
      expect(coerceDate("2025-03-15T14:30:00+02:00", RECEIVED_AT)).toBe("2025-03-15T14:30+02:00");
    });

    it("date+time+negative offset → preserves offset", () => {
      expect(coerceDate("2025-03-15T14:30:00-05:00", RECEIVED_AT)).toBe("2025-03-15T14:30-05:00");
    });

    it("date+time with seconds, no offset → drops seconds in output", () => {
      expect(coerceDate("2025-03-15T14:30:45", RECEIVED_AT)).toBe("2025-03-15T14:30");
    });
  });

  // ---------------------------------------------------------------------------
  // Human-readable formats with year
  // ---------------------------------------------------------------------------

  describe("human-readable with year", () => {
    it("d MMMM yyyy → YYYY-MM-DD", () => {
      expect(coerceDate("15 March 2025", RECEIVED_AT)).toBe("2025-03-15");
    });

    it("MMMM d, yyyy → YYYY-MM-DD", () => {
      expect(coerceDate("March 15, 2025", RECEIVED_AT)).toBe("2025-03-15");
    });

    it("d MMM yyyy → YYYY-MM-DD", () => {
      expect(coerceDate("15 Mar 2025", RECEIVED_AT)).toBe("2025-03-15");
    });

    it("MMM d, yyyy → YYYY-MM-DD", () => {
      expect(coerceDate("Mar 15, 2025", RECEIVED_AT)).toBe("2025-03-15");
    });

    it("dd.MM.yyyy (European dot) → YYYY-MM-DD", () => {
      expect(coerceDate("15.03.2025", RECEIVED_AT)).toBe("2025-03-15");
    });

    it("d MMMM yyyy HH:mm → YYYY-MM-DDTHH:mm", () => {
      expect(coerceDate("15 March 2025 14:30", RECEIVED_AT)).toBe("2025-03-15T14:30");
    });

    it("MMMM d, yyyy h:mm a → YYYY-MM-DDTHH:mm", () => {
      expect(coerceDate("March 15, 2025 2:30 PM", RECEIVED_AT)).toBe("2025-03-15T14:30");
    });
  });

  // ---------------------------------------------------------------------------
  // Year-free formats (resolve to next occurrence after receivedAt)
  // ---------------------------------------------------------------------------

  describe("year-free resolution", () => {
    it("d MMMM — future month resolves to same year", () => {
      expect(coerceDate("15 August", RECEIVED_AT)).toBe("2024-08-15");
    });

    it("d MMMM — past month resolves to next year", () => {
      expect(coerceDate("15 March", RECEIVED_AT)).toBe("2025-03-15");
    });

    it("MMMM d — future date in same year", () => {
      expect(coerceDate("December 25", RECEIVED_AT)).toBe("2024-12-25");
    });

    it("d MMM — future date", () => {
      expect(coerceDate("1 Jul", RECEIVED_AT)).toBe("2024-07-01");
    });

    it("MMM d — past → next year", () => {
      expect(coerceDate("Jan 5", RECEIVED_AT)).toBe("2025-01-05");
    });

    it("d MMMM with time → resolves year and preserves time", () => {
      expect(coerceDate("15 August 14:30", RECEIVED_AT)).toBe("2024-08-15T14:30");
    });

    it("same day as receivedAt — strictly after means next year", () => {
      expect(coerceDate("15 June", RECEIVED_AT)).toBe("2025-06-15");
    });
  });

  // ---------------------------------------------------------------------------
  // Slash-separated rejection
  // ---------------------------------------------------------------------------

  describe("slash-separated numeric dates → null", () => {
    it("rejects dd/MM/yyyy", () => {
      expect(coerceDate("15/03/2025", RECEIVED_AT)).toBeNull();
    });

    it("rejects MM/dd/yyyy", () => {
      expect(coerceDate("03/15/2025", RECEIVED_AT)).toBeNull();
    });

    it("rejects d/M/yy", () => {
      expect(coerceDate("3/5/25", RECEIVED_AT)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Non-string and unparseable values → null
  // ---------------------------------------------------------------------------

  describe("invalid inputs → null", () => {
    it("null → null", () => {
      expect(coerceDate(null, RECEIVED_AT)).toBeNull();
    });

    it("undefined → null", () => {
      expect(coerceDate(undefined, RECEIVED_AT)).toBeNull();
    });

    it("number → null", () => {
      expect(coerceDate(42, RECEIVED_AT)).toBeNull();
    });

    it("empty string → null", () => {
      expect(coerceDate("", RECEIVED_AT)).toBeNull();
    });

    it("gibberish → null", () => {
      expect(coerceDate("next Tuesday", RECEIVED_AT)).toBeNull();
    });

    it("object → null", () => {
      expect(coerceDate({ date: "2025-03-15" }, RECEIVED_AT)).toBeNull();
    });
  });
});
