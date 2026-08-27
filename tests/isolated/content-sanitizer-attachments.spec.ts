import { describe, it, expect, vi, afterEach } from "vitest";
import { handler } from "../../src/isolated/content-sanitizer.js";

// ---------------------------------------------------------------------------
// Oversized attachments were previously silently dropped: filtered out of the
// upload loop with no log line and no trace in the response, so there was no
// way to tell a "message with no attachments" apart from a "message whose
// attachment got silently discarded for being too big." These tests pin the
// current behaviour: dropped attachments must be reported in the response and
// logged as a TRACK.
// ---------------------------------------------------------------------------

const BOUNDARY = "----=_Part_oversized_boundary";

function buildEmailWithOversizedAttachment(attachmentSize: number): string {
  const attachment = Buffer.alloc(attachmentSize, "A");
  return [
    "From: sender@example.com",
    "To: recipient@example.com",
    "Subject: Message with a huge attachment",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    "",
    `--${BOUNDARY}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "See attached.",
    "",
    `--${BOUNDARY}`,
    "Content-Type: application/octet-stream",
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="huge.bin"',
    "",
    attachment.toString("base64"),
    "",
    `--${BOUNDARY}--`,
  ].join("\r\n");
}

function mockFetch(raw: string) {
  const buf = Buffer.from(raw, "utf-8");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://example.com/get") {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }
    // presigned POST upload — shouldn't be reached for an oversized attachment
    return { ok: true, status: 204 };
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("content-sanitizer — oversized attachments", () => {
  it("drops an attachment over the single-attachment size limit and reports it in the response", async () => {
    mockFetch(buildEmailWithOversizedAttachment(11 * 1024 * 1024)); // > 10MB MAX_SINGLE_ATTACHMENT_SIZE

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-oversized/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.parsed.attachments).toEqual([]);
    expect(result.parsed.droppedAttachments).toEqual([
      { filename: "huge.bin", mimeType: "application/octet-stream", sizeBytes: 11 * 1024 * 1024, reason: "too_large" },
    ]);
  });

  it("emits a TRACK log naming the dropped attachment count and reason", async () => {
    mockFetch(buildEmailWithOversizedAttachment(11 * 1024 * 1024));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-oversized/",
      retentionTag: null,
      invocationId: "inv-attachments-dropped",
    });

    const trackEntry = logSpy.mock.calls
      .map(call => call[0])
      .find((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).code === "content_sanitizer.attachments_dropped");

    expect(trackEntry).toBeDefined();
    expect(trackEntry).toMatchObject({ level: "TRACK", droppedCount: 1 });
  });

  it("does not drop attachments within the single-attachment size limit", async () => {
    mockFetch(buildEmailWithOversizedAttachment(1024)); // well under the 10MB limit

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-small/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.parsed.attachments).toHaveLength(1);
    expect(result.parsed.droppedAttachments).toBeUndefined();
  });
});

describe("content-sanitizer — upload failures", () => {
  function mockFetchWithFailingUpload(raw: string) {
    const buf = Buffer.from(raw, "utf-8");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://example.com/get") {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      }
      // presigned POST upload fails with a realistic S3 error body
      return {
        ok: false,
        status: 403,
        text: async () => "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
      };
    }));
  }

  it("captures the S3 failure detail and surfaces it in the log title, not just 'upload_failed'", async () => {
    mockFetchWithFailingUpload(buildEmailWithOversizedAttachment(1024));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-upload-failed/",
      retentionTag: null,
      invocationId: "inv-upload-failed",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.parsed.droppedAttachments).toEqual([
      {
        filename: "huge.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1024,
        reason: "upload_failed",
        detail: "HTTP 403: <Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
      },
    ]);

    const trackEntry = logSpy.mock.calls
      .map(call => call[0])
      .find((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).code === "content_sanitizer.attachments_dropped");

    expect(trackEntry).toBeDefined();
    const title = (trackEntry as Record<string, unknown>).title;
    expect(typeof title).toBe("string");
    expect(title as string).toContain("AccessDenied");
    expect(title as string).toContain("Request has expired");
  });
});
