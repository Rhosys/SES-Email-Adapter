import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handler } from "../../src/isolated/content-sanitizer.js";

// ---------------------------------------------------------------------------
// Gmail adds Content-ID headers to ALL MIME parts — even those with
// Content-Disposition: attachment (PDFs, pkpass, ICS files). The content
// sanitizer previously checked only `attachment.cid` to decide inline vs
// regular attachment routing, causing every Gmail-forwarded attachment to be
// misclassified as an inline image and excluded from `attachments[]`.
//
// This test uses a fixture that mirrors a real Gmail forward: multipart/mixed
// containing a multipart/related (with 2 genuine inline PNGs) plus 3 real
// attachments (PDF, pkpass, ICS) that have both Content-ID and
// Content-Disposition: attachment.
// ---------------------------------------------------------------------------

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/gmail-forwarded-with-cid-attachments.eml");
const RAW = readFileSync(FIXTURE_PATH);

function mockFetch(raw: Buffer) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "https://example.com/get") {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      };
    }
    // presigned POST upload — always succeed
    return { ok: true, status: 204 };
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("content-sanitizer — Gmail CID on non-inline attachments", () => {
  it("extracts Content-Disposition: attachment parts as attachments even when they have Content-ID", async () => {
    mockFetch(RAW);

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "gmail.com",
      keyPrefix: "content/accounts/acct-test/extracted/msg-gmail-fwd/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // The 3 explicit attachments (PDF, pkpass, ICS) must appear in parsed.attachments.
    // mailparser also surfaces the text/calendar from multipart/alternative as a 4th
    // attachment (no filename, no Content-Disposition) — this is expected behavior.
    expect(result.parsed.attachments).toHaveLength(4);

    const filenames = result.parsed.attachments.map(a => a.filename);
    expect(filenames).toContain("ticket-ABC123.pdf");
    expect(filenames).toContain("pass-ABC123.pkpass");
    expect(filenames).toContain("invite.ics");

    // Verify mime types
    const pdf = result.parsed.attachments.find(a => a.filename === "ticket-ABC123.pdf");
    expect(pdf?.mimeType).toBe("application/pdf");

    const pkpass = result.parsed.attachments.find(a => a.filename === "pass-ABC123.pkpass");
    expect(pkpass?.mimeType).toBe("application/vnd.apple.pkpass");

    const ics = result.parsed.attachments.find(a => a.filename === "invite.ics");
    expect(ics?.mimeType).toBe("application/ics");

    // Each attachment must have an s3Key (was uploaded)
    for (const attachment of result.parsed.attachments) {
      expect(attachment.s3Key).toMatch(/^content\/accounts\/acct-test\/extracted\/msg-gmail-fwd\/\d+$/);
    }
  });

  it("still inlines genuine CID images referenced in the HTML body", async () => {
    mockFetch(RAW);

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "gmail.com",
      keyPrefix: "content/accounts/acct-test/extracted/msg-gmail-fwd/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // The 2 inline PNGs (banner.png, logo.png) should be inlined as data URIs
    // because they are small (1x1 pixel PNGs) and have Content-Disposition: inline
    expect(result.parsed.htmlBody).toContain("data:image/png;base64,");

    // Inline images must NOT appear in the attachments array
    const filenames = result.parsed.attachments.map(a => a.filename);
    expect(filenames).not.toContain("banner.png");
    expect(filenames).not.toContain("logo.png");
  });
});
