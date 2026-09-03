import { describe, it, expect, vi, afterEach } from "vitest";
import { handler } from "../../src/isolated/content-sanitizer.js";

// ---------------------------------------------------------------------------
// The sanitizer uploads a display-safe copy of the raw MIME (see
// raw-email-display.ts) alongside the extracted attachments, and returns its
// s3Key so the processor can persist it. This is what "view original email" /
// download-as-.eml serves — never the true raw original.
// ---------------------------------------------------------------------------

const RAW_EMAIL_WITH_ATTACHMENT = [
  "From: sender@example.com",
  "To: recipient@example.com",
  "Subject: Test email with attachment",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="----=_Part_boundary"',
  "",
  "------=_Part_boundary",
  'Content-Type: text/plain; charset="UTF-8"',
  "",
  "Body text.",
  "",
  "------=_Part_boundary",
  "Content-Type: application/pdf",
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="document.pdf"',
  "",
  "QQ==".repeat(50),
  "",
  "------=_Part_boundary--",
].join("\r\n");

function mockFetch(raw: string, uploads: Array<{ key: string; body: string }>, forms: FormData[] = []) {
  const buf = Buffer.from(raw, "utf-8");
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (url === "https://example.com/get") {
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    if (url === "https://example.com/post" && init?.body instanceof FormData) {
      forms.push(init.body);
      const key = init.body.get("key") as string;
      const file = init.body.get("file") as File;
      uploads.push({ key, body: await file.text() });
      return { ok: true, status: 204 };
    }
    return { ok: true, status: 204 };
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content-sanitizer — display-safe raw email upload", () => {
  it("uploads a display-safe raw copy with attachments stripped and returns its s3Key", async () => {
    const uploads: Array<{ key: string; body: string }> = [];
    mockFetch(RAW_EMAIL_WITH_ATTACHMENT, uploads);

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-display-raw/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.parsed.displayRawS3Key).toBe("emails/msg-display-raw/raw-display.eml");

    const displayUpload = uploads.find(u => u.key === "emails/msg-display-raw/raw-display.eml");
    expect(displayUpload).toBeDefined();
    expect(displayUpload!.body).toContain("Body text.");
    expect(displayUpload!.body).toContain("[attachment content omitted: document.pdf");
    expect(displayUpload!.body).not.toContain("QQ==QQ==");
  });

  // Regression: the presigned post's `fields` already carries x-amz-tagging when
  // it was signed with a retention tag (see S3ObjectStorage.generatePresignedPost). The
  // upload path must not append it again — S3's ["eq", "$x-amz-tagging", ...]
  // policy condition rejects the request if the field appears twice in the
  // multipart body.
  it("does not duplicate x-amz-tagging when the presigned post fields already include it", async () => {
    const uploads: Array<{ key: string; body: string }> = [];
    const forms: FormData[] = [];
    mockFetch(RAW_EMAIL_WITH_ATTACHMENT, uploads, forms);

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: { "x-amz-tagging": "retention=365" } },
      accountId: "acct-test",
      senderEtld1: "example.com",
      keyPrefix: "emails/msg-display-raw-tag/",
      retentionTag: "365",
    });

    expect(result.success).toBe(true);
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form.getAll("x-amz-tagging")).toEqual(["retention=365"]);
    }
  });
});
