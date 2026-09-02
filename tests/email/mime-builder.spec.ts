import { describe, it, expect } from "vitest";
import { buildMimeMessage } from "../../src/email/mime-builder.js";

function build(overrides: Partial<Parameters<typeof buildMimeMessage>[0]> = {}): string {
  return Buffer.from(buildMimeMessage({
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Hello",
    textBody: "Body text",
    date: new Date("2026-08-06T12:00:00Z"),
    ...overrides,
  })).toString("utf8");
}

function bodyOf(message: string): string {
  return Buffer.from(message.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim(), "base64").toString("utf8");
}

describe("buildMimeMessage", () => {
  it("emits the standard headers followed by a blank line and the body", () => {
    const message = build();
    expect(message).toContain("From: sender@example.com\r\n");
    expect(message).toContain("To: recipient@example.com\r\n");
    expect(message).toContain("Subject: Hello\r\n");
    expect(message).toContain("Date: Thu, 06 Aug 2026 12:00:00 +0000\r\n");
    expect(message).toContain("MIME-Version: 1.0\r\n");
    expect(message).toContain("Content-Type: text/plain; charset=UTF-8\r\n");
    expect(message).toContain("Content-Transfer-Encoding: base64\r\n");
    expect(bodyOf(message)).toBe("Body text");
  });

  it("round-trips a non-ASCII body through base64", () => {
    const message = build({ textBody: "Grüße — 日本語 🎉" });
    expect(bodyOf(message)).toBe("Grüße — 日本語 🎉");
  });

  it("wraps long base64 bodies at 76 characters", () => {
    const message = build({ textBody: "x".repeat(500) });
    const bodyLines = message.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim().split("\r\n");
    expect(bodyLines.length).toBeGreaterThan(1);
    for (const line of bodyLines) expect(line.length).toBeLessThanOrEqual(76);
    expect(bodyOf(message)).toBe("x".repeat(500));
  });

  it("RFC 2047-encodes a non-ASCII subject", () => {
    const message = build({ subject: "Grüße" });
    expect(message).toContain(`Subject: =?UTF-8?B?${Buffer.from("Grüße", "utf8").toString("base64")}?=`);
  });

  it("leaves an ASCII subject unencoded", () => {
    expect(build({ subject: "Plain subject" })).toContain("Subject: Plain subject\r\n");
  });

  it("encodes a non-ASCII display name but leaves the address alone", () => {
    const message = build({ from: "Jörg Müller <jorg@example.com>" });
    expect(message).toMatch(/From: =\?UTF-8\?B\?[^?]+\?= <jorg@example\.com>/);
  });

  it("passes extra headers through", () => {
    const message = build({ headers: [{ Name: "In-Reply-To", Value: "<abc@x.com>" }, { Name: "References", Value: "<abc@x.com>" }] });
    expect(message).toContain("In-Reply-To: <abc@x.com>\r\n");
    expect(message).toContain("References: <abc@x.com>\r\n");
  });

  it("drops a caller-supplied header that would duplicate one it emits itself", () => {
    const message = build({ headers: [{ Name: "Subject", Value: "Injected subject" }] });
    expect(message).not.toContain("Injected subject");
    expect(message.match(/^Subject:/gm)).toHaveLength(1);
  });

  // Header injection: a newline in any user-controlled header value would otherwise let the
  // remainder be read as its own header — a forged Bcc, or a second body.
  it("strips CRLF from a subject so it cannot inject headers", () => {
    const message = build({ subject: "Hi\r\nBcc: attacker@evil.com" });
    // The text survives, folded into the subject — what must not survive is it starting a line.
    expect(message).not.toMatch(/^Bcc:/m);
    expect(message).toContain("Subject: Hi Bcc: attacker@evil.com\r\n");
  });

  it("strips CRLF from extra header values", () => {
    const message = build({ headers: [{ Name: "In-Reply-To", Value: "<a@b>\r\nBcc: attacker@evil.com" }] });
    expect(message).not.toContain("\r\nBcc:");
  });

  it("strips CRLF from the From address", () => {
    const message = build({ from: "sender@example.com\r\nBcc: attacker@evil.com" });
    expect(message).not.toContain("\r\nBcc:");
  });
});

describe("buildMimeMessage — multipart/alternative (htmlBody)", () => {
  function part(message: string, contentType: string): string {
    const boundaryMatch = /boundary="([^"]+)"/.exec(message);
    if (!boundaryMatch) throw new Error("no boundary found");
    const boundary = boundaryMatch[1]!;
    const sections = message.split(`--${boundary}`);
    const section = sections.find(s => s.includes(`Content-Type: ${contentType}`));
    if (!section) throw new Error(`no ${contentType} part found`);
    const b64 = section.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
    return Buffer.from(b64, "base64").toString("utf8");
  }

  it("emits a single top-level Content-Type: multipart/alternative header with a boundary", () => {
    const message = build({ htmlBody: "<p>Body text</p>" });
    expect(message).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"\r\n/);
    // No top-level text/plain header — that only appears inside a part now.
    expect(message.split("\r\n\r\n")[0]).not.toContain("Content-Type: text/plain");
  });

  it("carries the plain-text part first and the HTML part second", () => {
    const message = build({ textBody: "Plain version", htmlBody: "<p>HTML version</p>" });
    const plainIndex = message.indexOf("Content-Type: text/plain");
    const htmlIndex = message.indexOf("Content-Type: text/html");
    expect(plainIndex).toBeGreaterThan(-1);
    expect(htmlIndex).toBeGreaterThan(plainIndex);
    expect(part(message, "text/plain; charset=UTF-8")).toBe("Plain version");
    expect(part(message, "text/html; charset=UTF-8")).toBe("<p>HTML version</p>");
  });

  it("closes the multipart body with a final boundary delimiter", () => {
    const message = build({ htmlBody: "<p>x</p>" });
    const boundary = /boundary="([^"]+)"/.exec(message)![1]!;
    expect(message.trimEnd()).toMatch(new RegExp(`--${boundary}--$`));
  });

  it("falls back to a single text/plain part when htmlBody is absent, unchanged from before", () => {
    const message = build();
    expect(message).not.toContain("multipart/alternative");
    expect(message).toContain("Content-Type: text/plain; charset=UTF-8\r\n");
  });
});
