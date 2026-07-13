import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { simpleParser } from "mailparser";
import { MailparserMimeParser } from "../../src/processor/mime.js";
import { extractEmbedTextInput } from "../../src/embedding/embed-text.js";
import { buildUserMessage } from "../../src/classifier/prompt-builder.js";
import { sanitizeHtml } from "../../src/isolated/html-sanitizer.js";

// ---------------------------------------------------------------------------
// Validates that the full pipeline handles a real-world ~128 KB newsletter
// (multipart/alternative, text/plain + text/html) without truncation errors
// or silent data loss at each stage.
// ---------------------------------------------------------------------------

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/tldrsec-newsletter-long.eml");
const RAW = readFileSync(FIXTURE_PATH);
const RAW_SIZE_BYTES = RAW.length; // ~127 KB

describe("long email handling — tl;dr sec newsletter (~128 KB)", () => {
  describe("MIME parsing (mailparser)", () => {
    it("parses without error and extracts both text and html bodies", async () => {
      const parser = new MailparserMimeParser();
      const parsed = await parser.parse(RAW);

      expect(parsed.from.address).toBe("clint@tldrsec.com");
      expect(parsed.subject).toContain("[tl;dr sec] #335");
      expect(parsed.textBody).toBeDefined();
      expect(parsed.htmlBody).toBeDefined();
    });

    it("text body contains full newsletter content (not truncated by parser)", async () => {
      const parser = new MailparserMimeParser();
      const parsed = await parser.parse(RAW);

      // The text body should contain content from EVERY section of the newsletter
      const textBody = parsed.textBody!;
      expect(textBody).toContain("Wedding");
      expect(textBody).toContain("AppSec");
      expect(textBody).toContain("Cloud Security");
      expect(textBody).toContain("Supply Chain");
      expect(textBody).toContain("AI + Security");
      expect(textBody).toContain("Wrapping Up");
      // Last section's content — proves no early truncation
      expect(textBody).toContain("Cheers,");
      expect(textBody).toContain("Clint");
    });

    it("html body contains full newsletter content (not truncated by parser)", async () => {
      const parser = new MailparserMimeParser();
      const parsed = await parser.parse(RAW);

      const htmlBody = parsed.htmlBody!;
      expect(htmlBody).toContain("Wedding");
      expect(htmlBody).toContain("AI + Security");
      expect(htmlBody).toContain("Wrapping Up");
      // Closing HTML structure should be intact
      expect(htmlBody).toContain("</html>");
    });

    it("extracts headers including newsletter-specific ones", async () => {
      const parser = new MailparserMimeParser();
      const parsed = await parser.parse(RAW);

      // mailparser serializes structured headers (list-unsubscribe) as JSON objects
      // so we check for a simpler custom header that remains a plain string
      expect(parsed.headers["x-beehiiv-type"]).toBe("newsletter");
      expect(parsed.headers["x-list-id"]).toBeDefined();
    });

    it("extracts reply-to address", async () => {
      const parser = new MailparserMimeParser();
      const parsed = await parser.parse(RAW);

      expect(parsed.replyTo).toBeDefined();
      expect(parsed.replyTo!.address).toBe("clint@tldrsec.com");
    });
  });

  describe("HTML truncation (DynamoDB storage)", () => {
    // MAX_HTML_BODY_BYTES in processor.ts is 300_000 (300 KB)
    // This newsletter's HTML is ~100 KB, well under the limit
    it("html body is under 300 KB DDB threshold — no truncation needed", async () => {
      const parser = new MailparserMimeParser();
      const parsed = await parser.parse(RAW);

      const htmlBytes = Buffer.byteLength(parsed.htmlBody!, "utf-8");
      expect(htmlBytes).toBeLessThan(300_000);
      // Sanity — it IS substantial though
      expect(htmlBytes).toBeGreaterThan(50_000);
    });
  });

  describe("classifier prompt truncation (MAX_BODY_LENGTH = 4000)", () => {
    it("body is truncated for classification but does not throw", async () => {
      const parser = new MailparserMimeParser();
      const parsed = await parser.parse(RAW);

      // The classifier uses textBody (or stripped html). Either way, it's >> 4000 chars.
      const body = parsed.textBody ?? "";
      expect(body.length).toBeGreaterThan(4000);

      // buildUserMessage truncates gracefully — no throw, result ends with [... truncated]
      const userMessage = buildUserMessage({
        from: parsed.from.address,
        to: parsed.to.map((a) => a.address),
        subject: parsed.subject,
        body,
        headers: parsed.headers,
        receivedAt: "2026-07-02T19:25:30Z",
        allowedLabels: [],
      });

      expect(userMessage).toContain("[... truncated]");
      expect(userMessage).toContain(parsed.subject);
      expect(userMessage).toContain("clint@tldrsec.com");
    });
  });

  describe("embedding text extraction", () => {
    it("extracts embed input from the parsed mime without error", async () => {
      const parser = new MailparserMimeParser();
      const parsed = await parser.parse(RAW);

      const input = extractEmbedTextInput(parsed, "test-account", "user@test.com");

      expect(input.from).toBe("clint@tldrsec.com");
      expect(input.subject).toContain("[tl;dr sec] #335");
      // rawTextBody should be populated (text/plain preferred over html)
      expect(input.rawTextBody.length).toBeGreaterThan(0);
    });

    it("rawTextBody is the full text/plain part — not truncated at extraction", async () => {
      const parser = new MailparserMimeParser();
      const parsed = await parser.parse(RAW);

      const input = extractEmbedTextInput(parsed, "test-account", "user@test.com");

      // Should contain content from the end of the newsletter
      expect(input.rawTextBody).toContain("Cheers,");
    });
  });

  describe("HTML sanitizer (content display)", () => {
    it("sanitizes the full html body without throwing", async () => {
      const parsed = await simpleParser(RAW);
      const htmlInput = typeof parsed.html === "string" ? parsed.html : "";

      expect(htmlInput.length).toBeGreaterThan(50_000);

      const result = sanitizeHtml(htmlInput);
      expect(result.html.length).toBeGreaterThan(0);
    });

    it("preserves newsletter section headings through sanitization", async () => {
      const parsed = await simpleParser(RAW);
      const htmlInput = typeof parsed.html === "string" ? parsed.html : "";
      const result = sanitizeHtml(htmlInput);

      expect(result.html).toContain("AppSec");
      expect(result.html).toContain("Cloud Security");
      expect(result.html).toContain("Supply Chain");
      expect(result.html).toContain("AI + Security");
    });

    it("strips tracking pixels and scripts", async () => {
      const parsed = await simpleParser(RAW);
      const htmlInput = typeof parsed.html === "string" ? parsed.html : "";
      const result = sanitizeHtml(htmlInput);

      expect(result.html).not.toContain("<script");
      expect(result.html).not.toContain("onclick");
    });
  });

  describe("raw email size context", () => {
    it("fixture is ~128 KB (confirms it exercises large-email paths)", () => {
      expect(RAW_SIZE_BYTES).toBeGreaterThan(120_000);
      expect(RAW_SIZE_BYTES).toBeLessThan(200_000);
    });
  });
});
