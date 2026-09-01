import { describe, it, expect } from "vitest";
import { renderMarkdownToHtml } from "../../src/email/markdown.js";

describe("renderMarkdownToHtml", () => {
  it("renders bold, italic, and links", () => {
    const html = renderMarkdownToHtml("**bold** _italic_ [link](https://example.com)");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  it("renders a bullet list", () => {
    const html = renderMarkdownToHtml("- one\n- two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("wraps plain text in a paragraph", () => {
    expect(renderMarkdownToHtml("just text")).toBe("<p>just text</p>\n");
  });

  it("returns an empty string for an empty body", () => {
    expect(renderMarkdownToHtml("")).toBe("");
  });
});
