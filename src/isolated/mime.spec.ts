import { describe, it, expect } from "vitest";
import {
  sniffContentType,
  mimeFromExtension,
  extensionFromMime,
  resolveContentType,
  ensureFilenameExtension,
  buildContentDisposition,
} from "./mime.js";

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

describe("sniffContentType", () => {
  it.each([
    { label: "PDF", input: bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31), expected: "application/pdf" },
    { label: "PNG", input: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), expected: "image/png" },
    { label: "JPEG", input: bytes(0xff, 0xd8, 0xff, 0xe0), expected: "image/jpeg" },
    { label: "GIF", input: bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), expected: "image/gif" },
    { label: "BMP", input: bytes(0x42, 0x4d, 0x00, 0x00), expected: "image/bmp" },
    { label: "TIFF little-endian", input: bytes(0x49, 0x49, 0x2a, 0x00), expected: "image/tiff" },
    { label: "TIFF big-endian", input: bytes(0x4d, 0x4d, 0x00, 0x2a), expected: "image/tiff" },
  ])("detects $label from magic bytes", ({ input, expected }) => {
    expect(sniffContentType(input)).toBe(expected);
  });

  it("detects WebP from RIFF....WEBP", () => {
    const webp = bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
    expect(sniffContentType(webp)).toBe("image/webp");
  });

  it("does not misfire on RIFF that is not WebP (e.g. WAV)", () => {
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
    expect(sniffContentType(wav)).toBeUndefined();
  });

  it("returns undefined for unrecognized bytes", () => {
    expect(sniffContentType(bytes(0x00, 0x01, 0x02, 0x03))).toBeUndefined();
  });

  it("returns undefined for a buffer too short to match", () => {
    expect(sniffContentType(bytes(0x25, 0x50))).toBeUndefined();
  });
});

