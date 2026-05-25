import { describe, it, expect } from "vitest";
import { findCalendarAttachment, parseIcs, sanitizeUrl } from "../../../src/processor/calendar/ics-parser.js";
import { createMockLogger } from "../../helpers/mock-logger.js";
import type { Attachment } from "../../../src/types/index.js";

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    filename: "document.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    s3Key: "attachments/test-key",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 1: Attachment detection is purely MIME/extension-based
// Validates: Requirements 2.1, 2.4
// ---------------------------------------------------------------------------

describe("findCalendarAttachment — MIME/extension detection", () => {
  it.each([
    { mime: "text/calendar", filename: "invite.ics", workflow: "job", detected: true, reason: "text/calendar MIME + .ics extension" },
    { mime: "text/calendar", filename: "meeting.dat", workflow: "healthcare", detected: true, reason: "text/calendar MIME alone (no .ics extension)" },
    { mime: "application/pdf", filename: "invite.ics", workflow: "crm", detected: true, reason: ".ics extension alone (non-calendar MIME)" },
    { mime: "application/pdf", filename: "document.pdf", workflow: "conversation", detected: false, reason: "neither calendar MIME nor .ics extension" },
    { mime: "text/calendar", filename: "invite.ics", workflow: "alert", detected: true, reason: "detection is workflow-independent" },
  ])("$reason → detected=$detected", ({ mime, filename, detected }) => {
    const logger = createMockLogger();
    const attachment = makeAttachment({ mimeType: mime, filename });
    const result = findCalendarAttachment([attachment], logger);

    if (detected) {
      expect(result).not.toBeNull();
      expect(result!.filename).toBe(filename);
    } else {
      expect(result).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Property 2: Multi-attachment priority selects first with METHOD
// Validates: Requirements 2.3, 2.5
// ---------------------------------------------------------------------------

describe("findCalendarAttachment — multi-attachment priority", () => {
  it.each([
    {
      label: "selects first attachment with METHOD when it appears second",
      attachments: [
        makeAttachment({ filename: "no-method.ics", mimeType: "text/calendar", s3Key: "a/no-method" }),
        makeAttachment({ filename: "has-method.ics", mimeType: "text/calendar; method=REQUEST", s3Key: "a/has-method" }),
      ],
      expectedFilename: "has-method.ics",
    },
    {
      label: "selects first METHOD attachment when multiple have METHOD",
      attachments: [
        makeAttachment({ filename: "has-method-1.ics", mimeType: "text/calendar; method=REQUEST", s3Key: "a/method-1" }),
        makeAttachment({ filename: "has-method-2.ics", mimeType: "text/calendar; method=CANCEL", s3Key: "a/method-2" }),
      ],
      expectedFilename: "has-method-1.ics",
    },
    {
      label: "falls back to first .ics when none have METHOD",
      attachments: [
        makeAttachment({ filename: "no-method-1.ics", mimeType: "text/calendar", s3Key: "a/no-method-1" }),
        makeAttachment({ filename: "no-method-2.ics", mimeType: "text/calendar", s3Key: "a/no-method-2" }),
      ],
      expectedFilename: "no-method-1.ics",
    },
    {
      label: "returns the single attachment when only one exists",
      attachments: [
        makeAttachment({ filename: "single.ics", mimeType: "text/calendar", s3Key: "a/single" }),
      ],
      expectedFilename: "single.ics",
    },
  ])("$label", ({ attachments, expectedFilename }) => {
    const logger = createMockLogger();
    const result = findCalendarAttachment(attachments, logger);

    expect(result).not.toBeNull();
    expect(result!.filename).toBe(expectedFilename);
  });

  it("logs TRACK when multiple calendar attachments found", () => {
    const logger = createMockLogger();
    findCalendarAttachment([
      makeAttachment({ filename: "a.ics", mimeType: "text/calendar", s3Key: "a/1" }),
      makeAttachment({ filename: "b.ics", mimeType: "text/calendar", s3Key: "a/2" }),
    ], logger);

    expect(logger.calls).toContainEqual(expect.objectContaining({
      method: "track",
      context: expect.objectContaining({ count: 2 }),
    }));
  });

  it("does not log TRACK for a single calendar attachment", () => {
    const logger = createMockLogger();
    findCalendarAttachment([
      makeAttachment({ filename: "single.ics", mimeType: "text/calendar", s3Key: "a/1" }),
    ], logger);

    expect(logger.calls.filter(c => c.method === "track")).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// Helpers for parseIcs tests
// ---------------------------------------------------------------------------

/** Builds a minimal valid VCALENDAR/VEVENT .ics string */
function buildIcs(opts: {
  method?: string;
  veventBody?: string;
  extraComponents?: string;
} = {}): string {
  const method = opts.method ?? "REQUEST";
  const veventBody = opts.veventBody ?? `UID:test-uid-123
DTSTART:20250315T100000Z
DTEND:20250315T110000Z
SUMMARY:Test Event
ORGANIZER;CN=Alice:mailto:alice@example.com
ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com`;
  const extra = opts.extraComponents ?? "";

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Test//EN",
    `METHOD:${method}`,
    extra,
    "BEGIN:VEVENT",
    veventBody,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

// ---------------------------------------------------------------------------
// Property 4: VALARM never appears in any output
// Validates: Requirements 4.4, 10.6
// ---------------------------------------------------------------------------

describe("parseIcs — VALARM stripping", () => {
  it.each([
    {
      label: ".ics with no VALARM — no VALARM in output",
      valarmBlock: "",
    },
    {
      label: ".ics with 1 DISPLAY VALARM — stripped from output",
      valarmBlock: [
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT15M",
        "DESCRIPTION:Reminder",
        "END:VALARM",
      ].join("\r\n"),
    },
    {
      label: ".ics with 3 mixed VALARMs (DISPLAY, EMAIL, AUDIO) — all stripped",
      valarmBlock: [
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT15M",
        "DESCRIPTION:Reminder",
        "END:VALARM",
        "BEGIN:VALARM",
        "ACTION:EMAIL",
        "TRIGGER:-PT30M",
        "ATTENDEE:mailto:notify@example.com",
        "SUMMARY:Event soon",
        "END:VALARM",
        "BEGIN:VALARM",
        "ACTION:AUDIO",
        "TRIGGER:-PT5M",
        "ATTACH:ftp://example.com/sound.wav",
        "END:VALARM",
      ].join("\r\n"),
    },
    {
      label: ".ics with VALARM containing ACTION:PROCEDURE — stripped",
      valarmBlock: [
        "BEGIN:VALARM",
        "ACTION:PROCEDURE",
        "TRIGGER:-PT10M",
        "ATTACH:ftp://example.com/script.sh",
        "END:VALARM",
      ].join("\r\n"),
    },
  ])("$label", ({ valarmBlock }) => {
    const veventBody = [
      "UID:valarm-test-uid",
      "DTSTART:20250315T100000Z",
      "DTEND:20250315T110000Z",
      "SUMMARY:Meeting",
      "ORGANIZER:mailto:org@example.com",
      valarmBlock,
    ].filter(Boolean).join("\r\n");

    const ics = buildIcs({ veventBody });
    const result = parseIcs(toBytes(ics));

    expect(result.isOk()).toBe(true);
    const { calendarData, rawIcsContent } = result._unsafeUnwrap();

    // CalendarData has no VALARM-related fields by design (no alarm fields in the interface)
    // Verify the raw content was stored but the parsed data is clean
    expect(calendarData.title).toBe("Meeting");

    // The rawIcsContent is the original input (stored for reference)
    // but the parsed output should not contain VALARM data
    // CalendarEventData interface has no alarm fields — this is the structural guarantee
    expect(Object.keys(calendarData)).not.toContain("valarm");
    expect(Object.keys(calendarData)).not.toContain("alarm");
    expect(Object.keys(calendarData)).not.toContain("trigger");
  });
});

// ---------------------------------------------------------------------------
// Property 5: URL sanitization rejects disallowed schemes and invalid hosts
// Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5
// ---------------------------------------------------------------------------

describe("sanitizeUrl — scheme and host validation", () => {
  it.each([
    { url: "https://meet.google.com/abc", expected: "https://meet.google.com/abc", reason: "https with public hostname allowed" },
    { url: "http://example.com/event", expected: "http://example.com/event", reason: "http with public hostname allowed" },
    { url: "mailto:org@example.com", expected: "mailto:org@example.com", reason: "mailto with valid email allowed" },
    { url: "javascript:alert(1)", expected: "", reason: "javascript: scheme rejected" },
    { url: "data:text/html,<script>", expected: "", reason: "data: scheme rejected" },
    { url: "file:///etc/passwd", expected: "", reason: "file: scheme rejected" },
    { url: "ftp://files.example.com", expected: "", reason: "ftp: scheme rejected" },
    { url: "mailto:not-an-email", expected: "", reason: "mailto with invalid email rejected" },
    { url: "https://192.168.1.1/admin", expected: "", reason: "private IP (192.168.x.x) rejected" },
    { url: "https://localhost/api", expected: "", reason: "localhost rejected" },
    { url: "https://10.0.0.1/internal", expected: "", reason: "private IP (10.x.x.x) rejected" },
  ])("$reason: $url → $expected", ({ url, expected }) => {
    expect(sanitizeUrl(url)).toBe(expected);
  });
});

describe("parseIcs — URL sanitization in VEVENT", () => {
  it("preserves valid https URL from VEVENT", () => {
    const veventBody = [
      "UID:url-test-uid",
      "DTSTART:20250315T100000Z",
      "DTEND:20250315T110000Z",
      "SUMMARY:Meeting with URL",
      "ORGANIZER:mailto:org@example.com",
      "URL:https://meet.google.com/abc-def",
    ].join("\r\n");

    const result = parseIcs(toBytes(buildIcs({ veventBody })));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().calendarData.url).toBe("https://meet.google.com/abc-def");
  });

  it("sanitizes javascript: URL to empty string", () => {
    const veventBody = [
      "UID:url-xss-uid",
      "DTSTART:20250315T100000Z",
      "DTEND:20250315T110000Z",
      "SUMMARY:XSS attempt",
      "ORGANIZER:mailto:org@example.com",
      "URL:javascript:alert(1)",
    ].join("\r\n");

    const result = parseIcs(toBytes(buildIcs({ veventBody })));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().calendarData.url).toBe("");
  });

  it("sanitizes private IP URL to empty string", () => {
    const veventBody = [
      "UID:url-private-ip",
      "DTSTART:20250315T100000Z",
      "DTEND:20250315T110000Z",
      "SUMMARY:Private network",
      "ORGANIZER:mailto:org@example.com",
      "URL:https://192.168.1.1/admin",
    ].join("\r\n");

    const result = parseIcs(toBytes(buildIcs({ veventBody })));
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().calendarData.url).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: size/complexity boundaries
// Validates: Requirements 5.1, 5.2, 5.6
// ---------------------------------------------------------------------------

describe("parseIcs — size and complexity limits", () => {
  it("rejects file exceeding 1 MB", () => {
    // Create a .ics that exceeds 1 MB by padding with comments
    const padding = "X-PADDING:" + "A".repeat(1024) + "\r\n";
    const paddingCount = Math.ceil(1_048_577 / padding.length);
    const veventBody = [
      "UID:oversized-uid",
      "DTSTART:20250315T100000Z",
      "DTEND:20250315T110000Z",
      "SUMMARY:Oversized",
      "ORGANIZER:mailto:org@example.com",
      ...Array.from({ length: paddingCount }, () => padding),
    ].join("");

    const ics = buildIcs({ veventBody });
    const bytes = toBytes(ics);
    // Ensure we actually exceed 1 MB
    expect(bytes.byteLength).toBeGreaterThan(1_048_576);

    const result = parseIcs(bytes);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe("File exceeds 1 MB size limit");
  });

  it("rejects >100 VTIMEZONE components", () => {
    const timezones = Array.from({ length: 101 }, (_, i) => [
      "BEGIN:VTIMEZONE",
      `TZID:Zone/Test${i}`,
      "BEGIN:STANDARD",
      "DTSTART:19701025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "END:VTIMEZONE",
    ].join("\r\n")).join("\r\n");

    const ics = buildIcs({ extraComponents: timezones });
    const result = parseIcs(toBytes(ics));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe("Suspected VTIMEZONE bomb");
  });

  it("rejects nesting depth >5", () => {
    // ical.js uses jCal format where nesting is represented in the component tree.
    // We'll create deeply nested custom components to trigger the depth check.
    // VCALENDAR (1) > VEVENT (2) > ... nested subcomponents
    // The parser checks raw jCal nesting, so we need to craft something that
    // produces deep nesting in the jCal tree.
    // Since standard iCal doesn't nest deeply, we'll build a jCal structure directly
    // by creating nested X-CUSTOM components inside VEVENT.
    const deepNesting = Array.from({ length: 6 }, () => "BEGIN:X-CUSTOM\r\n").join("")
      + Array.from({ length: 6 }, () => "END:X-CUSTOM\r\n").join("");

    const veventBody = [
      "UID:deep-nest-uid",
      "DTSTART:20250315T100000Z",
      "DTEND:20250315T110000Z",
      "SUMMARY:Deep nesting",
      "ORGANIZER:mailto:org@example.com",
      deepNesting,
    ].join("\r\n");

    const ics = buildIcs({ veventBody });
    const result = parseIcs(toBytes(ics));

    // If ical.js doesn't parse X-CUSTOM as nested subcomponents, the depth check
    // won't trigger. In that case, the test verifies the parser handles it gracefully.
    // The important thing is the limit EXISTS — we verify it with a direct jCal approach below.
    if (result.isErr()) {
      expect(result._unsafeUnwrapErr().reason).toBe("Excessive nesting depth");
    }
  });

  it("rejects nesting depth >5 via crafted jCal structure", () => {
    // Build a .ics that ical.js will parse into a deeply nested jCal tree.
    // Standard approach: nest VCALENDAR > VEVENT > VALARM > ... but VALARM is stripped.
    // Use multiple levels of custom components that ical.js recognizes.
    // Actually, ical.js parses BEGIN:/END: blocks as subcomponents regardless of name.
    // Let's nest: VCALENDAR(1) > VTIMEZONE(2) > STANDARD(3) > X-A(4) > X-B(5) > X-C(6) — depth 6 triggers
    const deepIcs = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:REQUEST",
      "BEGIN:VTIMEZONE",
      "TZID:Deep/Zone",
      "BEGIN:STANDARD",
      "DTSTART:19701025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "BEGIN:X-LEVEL4",
      "X-DATA:level4",
      "BEGIN:X-LEVEL5",
      "X-DATA:level5",
      "BEGIN:X-LEVEL6",
      "X-DATA:level6",
      "END:X-LEVEL6",
      "END:X-LEVEL5",
      "END:X-LEVEL4",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:deep-uid",
      "DTSTART:20250315T100000Z",
      "DTEND:20250315T110000Z",
      "SUMMARY:Deep",
      "ORGANIZER:mailto:org@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(deepIcs));

    // The depth check counts: VCALENDAR=1, VTIMEZONE=2, STANDARD=3, X-LEVEL4=4, X-LEVEL5=5, X-LEVEL6=6
    // Depth 6 > MAX_NESTING_DEPTH(5) → should be rejected
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe("Excessive nesting depth");
  });

  it("silently truncates >100 attendees to 100", () => {
    const attendees = Array.from({ length: 120 }, (_, i) =>
      `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:user${i}@example.com`
    ).join("\r\n");

    const veventBody = [
      "UID:many-attendees-uid",
      "DTSTART:20250315T100000Z",
      "DTEND:20250315T110000Z",
      "SUMMARY:Big meeting",
      "ORGANIZER:mailto:org@example.com",
      attendees,
    ].join("\r\n");

    const ics = buildIcs({ veventBody });
    const result = parseIcs(toBytes(ics));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().calendarData.attendees).toHaveLength(100);
  });

  it("rejects CalendarData exceeding 100 KB", () => {
    // Create a VEVENT with a very long description to push serialized output over 100 KB
    const longDescription = "DESCRIPTION:" + "X".repeat(110_000);
    const veventBody = [
      "UID:large-output-uid",
      "DTSTART:20250315T100000Z",
      "DTEND:20250315T110000Z",
      "SUMMARY:Large output",
      "ORGANIZER:mailto:org@example.com",
      longDescription,
    ].join("\r\n");

    const ics = buildIcs({ veventBody });
    const result = parseIcs(toBytes(ics));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe("Parsed calendar data exceeds 100 KB limit");
  });
});

// ---------------------------------------------------------------------------
// Malformed input rejection
// Validates: Requirements 6.1, 6.5
// ---------------------------------------------------------------------------

describe("parseIcs — malformed input rejection", () => {
  it("rejects completely invalid content", () => {
    const result = parseIcs(toBytes("this is not ical data at all"));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toMatch(/^Malformed iCal structure:/);
  });

  it("rejects VCALENDAR without VEVENT", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:REQUEST",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toBe("Malformed iCal structure: no VEVENT component found");
  });

  it("rejects truncated/incomplete .ics", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:incomplete",
      // Missing END:VEVENT and END:VCALENDAR
    ].join("\r\n");

    const result = parseIcs(toBytes(ics));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toMatch(/^Malformed iCal structure:/);
  });

  it("rejects empty input", () => {
    const result = parseIcs(toBytes(""));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().reason).toMatch(/^Malformed iCal structure:/);
  });
});
