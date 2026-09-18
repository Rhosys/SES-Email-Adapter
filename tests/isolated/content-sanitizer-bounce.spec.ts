import { describe, it, expect, vi, afterEach } from "vitest";
import { handler } from "../../src/isolated/content-sanitizer.js";

// ---------------------------------------------------------------------------
// RFC 3464 bounce/DSN detection: a `message/delivery-status` part inside a
// `multipart/report` message carries the machine-readable failure details.
// These tests pin the extraction of that part into `result.parsed.bounce`,
// and confirm the delivery-status part itself is never uploaded as a regular
// attachment (it's diagnostic data, not something a user should download).
// ---------------------------------------------------------------------------

const BOUNDARY = "----=_Part_bounce_boundary";

function buildBounceEmail(echoedContentType = "text/plain"): string {
  const echoedHeaders = echoedContentType === "text/calendar"
    ? [
      "From: mindstone@vortex.link",
      "To: no-reply@mindstone.com",
      "Subject: Re: Mindstone Zurich September AI Meetup",
      "Content-Type: text/calendar; method=REPLY",
    ]
    : [
      "From: mindstone@vortex.link",
      "To: no-reply@mindstone.com",
      "Subject: Re: Mindstone Zurich September AI Meetup",
    ];
  return [
    "From: mailer-daemon@mindstone.com",
    "To: no-reply@mindstone.com",
    "Subject: Delivery Status Notification (Failure)",
    "MIME-Version: 1.0",
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${BOUNDARY}"`,
    "",
    `--${BOUNDARY}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Your message wasn't delivered because the group you tried to contact (no-reply) may not exist.",
    "",
    `--${BOUNDARY}`,
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.google.com",
    "",
    "Final-Recipient: rfc822; no-reply@mindstone.com",
    "Original-Recipient: rfc822; no-reply@mindstone.com",
    "Action: failed",
    "Status: 5.1.1",
    "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist",
    "",
    `--${BOUNDARY}`,
    "Content-Type: message/rfc822",
    "",
    ...echoedHeaders,
    "",
    "(original message body)",
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
    return { ok: true, status: 204 };
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("content-sanitizer — bounce/DSN detection", () => {
  it("extracts delivery-status fields into result.parsed.bounce", async () => {
    mockFetch(buildBounceEmail());

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "mindstone.com",
      keyPrefix: "emails/msg-bounce/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.parsed.bounce).toEqual({
      action: "failed",
      status: "5.1.1",
      diagnosticCode: "smtp; 550-5.1.1 The email account that you tried to reach does not exist",
      originalRecipient: "no-reply@mindstone.com",
      finalRecipient: "no-reply@mindstone.com",
    });
  });

  it("does not surface the message/delivery-status part as a regular attachment", async () => {
    mockFetch(buildBounceEmail());

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "mindstone.com",
      keyPrefix: "emails/msg-bounce/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const dsnAttachment = result.parsed.attachments.find(a => a.mimeType === "message/delivery-status");
    expect(dsnAttachment).toBeUndefined();
  });

  it("leaves bounce undefined for an ordinary message with no delivery-status part", async () => {
    const raw = [
      "From: sender@example.com",
      "To: recipient@example.com",
      "Subject: Hello",
      "Content-Type: text/plain; charset=\"utf-8\"",
      "MIME-Version: 1.0",
      "",
      "Just a regular email.",
      "",
    ].join("\r\n");
    mockFetch(raw);

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-normal/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.parsed.bounce).toBeUndefined();
  });

  it("ignores a bounce whose echoed original message was a calendar reply", async () => {
    mockFetch(buildBounceEmail("text/calendar"));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "mindstone.com",
      keyPrefix: "emails/msg-bounce-ics/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.parsed.bounce).toBeUndefined();
  });
});
