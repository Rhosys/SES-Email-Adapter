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
