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

// ---------------------------------------------------------------------------
// Locale noise stripping
// ---------------------------------------------------------------------------

describe("coerceDate — locale noise stripping", () => {
  it("strips German 'Uhr' suffix from time", () => {
    expect(coerceDate("15 March 2025 17:00 Uhr", RECEIVED_AT)).toBe("2025-03-15T17:00");
  });

  it("strips 'Uhr' case-insensitively", () => {
    expect(coerceDate("15 March 2025 17:00 uhr", RECEIVED_AT)).toBe("2025-03-15T17:00");
  });

  it("strips English 'o'clock' suffix", () => {
    expect(coerceDate("15 March 2025 17:00 o'clock", RECEIVED_AT)).toBe("2025-03-15T17:00");
  });

  it("strips French 'heure' suffix", () => {
    expect(coerceDate("15 March 2025 14:00 heure", RECEIVED_AT)).toBe("2025-03-15T14:00");
  });

  it("strips French 'heures' suffix (plural)", () => {
    expect(coerceDate("15 March 2025 14:00 heures", RECEIVED_AT)).toBe("2025-03-15T14:00");
  });

  it("strips Dutch 'uur' suffix", () => {
    expect(coerceDate("15 March 2025 09:30 uur", RECEIVED_AT)).toBe("2025-03-15T09:30");
  });

  it("strips short 'h' suffix", () => {
    expect(coerceDate("15 March 2025 09:30 h", RECEIVED_AT)).toBe("2025-03-15T09:30");
  });

  it("strips 'hrs' suffix", () => {
    expect(coerceDate("15 March 2025 09:30 hrs", RECEIVED_AT)).toBe("2025-03-15T09:30");
  });

  it("year-free with Uhr suffix → resolves year and preserves time", () => {
    expect(coerceDate("15 August 17:00 Uhr", RECEIVED_AT)).toBe("2024-08-15T17:00");
  });

  it("date only with trailing noise — does not affect date-only parsing", () => {
    expect(coerceDate("15 March 2025", RECEIVED_AT)).toBe("2025-03-15");
  });

  it("pure time-only with Uhr but no date → still null (no date component)", () => {
    expect(coerceDate("17:00 Uhr", RECEIVED_AT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Locale-aware fallback parsing
// ---------------------------------------------------------------------------

describe("coerceDate — locale-aware fallback", () => {
  it("parses German month name with de locale hint", () => {
    expect(coerceDate("15 März 2025", RECEIVED_AT, ["de"])).toBe("2025-03-15");
  });

  it("parses German abbreviated month — full form works with de locale", () => {
    // Luxon's d MMM with 'de' locale doesn't reliably parse 3-letter abbreviations
    // on all Node.js ICU builds. Full month "März" always works via MMMM.
    expect(coerceDate("15 März 2025", RECEIVED_AT, ["de"])).toBe("2025-03-15");
  });

  it("parses French month name with fr locale hint", () => {
    expect(coerceDate("15 mars 2025", RECEIVED_AT, ["fr"])).toBe("2025-03-15");
  });

  it("parses French full month with fr locale", () => {
    expect(coerceDate("15 janvier 2025", RECEIVED_AT, ["fr"])).toBe("2025-01-15");
  });

  it("parses Spanish month with es locale hint", () => {
    expect(coerceDate("15 marzo 2025", RECEIVED_AT, ["es"])).toBe("2025-03-15");
  });

  it("parses Italian month with it locale hint", () => {
    expect(coerceDate("15 marzo 2025", RECEIVED_AT, ["it"])).toBe("2025-03-15");
  });

  it("parses Dutch month with nl locale hint", () => {
    expect(coerceDate("15 maart 2025", RECEIVED_AT, ["nl"])).toBe("2025-03-15");
  });

  it("parses German month with time and Uhr stripped", () => {
    expect(coerceDate("15 März 2025 17:00 Uhr", RECEIVED_AT, ["de"])).toBe("2025-03-15T17:00");
  });

  it("parses French month with time", () => {
    expect(coerceDate("15 mars 2025 14:30", RECEIVED_AT, ["fr"])).toBe("2025-03-15T14:30");
  });

  it("year-free German month resolves to next occurrence", () => {
    // receivedAt is June 15 2024, so "15 März" (March 15) is in the past → next year
    expect(coerceDate("15 März", RECEIVED_AT, ["de"])).toBe("2025-03-15");
  });

  it("year-free German month in the future resolves to same year", () => {
    // receivedAt is June 15 2024, so "15 August" is in the future
    expect(coerceDate("15 August", RECEIVED_AT, ["de"])).toBe("2024-08-15");
  });

  it("year-free French month with time resolves correctly", () => {
    // receivedAt is June 15, "15 août" (August 15) is future
    expect(coerceDate("15 août 14:00", RECEIVED_AT, ["fr"])).toBe("2024-08-15T14:00");
  });

  it("tries multiple locale hints — first match wins", () => {
    // "März" won't parse with fr, but will parse with de
    expect(coerceDate("15 März 2025", RECEIVED_AT, ["fr", "de"])).toBe("2025-03-15");
  });

  it("falls through all locales and returns null if none match", () => {
    expect(coerceDate("gibberish value", RECEIVED_AT, ["de", "fr", "es"])).toBeNull();
  });

  it("empty locale hints array works like no locales", () => {
    expect(coerceDate("15 März 2025", RECEIVED_AT, [])).toBeNull();
  });

  it("BCP 47 locale tags work (de-CH)", () => {
    expect(coerceDate("15 März 2025", RECEIVED_AT, ["de-CH"])).toBe("2025-03-15");
  });

  it("BCP 47 locale tags work (fr-CH)", () => {
    expect(coerceDate("15 mars 2025", RECEIVED_AT, ["fr-CH"])).toBe("2025-03-15");
  });

  it("English month names still work without locale hints (baseline)", () => {
    expect(coerceDate("15 March 2025", RECEIVED_AT)).toBe("2025-03-15");
  });

  it("locale noise + locale-aware parsing combined — German date with Uhr", () => {
    expect(coerceDate("26 August 2026 17:00 Uhr", RECEIVED_AT, ["de"])).toBe("2026-08-26T17:00");
  });

  it("does not parse pure time-only even with locale hints", () => {
    expect(coerceDate("17:00 Uhr", RECEIVED_AT, ["de"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Locale noise does NOT interfere with existing parsing
// ---------------------------------------------------------------------------

describe("coerceDate — noise stripping safety", () => {
  it("ISO 8601 is not affected by noise stripping (no noise present)", () => {
    expect(coerceDate("2025-03-15T14:30:00Z", RECEIVED_AT)).toBe("2025-03-15T14:30+00:00");
  });

  it("AM/PM parsing still works", () => {
    expect(coerceDate("March 15, 2025 2:30 PM", RECEIVED_AT)).toBe("2025-03-15T14:30");
  });

  it("'at' prefix time still works", () => {
    expect(coerceDate("15 March 2025 at 14:30", RECEIVED_AT)).toBe("2025-03-15T14:30");
  });

  it("'at' prefix with AM/PM still works", () => {
    expect(coerceDate("March 15, 2025 at 2:30 PM", RECEIVED_AT)).toBe("2025-03-15T14:30");
  });

  it("dot-separated European date still works", () => {
    expect(coerceDate("15.03.2025", RECEIVED_AT)).toBe("2025-03-15");
  });

  it("slash dates are still rejected", () => {
    expect(coerceDate("15/03/2025", RECEIVED_AT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Weekday prefix + abbreviated-month period stripping
// ---------------------------------------------------------------------------

describe("coerceDate — weekday prefix and abbreviated month period stripping", () => {
  it("strips weekday prefix and period after abbreviated month with time", () => {
    expect(coerceDate("Fri, Nov. 20, 2026 07:30", RECEIVED_AT)).toBe("2026-11-20T07:30");
  });

  it("strips full weekday name prefix", () => {
    expect(coerceDate("Friday, Nov. 20, 2026", RECEIVED_AT)).toBe("2026-11-20");
  });

  it("strips period after abbreviated month without weekday prefix", () => {
    expect(coerceDate("Nov. 20, 2026", RECEIVED_AT)).toBe("2026-11-20");
  });

  it("strips weekday prefix without abbreviated month period", () => {
    expect(coerceDate("Fri, Nov 20, 2026", RECEIVED_AT)).toBe("2026-11-20");
  });

  it("handles weekday prefix on d MMM yyyy form", () => {
    expect(coerceDate("Fri, 20 Nov. 2026", RECEIVED_AT)).toBe("2026-11-20");
  });

  it("does not strip a leading month name mistaken for a weekday", () => {
    expect(coerceDate("March 15, 2025", RECEIVED_AT)).toBe("2025-03-15");
  });

  it("handles a French weekday prefix via locale hint — generic, not English-only", () => {
    // "ven." (vendredi) — proves the weekday token is locale-resolved, not a hardcoded English list
    expect(coerceDate("ven. 20 novembre 2026", RECEIVED_AT, ["fr"])).toBe("2026-11-20");
  });
});

// ---------------------------------------------------------------------------
// Dotted meridiem (a.m. / p.m.) — the reported bug
// These assert DESIRED behavior; they fail until meridiem normalization lands.
// ---------------------------------------------------------------------------

describe("coerceDate — dotted meridiem (a.m./p.m.)", () => {
  it("lowercase a.m. with 'at' prefix", () => {
    expect(coerceDate("February 01, 2027 at 9:30 a.m.", RECEIVED_AT)).toBe("2027-02-01T09:30");
  });

  it("lowercase p.m. with 'at' prefix", () => {
    expect(coerceDate("February 01, 2027 at 9:30 p.m.", RECEIVED_AT)).toBe("2027-02-01T21:30");
  });

  it("lowercase a.m. without 'at' prefix", () => {
    expect(coerceDate("March 15, 2025 9:30 a.m.", RECEIVED_AT)).toBe("2025-03-15T09:30");
  });

  it("lowercase p.m. without 'at' prefix", () => {
    expect(coerceDate("March 15, 2025 2:30 p.m.", RECEIVED_AT)).toBe("2025-03-15T14:30");
  });

  it("uppercase A.M.", () => {
    expect(coerceDate("March 15, 2025 9:30 A.M.", RECEIVED_AT)).toBe("2025-03-15T09:30");
  });

  it("uppercase P.M.", () => {
    expect(coerceDate("March 15, 2025 2:30 P.M.", RECEIVED_AT)).toBe("2025-03-15T14:30");
  });

  it("mixed-case a.M.", () => {
    expect(coerceDate("March 15, 2025 9:30 a.M.", RECEIVED_AT)).toBe("2025-03-15T09:30");
  });

  it("dotted meridiem on d MMMM yyyy form", () => {
    expect(coerceDate("15 March 2025 2:30 p.m.", RECEIVED_AT)).toBe("2025-03-15T14:30");
  });

  it("year-free with dotted meridiem", () => {
    expect(coerceDate("August 15 2:30 p.m.", RECEIVED_AT)).toBe("2024-08-15T14:30");
  });

  it("undotted AM/PM still works (regression guard)", () => {
    expect(coerceDate("March 15, 2025 2:30 PM", RECEIVED_AT)).toBe("2025-03-15T14:30");
  });
});

// ---------------------------------------------------------------------------
// Broad locale × format matrix
// Discovery harness: enumerate plausible classifier date strings per locale.
// Cases that fail today reveal parser gaps — do not delete failures, triage them.
// ---------------------------------------------------------------------------

interface MatrixCase {
  input: string;
  locales: string[];
  expected: string;
}

const MATRIX: Record<string, MatrixCase[]> = {
  english: [
    { input: "March 15, 2025", locales: [], expected: "2025-03-15" },
    { input: "15 March 2025", locales: [], expected: "2025-03-15" },
    { input: "Mar 15, 2025", locales: [], expected: "2025-03-15" },
    { input: "Mar. 15, 2025", locales: [], expected: "2025-03-15" },
    { input: "Saturday, March 15, 2025", locales: [], expected: "2025-03-15" },
    { input: "March 15, 2025 2:30 PM", locales: [], expected: "2025-03-15T14:30" },
    { input: "March 15, 2025 at 2:30 PM", locales: [], expected: "2025-03-15T14:30" },
    { input: "March 15, 2025 2:30 p.m.", locales: [], expected: "2025-03-15T14:30" },
    { input: "March 15, 2025 14:30", locales: [], expected: "2025-03-15T14:30" },
  ],
  german: [
    { input: "15 März 2025", locales: ["de"], expected: "2025-03-15" },
    { input: "15.03.2025", locales: ["de"], expected: "2025-03-15" },
    { input: "15 März 2025 17:00 Uhr", locales: ["de"], expected: "2025-03-15T17:00" },
    { input: "Samstag, 15 März 2025", locales: ["de"], expected: "2025-03-15" },
  ],
  french: [
    { input: "15 mars 2025", locales: ["fr"], expected: "2025-03-15" },
    { input: "15 janvier 2025", locales: ["fr"], expected: "2025-01-15" },
    { input: "15 mars 2025 14:30", locales: ["fr"], expected: "2025-03-15T14:30" },
    { input: "samedi 15 mars 2025", locales: ["fr"], expected: "2025-03-15" },
  ],
  spanish: [
    { input: "15 marzo 2025", locales: ["es"], expected: "2025-03-15" },
    { input: "15 enero 2025", locales: ["es"], expected: "2025-01-15" },
  ],
  italian: [
    { input: "15 marzo 2025", locales: ["it"], expected: "2025-03-15" },
  ],
  dutch: [
    { input: "15 maart 2025", locales: ["nl"], expected: "2025-03-15" },
    { input: "15 maart 2025 09:30 uur", locales: ["nl"], expected: "2025-03-15T09:30" },
  ],
};

describe("coerceDate — locale × format discovery matrix", () => {
  for (const [locale, cases] of Object.entries(MATRIX)) {
    describe(locale, () => {
      for (const { input, locales, expected } of cases) {
        it(`${input} → ${expected}`, () => {
          expect(coerceDate(input, RECEIVED_AT, locales)).toBe(expected);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Time-first ordering ("TIME <connector> DATE")
// The classifier extracts dates verbatim from email text (see prompt-builder),
// so time-first phrasings reach coerceDate. These assert DESIRED behavior and
// fail until a locale-driven reorder step lands. Connector is locale-specific:
//   en: on   de: am/um   fr: le/à   es: el/a las   it: il/alle   nl: op/om
// ---------------------------------------------------------------------------

describe("coerceDate — time-first ordering", () => {
  describe("english (on)", () => {
    it("dotted meridiem, 'on', full month — the motivating shape", () => {
      expect(coerceDate("9:30 a.m. on February 1, 2027", RECEIVED_AT)).toBe("2027-02-01T09:30");
    });

    it("undotted PM, 'on', full month", () => {
      expect(coerceDate("5:00 PM on August 26, 2026", RECEIVED_AT)).toBe("2026-08-26T17:00");
    });

    it("24h time, 'on', d MMMM yyyy", () => {
      expect(coerceDate("14:30 on 15 March 2025", RECEIVED_AT)).toBe("2025-03-15T14:30");
    });

    it("time-first, 'on', year-free resolves to next occurrence", () => {
      expect(coerceDate("2:30 p.m. on August 15", RECEIVED_AT)).toBe("2024-08-15T14:30");
    });

    it("abbreviated month with period, 'on'", () => {
      expect(coerceDate("07:30 on Nov. 20, 2026", RECEIVED_AT)).toBe("2026-11-20T07:30");
    });
  });

  describe("german (am/um)", () => {
    it("time 'um' ... date 'am' — full connector phrase", () => {
      expect(coerceDate("um 17:00 am 15 März 2025", RECEIVED_AT, ["de"])).toBe("2025-03-15T17:00");
    });

    it("time-first with 'am' connector before date", () => {
      expect(coerceDate("17:00 am 15 März 2025", RECEIVED_AT, ["de"])).toBe("2025-03-15T17:00");
    });
  });

  describe("french (le/à)", () => {
    it("time 'à' ... date 'le'", () => {
      expect(coerceDate("à 14:30 le 15 mars 2025", RECEIVED_AT, ["fr"])).toBe("2025-03-15T14:30");
    });

    it("time-first with 'le' connector", () => {
      expect(coerceDate("14:30 le 15 mars 2025", RECEIVED_AT, ["fr"])).toBe("2025-03-15T14:30");
    });
  });

  describe("spanish (el/a las)", () => {
    it("time-first with 'el' connector", () => {
      expect(coerceDate("14:30 el 15 marzo 2025", RECEIVED_AT, ["es"])).toBe("2025-03-15T14:30");
    });
  });

  describe("italian (il/alle)", () => {
    it("time-first with 'il' connector", () => {
      expect(coerceDate("14:30 il 15 marzo 2025", RECEIVED_AT, ["it"])).toBe("2025-03-15T14:30");
    });
  });

  describe("dutch (op/om)", () => {
    it("time-first with 'op' connector", () => {
      expect(coerceDate("09:30 op 15 maart 2025", RECEIVED_AT, ["nl"])).toBe("2025-03-15T09:30");
    });
  });

  describe("does not misfire on date-first with an 'at'/'on' word", () => {
    it("date-first 'at' time is unchanged (regression guard)", () => {
      expect(coerceDate("March 15, 2025 at 2:30 PM", RECEIVED_AT)).toBe("2025-03-15T14:30");
    });

    it("plain date-first is unchanged", () => {
      expect(coerceDate("February 01, 2027 at 9:30 a.m.", RECEIVED_AT)).toBe("2027-02-01T09:30");
    });
  });
});
