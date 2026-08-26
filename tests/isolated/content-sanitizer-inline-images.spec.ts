import { describe, it, expect, vi, afterEach } from "vitest";
import { handler } from "../../src/isolated/content-sanitizer.js";

// ---------------------------------------------------------------------------
// Inline CID images were previously embedded as base64 data URIs directly in
// htmlBody with no size/count limit — a single large inline logo could bloat
// the stored signal well past DynamoDB's 400KB item cap. Now only small images
// (<=100KB, first 3 per message) are inlined; anything past either cap is
// uploaded to S3 like a regular attachment, with its `cid:` reference left
// unresolved in htmlBody (see MAX_INLINE_DATA_URI_SIZE / MAX_INLINE_DATA_URI_COUNT).
// ---------------------------------------------------------------------------

const BOUNDARY = "----=_Part_inline_boundary";

function buildEmailWithInlineImages(images: Array<{ contentId: string; size: number }>): string {
  const parts = images.map(({ contentId, size }) => [
    `--${BOUNDARY}`,
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    `Content-ID: <${contentId}>`,
    `Content-Disposition: inline; filename="${contentId}.png"`,
    "",
    Buffer.alloc(size, "A").toString("base64"),
    "",
  ].join("\r\n"));

  const imgTags = images.map(({ contentId }) => `<img src="cid:${contentId}">`).join("");

  return [
    "From: sender@example.com",
    "To: recipient@example.com",
    "Subject: Message with inline images",
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${BOUNDARY}"`,
    "",
    `--${BOUNDARY}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    `<html><body>${imgTags}</body></html>`,
    "",
    ...parts,
    `--${BOUNDARY}--`,
  ].join("\r\n");
}

function mockFetch(raw: string) {
  const buf = Buffer.from(raw, "utf-8");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://example.com/get") {
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    return { ok: true, status: 204 };
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content-sanitizer — inline image size/count cap", () => {
  it("embeds a small inline image as a data URI, no S3 upload / inlineImages entry", async () => {
    mockFetch(buildEmailWithInlineImages([{ contentId: "logo", size: 1024 }]));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-small-inline/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.htmlBody).toContain("data:image/png;base64,");
    expect(result.parsed.htmlBody).not.toContain("cid:logo");
    expect(result.parsed.inlineImages).toBeUndefined();
  });

  it("uploads an inline image over 100KB to S3 instead of embedding it, leaving cid: unresolved", async () => {
    mockFetch(buildEmailWithInlineImages([{ contentId: "logo", size: 200 * 1024 }]));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-big-inline/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.htmlBody).toContain("cid:logo");
    expect(result.parsed.htmlBody).not.toContain("data:image/png;base64,");
    expect(result.parsed.inlineImages).toEqual([
      { contentId: "logo", mimeType: "image/png", sizeBytes: 200 * 1024, s3Key: "emails/msg-big-inline/0" },
    ]);
  });

  it("inlines only the first 3 small images per message, routing the 4th to S3", async () => {
    mockFetch(buildEmailWithInlineImages([
      { contentId: "img1", size: 1024 },
      { contentId: "img2", size: 1024 },
      { contentId: "img3", size: 1024 },
      { contentId: "img4", size: 1024 },
    ]));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-many-inline/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.htmlBody).not.toContain("cid:img1");
    expect(result.parsed.htmlBody).not.toContain("cid:img2");
    expect(result.parsed.htmlBody).not.toContain("cid:img3");
    expect(result.parsed.htmlBody).toContain("cid:img4");
    expect(result.parsed.inlineImages).toEqual([
      { contentId: "img4", mimeType: "image/png", sizeBytes: 1024, s3Key: "emails/msg-many-inline/0" },
    ]);
  });
});
