import { describe, it, expect, vi, afterEach } from "vitest";
import { handler } from "../../src/isolated/content-sanitizer.js";

// ---------------------------------------------------------------------------
// Ingest-side address parsing: mailparser (inside the isolated sanitizer) is the only place
// that ever turns a raw From/To/Cc/Reply-To header into our `{ address, name? }` shape. These
// tests pin down every header format we're expected to see in the wild — bare, decorated,
// quoted-with-special-characters, multi-recipient, and RFC 2047-encoded — so a change to the
// parsing here (or to the mailparser version) can't silently drop or mangle a display name.
// ---------------------------------------------------------------------------

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

async function parse(headers: string[]) {
  const raw = [
    ...headers,
    "Content-Type: text/plain; charset=\"utf-8\"",
    "MIME-Version: 1.0",
    "",
    "Body text",
    "",
  ].join("\r\n");
  mockFetchForRawMime(raw);

  const result = await handler({
    presignedGetUrl: "https://example.com/get",
    presignedPost: { url: "https://example.com/post", fields: {} },
    accountId: "acct-test",
    senderEtld1: "example.com",
    keyPrefix: "emails/msg-001/",
    retentionTag: null,
  });

  expect(result.success).toBe(true);
  if (!result.success) throw new Error("expected successful parse");
  return result.parsed;
}

describe("content-sanitizer — address parsing", () => {
  it("parses a bare From/To address with no display name", async () => {
    const parsed = await parse([
      "From: sender@example.com",
      "To: recipient@example.com",
    ]);

    expect(parsed.from).toEqual({ address: "sender@example.com" });
    expect(parsed.from.name).toBeUndefined();
    expect(parsed.to).toEqual([{ address: "recipient@example.com" }]);
  });

  it("parses an unquoted display name", async () => {
    const parsed = await parse([
      "From: Jane Doe <jane@example.com>",
      "To: recipient@example.com",
    ]);

    expect(parsed.from).toEqual({ address: "jane@example.com", name: "Jane Doe" });
  });

  it("parses a quoted display name containing a comma", async () => {
    const parsed = await parse([
      'From: "Doe, Jane" <jane@example.com>',
      "To: recipient@example.com",
    ]);

    expect(parsed.from).toEqual({ address: "jane@example.com", name: "Doe, Jane" });
  });

  it("parses multiple To recipients, some named and some bare, without dropping or merging any", async () => {
    const parsed = await parse([
      "From: sender@example.com",
      'To: "Doe, Jane" <jane@example.com>, bob@example.com, Alice Smith <alice@example.com>',
    ]);

    expect(parsed.to).toEqual([
      { address: "jane@example.com", name: "Doe, Jane" },
      { address: "bob@example.com" },
      { address: "alice@example.com", name: "Alice Smith" },
    ]);
  });

  it("parses Cc the same way as To, including a quoted comma-bearing name", async () => {
    const parsed = await parse([
      "From: sender@example.com",
      "To: recipient@example.com",
      'Cc: "Support, Team" <support@example.com>, ops@example.com',
    ]);

    expect(parsed.cc).toEqual([
      { address: "support@example.com", name: "Support, Team" },
      { address: "ops@example.com" },
    ]);
  });

  it("parses a Reply-To with a display name", async () => {
    const parsed = await parse([
      "From: sender@example.com",
      "To: recipient@example.com",
      "Reply-To: Support Team <support@example.com>",
    ]);

    expect(parsed.replyTo).toEqual({ address: "support@example.com", name: "Support Team" });
  });

  it("omits Reply-To entirely when the header is absent", async () => {
    const parsed = await parse([
      "From: sender@example.com",
      "To: recipient@example.com",
    ]);

    expect(parsed.replyTo).toBeUndefined();
  });

  it("decodes an RFC 2047 encoded-word display name", async () => {
    const encoded = `=?UTF-8?B?${Buffer.from("Jörg Müller", "utf8").toString("base64")}?=`;
    const parsed = await parse([
      `From: ${encoded} <jorg@example.com>`,
      "To: recipient@example.com",
    ]);

    expect(parsed.from).toEqual({ address: "jorg@example.com", name: "Jörg Müller" });
  });

  it("lowercases neither the address nor the name — case is preserved as received", async () => {
    const parsed = await parse([
      "From: Jane DOE <Jane.Doe@Example.COM>",
      "To: recipient@example.com",
    ]);

    expect(parsed.from).toEqual({ address: "Jane.Doe@Example.COM", name: "Jane DOE" });
  });

  it("fails the parse when the From header is missing entirely", async () => {
    const raw = [
      "To: recipient@example.com",
      "Content-Type: text/plain; charset=\"utf-8\"",
      "MIME-Version: 1.0",
      "",
      "Body text",
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

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("missing_sender");
  });
});
