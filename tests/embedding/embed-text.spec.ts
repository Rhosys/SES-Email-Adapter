import { describe, it, expect } from "vitest";
import { buildEmbedText, reduceLink, type EmbedTextInput } from "../../src/embedding/embed-text.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildEmbedText — header construction
// ---------------------------------------------------------------------------

describe("buildEmbedText", () => {
  describe("header lines", () => {
    it("includes accountId, from, recipientAddress, subject on separate lines", () => {
      const result = buildEmbedText(makeInput());
      const lines = result.split("\n");
      expect(lines[0]).toBe("acct-123");
      expect(lines[1]).toBe("sender@example.com");
      expect(lines[2]).toBe("recipient@example.com");
      expect(lines[3]).toBe("Test Subject");
    });

    it("includes replyTo when present", () => {
      const result = buildEmbedText(makeInput({ replyTo: "reply@example.com" }));
      const lines = result.split("\n");
      expect(lines).toContain("reply@example.com");
    });

    it("includes returnPath when present", () => {
      const result = buildEmbedText(makeInput({ returnPath: "bounce@example.com" }));
      const lines = result.split("\n");
      expect(lines).toContain("bounce@example.com");
    });

    it("omits replyTo line when undefined", () => {
      const result = buildEmbedText(makeInput());
      const lines = result.split("\n");
      // Should be: accountId, from, recipientAddress, subject, body
      expect(lines.length).toBe(5);
    });

    it("omits returnPath line when empty string", () => {
      const result = buildEmbedText(makeInput({ returnPath: "" }));
      const lines = result.split("\n");
      expect(lines.length).toBe(5);
    });

    it("includes both replyTo and returnPath when both present", () => {
      const result = buildEmbedText(makeInput({
        replyTo: "reply@example.com",
        returnPath: "bounce@example.com",
      }));
      const lines = result.split("\n");
      expect(lines[2]).toBe("reply@example.com");
      expect(lines[3]).toBe("bounce@example.com");
      expect(lines[4]).toBe("recipient@example.com");
      expect(lines[5]).toBe("Test Subject");
    });
  });

  // ---------------------------------------------------------------------------
  // Sanitization — CSS removal
  // ---------------------------------------------------------------------------

  describe("sanitization — CSS removal", () => {
    it("removes <style> blocks and their content", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: "before <style>.foo { color: red; }</style> after",
      }));
      expect(result).toContain("before");
      expect(result).toContain("after");
      expect(result).not.toContain("style");
      expect(result).not.toContain("color");
    });

    it("removes multiline <style> blocks", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: "text <style type=\"text/css\">\n.a { margin: 0; }\n.b { padding: 0; }\n</style> more",
      }));
      expect(result).not.toContain("margin");
      expect(result).not.toContain("padding");
    });
  });

  // ---------------------------------------------------------------------------
  // Sanitization — HTML tag removal
  // ---------------------------------------------------------------------------

  describe("sanitization — HTML tag removal", () => {
    it("removes all HTML tags", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: "<div><p>Hello</p><span>World</span></div>",
      }));
      expect(result).toContain("Hello");
      expect(result).toContain("World");
      expect(result).not.toContain("<div>");
      expect(result).not.toContain("<p>");
      expect(result).not.toContain("<span>");
    });

    it("removes self-closing tags", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: "before <br/> after <hr /> end",
      }));
      expect(result).not.toContain("<br");
      expect(result).not.toContain("<hr");
    });
  });

  // ---------------------------------------------------------------------------
  // Sanitization — image removal
  // ---------------------------------------------------------------------------

  describe("sanitization — image removal", () => {
    it("removes <img> tags entirely", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: 'before <img src="photo.jpg" alt="A photo"> after',
      }));
      expect(result).not.toContain("<img");
      expect(result).not.toContain("photo.jpg");
      expect(result).not.toContain("A photo");
      expect(result).toContain("before");
      expect(result).toContain("after");
    });

    it("removes self-closing <img/> tags", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: 'text <img src="x.png" /> more',
      }));
      expect(result).not.toContain("<img");
      expect(result).not.toContain("x.png");
    });
  });

  // ---------------------------------------------------------------------------
  // Sanitization — link reduction
  // ---------------------------------------------------------------------------

  describe("sanitization — link reduction", () => {
    it("reduces full URL to domain + first path segment", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: "Visit https://amazon.com/products/foo/bar?ref=x for details",
      }));
      expect(result).toContain("amazon.com/products");
      expect(result).not.toContain("foo/bar");
      expect(result).not.toContain("ref=x");
    });

    it("reduces URL with no path to just domain", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: "Visit https://example.com for details",
      }));
      expect(result).toContain("example.com");
      expect(result).not.toContain("https://");
    });

    it("reduces URL with query string only to domain", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: "Visit https://example.com?query=1 for details",
      }));
      expect(result).toContain("example.com");
      expect(result).not.toContain("query=1");
    });

    it("reduces URL with fragment to domain + first path", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: "See https://docs.example.com/guide/section#heading here",
      }));
      expect(result).toContain("docs.example.com/guide");
      expect(result).not.toContain("section");
      expect(result).not.toContain("#heading");
    });

    it("handles multiple URLs in the same text", () => {
      const result = buildEmbedText(makeInput({
        rawTextBody: "Link1: https://a.com/path1/sub Link2: https://b.com/path2/sub",
      }));
      expect(result).toContain("a.com/path1");
      expect(result).toContain("b.com/path2");
      expect(result).not.toContain("/sub");
    });
  });

  // ---------------------------------------------------------------------------
  // Body bounding
  // ---------------------------------------------------------------------------

  describe("body bounding", () => {
    it("passes through body ≤ 4000 chars unchanged", () => {
      const body = "x".repeat(4000);
      const result = buildEmbedText(makeInput({ rawTextBody: body }));
      const lines = result.split("\n");
      const bodyLine = lines[lines.length - 1]!;
      expect(bodyLine.length).toBe(4000);
    });

    it("applies 3000+1000 split when body > 4000 chars", () => {
      // Create a body that after sanitization is > 4000 chars
      const body = "a".repeat(3000) + "b".repeat(2000) + "c".repeat(1000);
      const result = buildEmbedText(makeInput({ rawTextBody: body }));
      const lines = result.split("\n");
      const bodyLine = lines[lines.length - 1]!;
      expect(bodyLine.length).toBe(4000);
      // First 3000 should be 'a's
      expect(bodyLine.slice(0, 3000)).toBe("a".repeat(3000));
      // Last 1000 should be 'c's (from the end of the sanitized body)
      expect(bodyLine.slice(-1000)).toBe("c".repeat(1000));
    });

    it("body portion never exceeds 4000 chars", () => {
      const body = "x".repeat(10000);
      const result = buildEmbedText(makeInput({ rawTextBody: body }));
      const lines = result.split("\n");
      const bodyLine = lines[lines.length - 1]!;
      expect(bodyLine.length).toBe(4000);
    });
  });

  // ---------------------------------------------------------------------------
  // Determinism
  // ---------------------------------------------------------------------------

  describe("determinism", () => {
    it("produces identical output for identical input", () => {
      const input = makeInput({
        rawTextBody: '<div><style>.x{}</style><img alt="pic">Hello https://example.com/a/b/c</div>',
      });
      const result1 = buildEmbedText(input);
      const result2 = buildEmbedText(input);
      expect(result1).toBe(result2);
    });
  });
});

// ---------------------------------------------------------------------------
// reduceLink (exported helper)
// ---------------------------------------------------------------------------

describe("reduceLink", () => {
  it("reduces full URL to domain + first path segment", () => {
    expect(reduceLink("https://amazon.com/products/foo/bar?ref=x")).toBe("amazon.com/products");
  });

  it("returns just domain for URL with no path", () => {
    expect(reduceLink("https://example.com")).toBe("example.com");
  });

  it("returns just domain for URL with trailing slash only", () => {
    expect(reduceLink("https://example.com/")).toBe("example.com");
  });

  it("strips query string and fragment", () => {
    expect(reduceLink("https://example.com/path?q=1#frag")).toBe("example.com/path");
  });

  it("returns empty string for invalid URL", () => {
    expect(reduceLink("not-a-url")).toBe("");
  });
});


