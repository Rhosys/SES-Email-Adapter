import { describe, it } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "../testing/property-runner.js";
import { MailparserMimeParser } from "./mime.js";
import { extractEmbedTextInput } from "../embedding/embed-text.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constructs a raw MIME message from the given header/body fields.
 * Uses standard RFC 2822 format that mailparser can parse.
 */
function buildRawMime(fields: {
  from: string;
  replyTo: string;
  returnPath: string;
  subject: string;
  textBody: string;
}): string {
  const lines: string[] = [
    `From: ${fields.from}`,
    `Reply-To: ${fields.replyTo}`,
    `Return-Path: <${fields.returnPath}>`,
    `Subject: ${fields.subject}`,
    `To: recipient@test.com`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    fields.textBody,
  ];
  return lines.join("\r\n");
}

/**
 * Generator for valid email addresses (simple form).
 * Avoids characters that would break MIME header parsing.
 */
const emailArb = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{1,12}$/),
    fc.stringMatching(/^[a-z0-9]{1,8}$/),
    fc.constantFrom("com", "org", "net", "io", "co.uk"),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

/**
 * Generator for subject lines — printable ASCII without control chars, newlines,
 * or leading/trailing whitespace that mailparser would trim during parsing.
 */
const subjectArb = fc
  .stringMatching(/^[a-zA-Z0-9!?.,;:\-_(){}\[\]#$%&*+=][a-zA-Z0-9 !?.,;:\-_(){}\[\]#$%&*+=]{0,78}[a-zA-Z0-9!?.,;:\-_(){}\[\]#$%&*+=]$/)
  .filter((s) => s.length >= 1);

/**
 * Generator for text body — printable ASCII and common whitespace,
 * avoiding characters that would interfere with MIME boundary parsing.
 */
const textBodyArb = fc.stringMatching(/^[a-zA-Z0-9 .,;:\-_!?()\n\t]{0,200}$/);

// ---------------------------------------------------------------------------
// Property 4: MIME parse round-trips header fields
// ---------------------------------------------------------------------------

/**
 * **Validates: Requirements 2.1**
 *
 * For any synthetic MIME message constructed from a (from, replyTo, returnPath, subject, textBody)
 * tuple of arbitrary valid strings, parsing it via the MailparserMimeParser returns those exact
 * field values.
 */
describe("Property 4: MIME parse round-trips header fields", () => {
  const parser = new MailparserMimeParser();

  it("parsed from address matches the constructed from field", async () => {
    const property = fc.asyncProperty(
      emailArb,
      emailArb,
      emailArb,
      subjectArb,
      textBodyArb,
      async (from, replyTo, returnPath, subject, textBody) => {
        const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
        const parsed = await parser.parse(Buffer.from(raw));
        const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");

        return input.from === from;
      },
    );

    await propertyRunner.assert(property);
  });

  it("parsed replyTo address matches the constructed reply-to field", async () => {
    const property = fc.asyncProperty(
      emailArb,
      emailArb,
      emailArb,
      subjectArb,
      textBodyArb,
      async (from, replyTo, returnPath, subject, textBody) => {
        const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
        const parsed = await parser.parse(Buffer.from(raw));
        const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");

        return input.replyTo === replyTo;
      },
    );

    await propertyRunner.assert(property);
  });

  it("parsed return-path address matches the constructed return-path field", async () => {
    const property = fc.asyncProperty(
      emailArb,
      emailArb,
      emailArb,
      subjectArb,
      textBodyArb,
      async (from, replyTo, returnPath, subject, textBody) => {
        const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
        const parsed = await parser.parse(Buffer.from(raw));
        const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");

        // extractEmbedTextInput extracts the email address from the structured
        // Return-Path header that simpleParser produces
        return input.returnPath === returnPath;
      },
    );

    await propertyRunner.assert(property);
  });

  it("parsed subject matches the constructed subject field", async () => {
    const property = fc.asyncProperty(
      emailArb,
      emailArb,
      emailArb,
      subjectArb,
      textBodyArb,
      async (from, replyTo, returnPath, subject, textBody) => {
        const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
        const parsed = await parser.parse(Buffer.from(raw));
        const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");

        return input.subject === subject;
      },
    );

    await propertyRunner.assert(property);
  });

  it("parsed text body matches the constructed body content", async () => {
    const property = fc.asyncProperty(
      emailArb,
      emailArb,
      emailArb,
      subjectArb,
      textBodyArb,
      async (from, replyTo, returnPath, subject, textBody) => {
        const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
        const parsed = await parser.parse(Buffer.from(raw));
        const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");

        // mailparser may add a trailing newline to the text body
        return input.rawTextBody === textBody || input.rawTextBody === textBody + "\n";
      },
    );

    await propertyRunner.assert(property);
  });
});
