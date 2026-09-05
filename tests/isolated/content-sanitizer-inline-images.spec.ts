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
      { contentId: "logo", mimeType: "image/png", sizeBytes: 200 * 1024, s3Key: "emails/msg-big-inline/0", filename: "logo.png" },
    ]);
  });

  it("promotes an over-budget inline image to an attachment when its cid is not referenced in the body", async () => {
    // Build a message where the large inline image's cid has NO matching <img> in the HTML.
    // It would otherwise be an invisible InlineImageRef (rendered nowhere, not downloadable);
    // the body-or-attachments invariant promotes it into the attachment list instead.
    const raw = [
      "From: sender@example.com",
      "To: recipient@example.com",
      "Subject: Orphaned inline image",
      "MIME-Version: 1.0",
      `Content-Type: multipart/related; boundary="${BOUNDARY}"`,
      "",
      `--${BOUNDARY}`,
      'Content-Type: text/html; charset="UTF-8"',
      "",
      "<html><body><p>No image tag here.</p></body></html>",
      "",
      `--${BOUNDARY}`,
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <orphan>",
      'Content-Disposition: inline; filename="orphan.png"',
      "",
      Buffer.alloc(200 * 1024, "A").toString("base64"),
      "",
      `--${BOUNDARY}--`,
    ].join("\r\n");
    mockFetch(raw);

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-orphan-inline/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Not left as an inline ref …
    expect(result.parsed.inlineImages).toBeUndefined();
    // … promoted to an attachment, keeping its extension-bearing name.
    expect(result.parsed.attachments).toEqual([
      { filename: "orphan.png", mimeType: "image/png", sizeBytes: 200 * 1024, s3Key: "emails/msg-orphan-inline/0" },
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
      { contentId: "img4", mimeType: "image/png", sizeBytes: 1024, s3Key: "emails/msg-many-inline/0", filename: "img4.png" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Orphaned-inline-image disposition: an over-budget inline image whose cid is
// NOT referenced in the rendered body is either promoted to an attachment (so
// it stays reachable) or dropped as a duplicate of a referenced inline image.
// An orphan is a duplicate when it matches a referenced image by filename OR by
// byte content. The filename case is what Gmail produces: the same logo shipped
// twice, once with a cid the HTML uses and once with a cid it doesn't (see
// PCEHQ.eml). The byte case covers the same image shipped under two different
// filenames. Only over-budget images (>100KB) reach this path — small ones are
// embedded as data URIs and never become InlineImageRefs.
// ---------------------------------------------------------------------------

const OVER_BUDGET = 200 * 1024;

// Builds a multipart/related message with full control over each image part's
// cid, filename, size, and byte fill, plus an explicit list of cids to reference
// from the HTML. This is what buildEmailWithInlineImages can't express — it always
// references every image and derives the filename from the cid. `fill` defaults to
// "A" so two parts of the same size are byte-identical unless given distinct fills.
function buildEmailWithControlledInlineImages(
  images: Array<{ contentId: string; filename: string; size: number; fill?: string }>,
  referencedCids: string[],
): string {
  const parts = images.map(({ contentId, filename, size, fill }) => [
    `--${BOUNDARY}`,
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    `Content-ID: <${contentId}>`,
    `Content-Disposition: inline; filename="${filename}"`,
    "",
    Buffer.alloc(size, fill ?? "A").toString("base64"),
    "",
  ].join("\r\n"));

  const imgTags = referencedCids.map((cid) => `<img src="cid:${cid}">`).join("");

  return [
    "From: sender@example.com",
    "To: recipient@example.com",
    "Subject: Controlled inline images",
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

describe("content-sanitizer — orphaned inline image disposition", () => {
  it("drops an orphaned inline image when its filename matches a referenced inline image (Gmail duplicate logo)", async () => {
    // Two over-budget copies of the same file "logo.png": one cid referenced by
    // the HTML, one orphaned. The orphan must be dropped, not surfaced as a
    // phantom attachment; the referenced copy stays as an inline ref.
    mockFetch(buildEmailWithControlledInlineImages(
      [
        { contentId: "referenced", filename: "logo.png", size: OVER_BUDGET },
        { contentId: "orphan-dup", filename: "logo.png", size: OVER_BUDGET },
      ],
      ["referenced"],
    ));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-dup-inline/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Orphaned duplicate is neither an attachment …
    expect(result.parsed.attachments).toEqual([]);
    // … nor an inline ref — only the referenced copy survives.
    expect(result.parsed.inlineImages).toEqual([
      { contentId: "referenced", mimeType: "image/png", sizeBytes: OVER_BUDGET, s3Key: "emails/msg-dup-inline/0", filename: "logo.png" },
    ]);
  });

  it("promotes an orphaned inline image when its filename is unique (not a duplicate)", async () => {
    // A referenced logo plus an orphan with a DIFFERENT filename. The orphan is
    // genuinely unique content, so it must be promoted to an attachment rather
    // than dropped.
    mockFetch(buildEmailWithControlledInlineImages(
      [
        { contentId: "referenced", filename: "logo.png", size: OVER_BUDGET, fill: "A" },
        { contentId: "orphan-unique", filename: "diagram.png", size: OVER_BUDGET, fill: "B" },
      ],
      ["referenced"],
    ));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-unique-orphan/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Unique orphan is promoted to an attachment …
    expect(result.parsed.attachments).toEqual([
      { filename: "diagram.png", mimeType: "image/png", sizeBytes: OVER_BUDGET, s3Key: "emails/msg-unique-orphan/1" },
    ]);
    // … while the referenced copy remains an inline ref.
    expect(result.parsed.inlineImages).toEqual([
      { contentId: "referenced", mimeType: "image/png", sizeBytes: OVER_BUDGET, s3Key: "emails/msg-unique-orphan/0", filename: "logo.png" },
    ]);
  });

  it("drops every orphaned duplicate when several share a referenced filename", async () => {
    // One referenced copy, two orphaned copies, all named "banner.png". Both
    // orphans are dropped; nothing is promoted.
    mockFetch(buildEmailWithControlledInlineImages(
      [
        { contentId: "referenced", filename: "banner.png", size: OVER_BUDGET },
        { contentId: "orphan-a", filename: "banner.png", size: OVER_BUDGET },
        { contentId: "orphan-b", filename: "banner.png", size: OVER_BUDGET },
      ],
      ["referenced"],
    ));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-multi-dup/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.attachments).toEqual([]);
    expect(result.parsed.inlineImages).toEqual([
      { contentId: "referenced", mimeType: "image/png", sizeBytes: OVER_BUDGET, s3Key: "emails/msg-multi-dup/0", filename: "banner.png" },
    ]);
  });

  it("promotes an orphan whose filename matches only another ORPHAN, not a referenced image", async () => {
    // Two orphans share "shared.png" but neither is referenced by the HTML. The
    // dedup key is referenced-image filenames only, so with no referenced copy
    // to dedup against, both orphans are promoted — the body-or-attachments
    // invariant still holds (they'd otherwise render nowhere and be unreachable).
    mockFetch(buildEmailWithControlledInlineImages(
      [
        { contentId: "orphan-1", filename: "shared.png", size: OVER_BUDGET },
        { contentId: "orphan-2", filename: "shared.png", size: OVER_BUDGET },
      ],
      [],
    ));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-orphan-only/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.attachments).toEqual([
      { filename: "shared.png", mimeType: "image/png", sizeBytes: OVER_BUDGET, s3Key: "emails/msg-orphan-only/0" },
      { filename: "shared.png", mimeType: "image/png", sizeBytes: OVER_BUDGET, s3Key: "emails/msg-orphan-only/1" },
    ]);
    expect(result.parsed.inlineImages).toBeUndefined();
  });

  it("drops an orphaned inline image that is byte-identical to a referenced one under a different filename", async () => {
    // Same bytes (both default "A" fill, same size), DIFFERENT filenames, so the filename
    // check alone would miss it. The byte-content tier catches the duplicate and drops it.
    mockFetch(buildEmailWithControlledInlineImages(
      [
        { contentId: "referenced", filename: "logo.png", size: OVER_BUDGET },
        { contentId: "orphan-samebytes", filename: "picture.png", size: OVER_BUDGET },
      ],
      ["referenced"],
    ));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-bytedup/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.attachments).toEqual([]);
    expect(result.parsed.inlineImages).toEqual([
      { contentId: "referenced", mimeType: "image/png", sizeBytes: OVER_BUDGET, s3Key: "emails/msg-bytedup/0", filename: "logo.png" },
    ]);
  });

  it("promotes an orphan of the same size but different bytes as unique content", async () => {
    // Same size as the referenced image (so tier-1 length check cannot separate them) but a
    // different byte fill — the sampled-bytes tier detects the difference and the orphan is
    // promoted, never dropped. Guards against the tiered check falsely matching on length.
    mockFetch(buildEmailWithControlledInlineImages(
      [
        { contentId: "referenced", filename: "logo.png", size: OVER_BUDGET, fill: "A" },
        { contentId: "orphan-diffbytes", filename: "other.png", size: OVER_BUDGET, fill: "B" },
      ],
      ["referenced"],
    ));

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-diffbytes/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.attachments).toEqual([
      { filename: "other.png", mimeType: "image/png", sizeBytes: OVER_BUDGET, s3Key: "emails/msg-diffbytes/1" },
    ]);
    expect(result.parsed.inlineImages).toEqual([
      { contentId: "referenced", mimeType: "image/png", sizeBytes: OVER_BUDGET, s3Key: "emails/msg-diffbytes/0", filename: "logo.png" },
    ]);
  });
});
