import { describe, it, expect } from "vitest";
import { findCalendarAttachment } from "../../../src/processor/calendar/ics-parser.js";
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
