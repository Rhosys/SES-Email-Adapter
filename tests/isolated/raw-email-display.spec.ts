import { describe, it, expect } from "vitest";
import { buildDisplayRawEmail } from "../../src/isolated/raw-email-display.js";

// ---------------------------------------------------------------------------
// buildDisplayRawEmail produces the copy served by "view original email" /
// download-as-.eml: attachments fully stripped, small inline images kept
// (needed for the .eml to still render if opened in a real mail client),
// bounded by a per-image cap and a cumulative budget across the message.
// ---------------------------------------------------------------------------

function buildRawEmail(parts: Array<{ headers: string[]; body: string }>, boundary = "----=_Part_test_boundary"): string {
  const body = parts.map(p => [`--${boundary}`, ...p.headers, "", p.body, ""].join("\r\n")).join("");
  return [
    "From: sender@example.com",
    "To: recipient@example.com",
    "Subject: Test",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    body + `--${boundary}--`,
  ].join("\r\n");
}

describe("buildDisplayRawEmail", () => {
  it("strips a regular attachment body, keeping its headers", () => {
    const raw = buildRawEmail([
      { headers: ['Content-Type: text/plain; charset="UTF-8"'], body: "Body text." },
      {
        headers: [
          "Content-Type: application/pdf",
          "Content-Transfer-Encoding: base64",
          'Content-Disposition: attachment; filename="document.pdf"',
        ],
        body: "QQ==".repeat(50),
      },
    ]);

    const result = buildDisplayRawEmail(raw);
    expect(result).toContain('Content-Disposition: attachment; filename="document.pdf"');
    expect(result).toContain("[attachment content omitted: document.pdf");
    expect(result).not.toContain("QQ==QQ==");
    expect(result).toContain("Body text.");
  });

  it("keeps a small inline image's bytes untouched", () => {
    const raw = buildRawEmail([
      { headers: ['Content-Type: text/html; charset="UTF-8"'], body: '<img src="cid:logo">' },
      {
        headers: [
          "Content-Type: image/png",
          "Content-Transfer-Encoding: base64",
          "Content-ID: <logo>",
          'Content-Disposition: inline; filename="logo.png"',
        ],
        body: "aGVsbG8=".repeat(10), // well under 100KB
      },
    ]);

    const result = buildDisplayRawEmail(raw);
    expect(result).toContain("aGVsbG8=".repeat(10));
    expect(result).not.toContain("[inline image omitted");
  });

  it("truncates an inline image over the 100KB per-image cap", () => {
    const bigBody = "A".repeat(140_000); // ~105KB decoded
    const raw = buildRawEmail([
      {
        headers: [
          "Content-Type: image/png",
          "Content-Transfer-Encoding: base64",
          "Content-ID: <logo>",
          'Content-Disposition: inline; filename="logo.png"',
        ],
        body: bigBody,
      },
    ]);

    const result = buildDisplayRawEmail(raw);
    expect(result).toContain("[inline image omitted: exceeds display size limit");
    expect(result).not.toContain(bigBody);
  });

  it("truncates inline images once the cumulative 300KB budget is exhausted, even if individually under the per-image cap", () => {
    // Each image ~90KB decoded (under the 100KB per-image cap), but 4 of them exceed
    // the 300KB cumulative budget, so the 4th must be truncated.
    const imageBody = "A".repeat(120_000); // ~90KB decoded
    const raw = buildRawEmail([
      { headers: ["Content-Type: image/png", "Content-Transfer-Encoding: base64", "Content-ID: <img1>", 'Content-Disposition: inline; filename="1.png"'], body: imageBody },
      { headers: ["Content-Type: image/png", "Content-Transfer-Encoding: base64", "Content-ID: <img2>", 'Content-Disposition: inline; filename="2.png"'], body: imageBody },
      { headers: ["Content-Type: image/png", "Content-Transfer-Encoding: base64", "Content-ID: <img3>", 'Content-Disposition: inline; filename="3.png"'], body: imageBody },
      { headers: ["Content-Type: image/png", "Content-Transfer-Encoding: base64", "Content-ID: <img4>", 'Content-Disposition: inline; filename="4.png"'], body: imageBody },
    ]);

    const result = buildDisplayRawEmail(raw);
    const omittedCount = (result.match(/\[inline image omitted/g) ?? []).length;
    expect(omittedCount).toBeGreaterThanOrEqual(1);
    // The kept images' bytes must still be present for at least the first ones
    expect(result).toContain(imageBody.slice(0, 100));
  });

  it("leaves non-multipart plain-text emails unchanged", () => {
    const raw = [
      "From: sender@example.com",
      "To: recipient@example.com",
      "Subject: Plain text",
      "Content-Type: text/plain; charset=\"UTF-8\"",
      "MIME-Version: 1.0",
      "",
      "Just a plain message.",
    ].join("\r\n");

    expect(buildDisplayRawEmail(raw)).toBe(raw);
  });

  it("leaves the visible text/html body untouched", () => {
    const raw = buildRawEmail([
      { headers: ['Content-Type: text/html; charset="UTF-8"'], body: "<p>Hello world</p>" },
      {
        headers: ["Content-Type: application/pdf", "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="a.pdf"'],
        body: "QQ==".repeat(20),
      },
    ]);

    const result = buildDisplayRawEmail(raw);
    expect(result).toContain("<p>Hello world</p>");
  });
});