describe("mimeFromExtension", () => {
  it.each([
    { filename: "invoice.pdf", expected: "application/pdf" },
    { filename: "photo.JPG", expected: "image/jpeg" },
    { filename: "logo.png", expected: "image/png" },
    { filename: "invite.ics", expected: "text/calendar" },
    { filename: "sheet.xlsx", expected: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  ])("maps $filename", ({ filename, expected }) => {
    expect(mimeFromExtension(filename)).toBe(expected);
  });

  it("returns undefined for an unknown extension", () => {
    expect(mimeFromExtension("archive.xyz")).toBeUndefined();
  });

  it("returns undefined for a filename with no extension", () => {
    expect(mimeFromExtension("attachment-0")).toBeUndefined();
  });

  it("returns undefined for a trailing-dot filename", () => {
    expect(mimeFromExtension("weird.")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(mimeFromExtension(undefined)).toBeUndefined();
  });
});

describe("extensionFromMime", () => {
  it.each([
    { mime: "application/pdf", expected: "pdf" },
    { mime: "image/jpeg", expected: "jpg" },
    { mime: "image/png", expected: "png" },
    { mime: "text/calendar", expected: "ics" },
  ])("maps $mime", ({ mime, expected }) => {
    expect(extensionFromMime(mime)).toBe(expected);
  });

  it("strips parameters before lookup", () => {
    expect(extensionFromMime("text/calendar; method=REQUEST")).toBe("ics");
  });

  it("is case-insensitive", () => {
    expect(extensionFromMime("IMAGE/PNG")).toBe("png");
  });

  it("returns undefined for an unmapped type", () => {
    expect(extensionFromMime("application/x-unknown")).toBeUndefined();
  });
});

describe("resolveContentType", () => {
  it("prefers sniffed bytes over a declared octet-stream", () => {
    const pdfBytes = bytes(0x25, 0x50, 0x44, 0x46, 0x2d);
    expect(
      resolveContentType({ content: pdfBytes, declaredType: "application/octet-stream", filename: "file.bin" }),
    ).toBe("application/pdf");
  });

  it("prefers sniffed bytes even over a plausible-but-wrong declared type", () => {
    const pngBytes = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(
      resolveContentType({ content: pngBytes, declaredType: "image/jpeg", filename: "x.jpg" }),
    ).toBe("image/png");
  });

  it("uses the declared type when specific and not sniffable", () => {
    const textBytes = new TextEncoder().encode("hello world, not a binary");
    expect(
      resolveContentType({ content: textBytes, declaredType: "text/csv", filename: "data.csv" }),
    ).toBe("text/csv");
  });

  it("falls back to the extension when declared is octet-stream and bytes are unknown", () => {
    const textBytes = new TextEncoder().encode("some plain content here");
    expect(
      resolveContentType({ content: textBytes, declaredType: "application/octet-stream", filename: "report.csv" }),
    ).toBe("text/csv");
  });

  it("falls back to the extension when there is no declared type", () => {
    const textBytes = new TextEncoder().encode("plain content");
    expect(
      resolveContentType({ content: textBytes, declaredType: undefined, filename: "notes.txt" }),
    ).toBe("text/plain");
  });

  it("returns octet-stream when nothing identifies the type", () => {
    const unknown = bytes(0x00, 0x01, 0x02, 0x03, 0x04);
    expect(
      resolveContentType({ content: unknown, declaredType: undefined, filename: "attachment-0" }),
    ).toBe("application/octet-stream");
  });

  it("returns octet-stream when declared is octet-stream and extension is unknown", () => {
    const unknown = bytes(0x00, 0x01, 0x02, 0x03, 0x04);
    expect(
      resolveContentType({ content: unknown, declaredType: "application/octet-stream", filename: "blob.xyz" }),
    ).toBe("application/octet-stream");
  });

  // Non-standard iCalendar declared types must canonicalize to text/calendar so downstream
  // calendar detection and the served Content-Type see the registered type. Bytes here are
  // plain text (no magic signature), so the declared type is the deciding signal.
  it.each([
    { declared: "application/ics" },
    { declared: "application/calendar" },
    { declared: "text/x-vcalendar" },
    { declared: "APPLICATION/ICS" },
    { declared: "application/ics; method=REQUEST" },
  ])("canonicalizes $declared to text/calendar", ({ declared }) => {
    const icsBytes = new TextEncoder().encode("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR");
    expect(
      resolveContentType({ content: icsBytes, declaredType: declared, filename: "invite" }),
    ).toBe("text/calendar");
  });

  it("leaves the standard text/calendar type unchanged", () => {
    const icsBytes = new TextEncoder().encode("BEGIN:VCALENDAR");
    expect(
      resolveContentType({ content: icsBytes, declaredType: "text/calendar", filename: "invite.ics" }),
    ).toBe("text/calendar");
  });
});

describe("ensureFilenameExtension", () => {
  it("appends the canonical extension when the filename has none", () => {
    expect(ensureFilenameExtension("attachment-0", "application/pdf")).toBe("attachment-0.pdf");
  });

  it("appends jpg for image/jpeg", () => {
    expect(ensureFilenameExtension("inline-2", "image/jpeg")).toBe("inline-2.jpg");
  });

  it("leaves a filename that already has an extension unchanged", () => {
    expect(ensureFilenameExtension("invoice.pdf", "application/pdf")).toBe("invoice.pdf");
  });

  it("leaves a filename unchanged even if its extension mismatches the type", () => {
    // The sender's chosen extension wins — we don't rewrite it.
    expect(ensureFilenameExtension("photo.jpeg", "image/png")).toBe("photo.jpeg");
  });

  it("returns the filename unchanged when the type has no known extension", () => {
    expect(ensureFilenameExtension("blob", "application/x-unknown")).toBe("blob");
  });
});

describe("buildContentDisposition", () => {
  it.each([
    { mime: "application/pdf", kind: "inline" },
    { mime: "image/png", kind: "inline" },
    { mime: "image/jpeg", kind: "inline" },
    { mime: "image/gif", kind: "inline" },
    { mime: "image/webp", kind: "inline" },
    { mime: "image/svg+xml", kind: "inline" },
  ])("renders $mime inline", ({ mime, kind }) => {
    expect(buildContentDisposition(mime, "file.bin")).toContain(`${kind}; filename=`);
  });

  it.each([
    { mime: "application/zip" },
    { mime: "application/octet-stream" },
    { mime: "text/calendar" },
    { mime: "application/vnd.apple.pkpass" },
  ])("renders $mime as attachment", ({ mime }) => {
    expect(buildContentDisposition(mime, "file.bin")).toMatch(/^attachment; filename=/);
  });

  it("ignores content-type parameters when deciding inline vs attachment", () => {
    expect(buildContentDisposition("application/pdf; charset=binary", "doc.pdf")).toMatch(/^inline;/);
  });

  it("quotes the ASCII filename", () => {
    expect(buildContentDisposition("application/pdf", "invoice.pdf")).toBe('inline; filename="invoice.pdf"');
  });

  it("sanitizes quotes and control chars in the ASCII fallback", () => {
    const result = buildContentDisposition("application/zip", 'a"b\r\n.zip');
    expect(result).toBe('attachment; filename="a_b__.zip"');
  });

  it("adds an RFC 5987 encoded form for non-ASCII filenames", () => {
    const result = buildContentDisposition("application/pdf", "rechnung-März.pdf");
    expect(result).toContain("filename*=UTF-8''");
    expect(result).toContain(encodeURIComponent("rechnung-März.pdf"));
  });

  it("omits the RFC 5987 form for pure-ASCII filenames", () => {
    expect(buildContentDisposition("application/pdf", "plain.pdf")).not.toContain("filename*=");
  });
});
