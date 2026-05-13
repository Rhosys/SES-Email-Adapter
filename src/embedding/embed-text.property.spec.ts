import { describe, it, expect } from "vitest";
import { buildEmbedText, reduceLink, type EmbedTextInput } from "./embed-text.js";

function makeInput(overrides: Partial<EmbedTextInput> = {}): EmbedTextInput {
  return {
    accountId: "acct-123",
    from: "sender@example.com",
    recipientAddress: "recipient@example.com",
    subject: "Test Subject",
    rawTextBody: "Hello world",
    ...overrides,
  };
}

describe("Embed text is deterministic, bounded, and contains all input fields", () => {
  it("same input always produces same output", () => {
    const input = makeInput({ rawTextBody: "Some content with https://example.com/path/deep" });
    expect(buildEmbedText(input)).toBe(buildEmbedText(input));
  });

  it("body portion is at most 4000 characters for short input", () => {
    const input = makeInput({ rawTextBody: "x".repeat(3000) });
    const lines = buildEmbedText(input).split("\n");
    const bodyLine = lines[lines.length - 1]!;
    expect(bodyLine.length).toBeLessThanOrEqual(4000);
  });

  it("body portion is at most 4000 characters for long input", () => {
    const input = makeInput({ rawTextBody: "x".repeat(6000) });
    const lines = buildEmbedText(input).split("\n");
    const bodyLine = lines[lines.length - 1]!;
    expect(bodyLine.length).toBe(4000);
  });

  it("applies first 3000 + last 1000 rule when sanitized body > 4000", () => {
    const body = "a".repeat(3000) + "b".repeat(2000) + "c".repeat(1000);
    const input = makeInput({ rawTextBody: body });
    const lines = buildEmbedText(input).split("\n");
    const bodyLine = lines[lines.length - 1]!;
    expect(bodyLine.length).toBe(4000);
    expect(bodyLine.slice(0, 3000)).toBe("a".repeat(3000));
    expect(bodyLine.slice(-1000)).toBe("c".repeat(1000));
  });

  it("all required fields appear on their own line", () => {
    const input = makeInput();
    const lines = buildEmbedText(input).split("\n");
    expect(lines).toContain("acct-123");
    expect(lines).toContain("sender@example.com");
    expect(lines).toContain("recipient@example.com");
    expect(lines).toContain("Test Subject");
  });

  it("optional replyTo appears when present", () => {
    const input = makeInput({ replyTo: "reply@example.com" });
    const lines = buildEmbedText(input).split("\n");
    expect(lines).toContain("reply@example.com");
  });

  it("optional returnPath appears when present", () => {
    const input = makeInput({ returnPath: "bounce@example.com" });
    const lines = buildEmbedText(input).split("\n");
    expect(lines).toContain("bounce@example.com");
  });

  it("optional fields omitted when absent", () => {
    const input = makeInput();
    const lines = buildEmbedText(input).split("\n");
    // accountId, from, recipientAddress, subject, body = 5 lines
    expect(lines.length).toBe(5);
  });
});

describe("Sanitization removes all structural HTML/CSS/image artifacts", () => {
  const htmlCases = [
    {
      label: "style block with CSS",
      body: '<style type="text/css">.foo { color: red; }</style>Hello',
    },
    {
      label: "img tag with alt text",
      body: 'before <img src="photo.jpg" alt="A photo"> after',
    },
    {
      label: "nested HTML tags",
      body: '<div><p>Hello</p><span class="highlight">World</span></div>',
    },
    {
      label: "mixed: style + img + tags + plain text",
      body: '<style>.x{}</style><div><img src="x.png" alt="pic"><p>Content</p></div> plain text',
    },
  ];

  it.each(htmlCases)("$label — no style blocks in output", ({ body }) => {
    const result = buildEmbedText(makeInput({ rawTextBody: body }));
    expect(result).not.toMatch(/<style[\s>]/i);
    expect(result).not.toMatch(/<\/style>/i);
  });

  it.each(htmlCases)("$label — no HTML tags in output", ({ body }) => {
    const result = buildEmbedText(makeInput({ rawTextBody: body }));
    expect(result).not.toMatch(/<[a-zA-Z]/);
  });

  it.each(htmlCases)("$label — no img references in output", ({ body }) => {
    const result = buildEmbedText(makeInput({ rawTextBody: body }));
    expect(result).not.toMatch(/<img/i);
  });

  it.each(htmlCases)("$label — no alt= content in output", ({ body }) => {
    const result = buildEmbedText(makeInput({ rawTextBody: body }));
    expect(result).not.toMatch(/alt=/i);
  });
});

describe("Links reduce to domain plus first path segment", () => {
  const linkCases = [
    { label: "full URL with deep path and query", url: "https://amazon.com/products/foo/bar?ref=x", expected: "amazon.com/products" },
    { label: "URL with no path", url: "https://example.com", expected: "example.com" },
    { label: "URL with trailing slash only", url: "https://example.com/", expected: "example.com" },
    { label: "URL with query only (no path)", url: "https://example.com?q=1", expected: "example.com" },
    { label: "URL with fragment", url: "https://docs.example.com/guide/section#heading", expected: "docs.example.com/guide" },
    { label: "HTTP URL", url: "http://plain.org/path/deep", expected: "plain.org/path" },
    { label: "subdomain URL", url: "https://sub.domain.io/api/v2/resource", expected: "sub.domain.io/api" },
  ];

  it.each(linkCases)("$label — reduceLink produces $expected", ({ url, expected }) => {
    expect(reduceLink(url)).toBe(expected);
  });

  it("reduceLink returns empty string for invalid URL", () => {
    expect(reduceLink("not-a-url")).toBe("");
  });

  it("buildEmbedText with embedded URL strips scheme and deep paths", () => {
    const input = makeInput({ rawTextBody: "Click here: https://amazon.com/products/foo/bar?ref=x for more" });
    const result = buildEmbedText(input);
    expect(result).toContain("amazon.com/products");
    expect(result).not.toContain("https://");
    expect(result).not.toContain("ref=x");
    expect(result).not.toContain("foo/bar");
  });
});
