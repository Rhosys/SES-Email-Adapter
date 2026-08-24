import { describe, it, expect, vi, afterEach } from "vitest";
import { handler } from "../../src/isolated/content-sanitizer.js";

// ---------------------------------------------------------------------------
// A text/plain-only email (no text/html part) must still produce a visible
// body: the processor only persists `htmlBody` on inbound signals, so a
// missing htmlBody here means the message is stored with no content at all.
// ---------------------------------------------------------------------------

const RAW_TEXT_ONLY_EMAIL = [
  "From: Zurich AI Club <contact@zurichai.club>",
  "To: zurichai@vortex.link",
  "Subject: Early access newsletter",
  "Content-Type: text/plain; charset=\"utf-8\"",
  "MIME-Version: 1.0",
  "",
  "Hi everyone,",
  "",
  "Reserve your spot: https://luma.com/p6hfjus6",
  "",
].join("\r\n");

function mockFetchForRawMime(raw: string) {
  const buf = Buffer.from(raw, "utf-8");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content-sanitizer — text/plain-only email", () => {
  it("synthesizes an htmlBody from the text body so the message isn't stored with no content", async () => {
    mockFetchForRawMime(RAW_TEXT_ONLY_EMAIL);

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "zurichai.club",
      keyPrefix: "emails/msg-001/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.parsed.textBody).toContain("Reserve your spot");
    expect(result.parsed.htmlBody).toBeDefined();
    expect(result.parsed.htmlBody).toContain("Reserve your spot");
    // Plain text must be escaped, not interpreted as HTML
    expect(result.parsed.htmlBody).not.toContain("<script");

    // Bare URL fallback extraction still applies alongside the synthesized body
    expect(result.parsed.links).toEqual([{ url: "https://luma.com/p6hfjus6", text: null }]);
  });

  it("escapes HTML-significant characters in the plain text before embedding", async () => {
    const raw = [
      "From: sender@example.com",
      "To: user@example.com",
      "Subject: test",
      "Content-Type: text/plain; charset=\"utf-8\"",
      "MIME-Version: 1.0",
      "",
      "<script>alert(1)</script> & \"quoted\"",
      "",
    ].join("\r\n");
    mockFetchForRawMime(raw);

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-002/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.htmlBody).toContain("&lt;script&gt;");
    expect(result.parsed.htmlBody).not.toContain("<script>alert(1)</script>");
  });
});
