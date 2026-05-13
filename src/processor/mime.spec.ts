import { describe, it, expect } from "vitest";
import { MailparserMimeParser } from "./mime.js";
import { extractEmbedTextInput } from "../embedding/embed-text.js";

/**
 * Constructs a raw MIME message from the given header/body fields.
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

describe("MIME parse round-trips header fields", () => {
  const parser = new MailparserMimeParser();

  const cases = [
    {
      label: "simple addresses and short subject",
      from: "alice@sender.com",
      replyTo: "reply@sender.com",
      returnPath: "bounce@sender.com",
      subject: "Hello World",
      textBody: "This is a test email body.",
    },
    {
      label: "numeric local parts and multi-segment TLD",
      from: "user123@domain.co.uk",
      replyTo: "noreply@alerts.io",
      returnPath: "bounces@mailer.net",
      subject: "Order #12345 confirmed",
      textBody: "Your order has been confirmed.",
    },
    {
      label: "minimal single-char local parts",
      from: "a@b.com",
      replyTo: "c@d.org",
      returnPath: "e@f.net",
      subject: "X",
      textBody: "",
    },
  ];

  it.each(cases)("$label — from address round-trips", async ({ from, replyTo, returnPath, subject, textBody }) => {
    const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
    const parsed = await parser.parse(Buffer.from(raw));
    const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");
    expect(input.from).toBe(from);
  });

  it.each(cases)("$label — replyTo address round-trips", async ({ from, replyTo, returnPath, subject, textBody }) => {
    const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
    const parsed = await parser.parse(Buffer.from(raw));
    const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");
    expect(input.replyTo).toBe(replyTo);
  });

  it.each(cases)("$label — returnPath address round-trips", async ({ from, replyTo, returnPath, subject, textBody }) => {
    const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
    const parsed = await parser.parse(Buffer.from(raw));
    const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");
    expect(input.returnPath).toBe(returnPath);
  });

  it.each(cases)("$label — subject round-trips", async ({ from, replyTo, returnPath, subject, textBody }) => {
    const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
    const parsed = await parser.parse(Buffer.from(raw));
    const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");
    expect(input.subject).toBe(subject);
  });

  it.each(cases)("$label — text body round-trips", async ({ from, replyTo, returnPath, subject, textBody }) => {
    const raw = buildRawMime({ from, replyTo, returnPath, subject, textBody });
    const parsed = await parser.parse(Buffer.from(raw));
    const input = extractEmbedTextInput(parsed, "test-account", "recipient@test.com");
    // mailparser may add a trailing newline
    expect(input.rawTextBody === textBody || input.rawTextBody === textBody + "\n").toBe(true);
  });
});
