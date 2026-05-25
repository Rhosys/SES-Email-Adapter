import { describe, it, expect } from "vitest";
import { buildCalendarSignalLookupId } from "../../../src/processor/calendar/signal-lookup.js";

// ---------------------------------------------------------------------------
// Property 3: signalLookupId format is deterministic
// Validates: Requirements 3.2
// ---------------------------------------------------------------------------

describe("buildCalendarSignalLookupId — deterministic key construction (Property 3)", () => {
  it.each([
    {
      label: "standard organizer and UID",
      organizerEmail: "alice@example.com",
      veventUid: "uid-123",
      expected: "cal-alice@example.com-uid-123",
    },
    {
      label: "different domain and hyphenated UID",
      organizerEmail: "bob@corp.io",
      veventUid: "event-abc-def",
      expected: "cal-bob@corp.io-event-abc-def",
    },
  ])("$label → $expected", ({ organizerEmail, veventUid, expected }) => {
    expect(buildCalendarSignalLookupId(organizerEmail, veventUid)).toBe(expected);
  });

  it("is deterministic — same inputs always produce same output", () => {
    const a = buildCalendarSignalLookupId("org@test.com", "uid-abc");
    const b = buildCalendarSignalLookupId("org@test.com", "uid-abc");
    expect(a).toBe(b);
  });
});
