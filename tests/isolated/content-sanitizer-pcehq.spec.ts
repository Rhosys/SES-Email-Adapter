import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handler } from "../../src/isolated/content-sanitizer.js";

// ---------------------------------------------------------------------------
// Regression: a real Gmail-forwarded event confirmation (PCEHQ.eml) with 3
// explicit attachments (PDF, pkpass, ICS) under multipart/mixed, each with
// Content-Disposition: attachment — yet the API returned attachments: [].
// This test feeds the real .eml through the sanitizer to see what comes out.
// ---------------------------------------------------------------------------

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/PCEHQ.eml");
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

describe("content-sanitizer — PCEHQ real email", () => {
  it("extracts the 3 explicit attachments (PDF, pkpass, ICS)", async () => {
    mockFetch(RAW);

    const result = await handler({
      presignedGetUrl: "https://example.com/get",
      presignedPost: { url: "https://example.com/post", fields: {} },
      accountId: "acct-test",
      senderEtld1: "gmail.com",
      keyPrefix: "content/accounts/acct-test/extracted/msg-pcehq/",
      retentionTag: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // The 3 real attachments must be in parsed.attachments
    // (mailparser also surfaces the text/calendar from multipart/alternative as a 4th)
    expect(result.parsed.attachments.length).toBeGreaterThanOrEqual(3);

    const filenames = result.parsed.attachments.map(a => a.filename);
    expect(filenames).toContain("ZH26-PCEHQ-pdf.pdf");
    expect(filenames).toContain("ZH26-PCEHQ-1-passbook.pkpass");
    expect(filenames).toContain("invite.ics");

    // Each must have an s3Key (was uploaded)
    for (const a of result.parsed.attachments) {
      expect(a.s3Key).toMatch(/^content\/accounts\/acct-test\/extracted\/msg-pcehq\/\d+$/);
    }
  });
});
