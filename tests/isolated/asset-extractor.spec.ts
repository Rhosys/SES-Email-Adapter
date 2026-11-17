import { describe, it, expect } from "vitest";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import JSZip from "jszip";
import * as jpegJs from "jpeg-js";
import { extractQrFromInlineImages, extractQrFromAttachments, extractPkPassAssets, extractAssets, readImageDimensions, type QrScanIssue } from "../../src/isolated/asset-extractor.js";

async function makeQrPngBuffer(text: string): Promise<Buffer> {
  const dataUrl: string = await QRCode.toDataURL(text, { margin: 1, width: 100 });
  const b64 = dataUrl.split(",")[1]!;
  return Buffer.from(b64, "base64");
}

function makePlainPngBuffer(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255;
    png.data[i + 1] = 255;
    png.data[i + 2] = 255;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function makePkPassZip(passJson: object): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("pass.json", JSON.stringify(passJson));
  return zip.generateAsync({ type: "nodebuffer" }) as Promise<Buffer>;
}

describe("extractQrFromInlineImages", () => {
  it("decodes a QR code from an inline PNG image", async () => {
    const qrBuf = await makeQrPngBuffer("https://example.com/ticket/123");

    const assets = extractQrFromInlineImages([{ mimeType: "image/png", content: qrBuf }]);

    expect(assets).toHaveLength(1);
    expect(assets[0]!.type).toBe("qr_code");
    expect(assets[0]!.rawValue).toBe("https://example.com/ticket/123");
  });

  it("deduplicates by rawValue when the same QR appears twice", async () => {
    const qrBuf = await makeQrPngBuffer("DUPE-VALUE");

    const assets = extractQrFromInlineImages([
      { mimeType: "image/png", content: qrBuf },
      { mimeType: "image/png", content: qrBuf },
    ]);
    expect(assets).toHaveLength(1);
  });

  it("returns [] when no images provided", () => {
    expect(extractQrFromInlineImages([])).toEqual([]);
  });

  it("returns [] when image has no QR code", () => {
    const plainBuf = makePlainPngBuffer(100, 100);
    expect(extractQrFromInlineImages([{ mimeType: "image/png", content: plainBuf }])).toEqual([]);
  });

  it("skips images smaller than 50x50", () => {
    const tinyBuf = makePlainPngBuffer(10, 10);
    expect(extractQrFromInlineImages([{ mimeType: "image/png", content: tinyBuf }])).toEqual([]);
  });

  it("returns [] on corrupt image data without throwing", () => {
    const corrupt = Buffer.from("NOT_VALID_IMAGE_DATA");
    expect(() => extractQrFromInlineImages([{ mimeType: "image/png", content: corrupt }])).not.toThrow();
    expect(extractQrFromInlineImages([{ mimeType: "image/png", content: corrupt }])).toEqual([]);
  });
});

describe("extractQrFromAttachments", () => {
  it("decodes a QR code from a PNG image attachment", async () => {
    const qrBuf = await makeQrPngBuffer("ATT-QR-001");

    const assets = extractQrFromAttachments([{
      filename: "qr.png", mimeType: "image/png", content: qrBuf, s3Key: "content/att/qr.png",
    }]);

    expect(assets).toHaveLength(1);
    expect(assets[0]!.rawValue).toBe("ATT-QR-001");
  });

  it("skips non-image attachments", () => {
    const assets = extractQrFromAttachments([{
      filename: "doc.pdf", mimeType: "application/pdf", content: Buffer.from("pdf"), s3Key: "content/att/doc.pdf",
    }]);
    expect(assets).toEqual([]);
  });

  it("returns [] when image has no QR code", () => {
    const plainBuf = makePlainPngBuffer(100, 100);
    const assets = extractQrFromAttachments([{
      filename: "photo.png", mimeType: "image/png", content: plainBuf, s3Key: "content/att/photo.png",
    }]);
    expect(assets).toEqual([]);
  });
});

describe("extractPkPassAssets", () => {
  it("extracts barcode message from pass.json barcodes array", async () => {
    const passJson = {
      description: "Boarding Pass — United Airlines",
      barcodes: [{ format: "PKBarcodeFormatAztec", message: "M1DOE/JOHN EABC123 SFO LAX 0012 001Y", messageEncoding: "iso-8859-1" }],
    };
    const zipBuf = await makePkPassZip(passJson);

    const assets = await extractPkPassAssets([{
      filename: "boardingpass.pkpass", mimeType: "application/vnd.apple.pkpass", content: zipBuf, s3Key: "content/att/boardingpass.pkpass",
    }]);

    expect(assets).toHaveLength(1);
    expect(assets[0]!.type).toBe("pkpass");
    expect(assets[0]!.rawValue).toBe("M1DOE/JOHN EABC123 SFO LAX 0012 001Y");
    expect(assets[0]!.label).toBe("Boarding Pass — United Airlines");
    expect(assets[0]!.s3Key).toBe("content/att/boardingpass.pkpass");
  });

  it("falls back to legacy barcode field when barcodes array is absent", async () => {
    const passJson = {
      description: "Event Ticket",
      barcode: { format: "PKBarcodeFormatQR", message: "TICKET-999", messageEncoding: "iso-8859-1" },
    };
    const zipBuf = await makePkPassZip(passJson);

    const assets = await extractPkPassAssets([{
      filename: "ticket.pkpass", mimeType: "application/vnd.apple.pkpass", content: zipBuf, s3Key: "content/att/ticket.pkpass",
    }]);

    expect(assets).toHaveLength(1);
    expect(assets[0]!.rawValue).toBe("TICKET-999");
  });

  it("detects pkpass by filename extension when MIME type is generic", async () => {
    const passJson = { barcodes: [{ format: "PKBarcodeFormatQR", message: "GENERIC-MIME" }] };
    const zipBuf = await makePkPassZip(passJson);

    const assets = await extractPkPassAssets([{
      filename: "pass.pkpass", mimeType: "application/octet-stream", content: zipBuf, s3Key: "content/att/pass.pkpass",
    }]);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.rawValue).toBe("GENERIC-MIME");
  });

  it("extracts multiple barcodes from a single pkpass", async () => {
    const passJson = {
      description: "Multi Barcode Pass",
      barcodes: [
        { format: "PKBarcodeFormatQR", message: "BC-1" },
        { format: "PKBarcodeFormatAztec", message: "BC-2" },
      ],
    };
    const zipBuf = await makePkPassZip(passJson);

    const assets = await extractPkPassAssets([{
      filename: "multi.pkpass", mimeType: "application/vnd.apple.pkpass", content: zipBuf, s3Key: "content/att/multi.pkpass",
    }]);
    expect(assets).toHaveLength(2);
  });

  it("returns [] for a corrupt pkpass ZIP", async () => {
    const assets = await extractPkPassAssets([{
      filename: "bad.pkpass", mimeType: "application/vnd.apple.pkpass", content: Buffer.from("not a zip"), s3Key: "content/att/bad.pkpass",
    }]);
    expect(assets).toEqual([]);
  });

  it("returns [] when pass.json is missing from the zip", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", "{}");
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" }) as Buffer;

    const assets = await extractPkPassAssets([{
      filename: "nopass.pkpass", mimeType: "application/vnd.apple.pkpass", content: zipBuf, s3Key: "content/att/nopass.pkpass",
    }]);
    expect(assets).toEqual([]);
  });

  it("uses filename (minus extension) as label when pass.json has no description", async () => {
    const passJson = { barcodes: [{ format: "PKBarcodeFormatQR", message: "NO-DESC" }] };
    const zipBuf = await makePkPassZip(passJson);

    const assets = await extractPkPassAssets([{
      filename: "boarding.pkpass", mimeType: "application/vnd.apple.pkpass", content: zipBuf, s3Key: "content/att/boarding.pkpass",
    }]);
    expect(assets[0]!.label).toBe("boarding");
  });
});

describe("extractAssets (orchestrator)", () => {
  it("merges results from inline QR and pkpass extractors", async () => {
    const qrBuf = await makeQrPngBuffer("INLINE-QR");
    const passJson = { description: "Pass", barcodes: [{ format: "PKBarcodeFormatQR", message: "PKPASS-BC" }] };
    const zipBuf = await makePkPassZip(passJson);

    const assets = await extractAssets(
      [{ mimeType: "image/png", content: qrBuf }],
      [{ filename: "pass.pkpass", mimeType: "application/vnd.apple.pkpass", content: zipBuf, s3Key: "content/att/pass.pkpass" }],
    );

    expect(assets).toHaveLength(2);
    expect(assets.map(a => a.rawValue).sort()).toEqual(["INLINE-QR", "PKPASS-BC"]);
  });

  it("deduplicates across extractors by rawValue", async () => {
    const qrBuf = await makeQrPngBuffer("SAME-VALUE");

    const assets = await extractAssets(
      [{ mimeType: "image/png", content: qrBuf }],
      [{ filename: "qr.png", mimeType: "image/png", content: qrBuf }],
    );

    expect(assets).toHaveLength(1);
    expect(assets[0]!.rawValue).toBe("SAME-VALUE");
  });

  it("returns [] when no inline images and no attachments", async () => {
    const assets = await extractAssets([], []);
    expect(assets).toEqual([]);
  });
});

describe("readImageDimensions", () => {
  it("reads width and height from a PNG header", () => {
    expect(readImageDimensions("png", makePlainPngBuffer(120, 80))).toEqual({ width: 120, height: 80 });
  });

  it("reads width and height from a JPEG SOF segment", () => {
    const jpeg = jpegJs.encode({ data: Buffer.alloc(64 * 48 * 4, 255), width: 64, height: 48 }, 90).data;
    expect(readImageDimensions("jpeg", jpeg)).toEqual({ width: 64, height: 48 });
  });

  it("returns null for bytes that are not a PNG/JPEG", () => {
    expect(readImageDimensions("png", Buffer.from("not an image"))).toBeNull();
    expect(readImageDimensions("jpeg", Buffer.from("not an image"))).toBeNull();
  });
});

describe("QR scan megapixel cap", () => {
  it("skips QR scanning for an image whose header declares more than 12MP, without decoding it", async () => {
    // Real QR PNG with the IHDR rewritten to claim 5000×5000 (25MP). If it were decoded the
    // pixel data would not match the header and decoding would fail; the cap must reject it first.
    const qrBuf = Buffer.from(await makeQrPngBuffer("https://example.com/ticket/big"));
    qrBuf.writeUInt32BE(5000, 16);
    qrBuf.writeUInt32BE(5000, 20);

    const issues: QrScanIssue[] = [];
    expect(extractQrFromInlineImages([{ mimeType: "image/png", content: qrBuf }], issues)).toEqual([]);
    expect(extractQrFromAttachments([{ filename: "big.png", mimeType: "image/png", content: qrBuf }], issues)).toEqual([]);
    expect(issues).toEqual([
      expect.objectContaining({ source: "inline_image", reason: "over_megapixel_cap", width: 5000, height: 5000 }),
      expect.objectContaining({ source: "attachment", reason: "over_megapixel_cap", filename: "big.png", width: 5000, height: 5000 }),
    ]);
  });
});

describe("QR scan issues", () => {
  it("reports an image whose header cannot be read", () => {
    const issues: QrScanIssue[] = [];
    extractQrFromInlineImages([{ mimeType: "image/png", content: Buffer.from("not a png at all") }], issues);
    expect(issues).toEqual([expect.objectContaining({ source: "inline_image", reason: "unreadable_dimensions", mimeType: "image/png" })]);
  });

  it("reports an image that fails to decode, with the decoder error", () => {
    // Valid header, truncated body.
    const truncated = makePlainPngBuffer(100, 100).subarray(0, 40);
    const issues: QrScanIssue[] = [];
    extractQrFromInlineImages([{ mimeType: "image/png", content: truncated }], issues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ reason: "decode_failed", width: 100, height: 100 });
    expect(issues[0]!.detail).toBeTruthy();
  });

  it("reports images beyond the per-message scan count", () => {
    const plain = makePlainPngBuffer(60, 60);
    const issues: QrScanIssue[] = [];
    extractQrFromAttachments(Array.from({ length: 7 }, (_, i) => ({ filename: `img${i}.png`, mimeType: "image/png", content: plain })), issues);
    expect(issues.map(i => i.reason)).toEqual(["over_image_count_limit", "over_image_count_limit"]);
    expect(issues.map(i => i.filename)).toEqual(["img5.png", "img6.png"]);
  });

  it("reports nothing for a normal image with no QR code", () => {
    const issues: QrScanIssue[] = [];
    extractQrFromInlineImages([{ mimeType: "image/png", content: makePlainPngBuffer(100, 100) }], issues);
    expect(issues).toEqual([]);
  });

  it("extractAssets collects issues from both inline images and attachments", async () => {
    const issues: QrScanIssue[] = [];
    await extractAssets(
      [{ mimeType: "image/png", content: Buffer.from("bad") }],
      [{ filename: "bad.jpg", mimeType: "image/jpeg", content: Buffer.from("bad") }],
      issues,
    );
    expect(issues.map(i => i.source).sort()).toEqual(["attachment", "inline_image"]);
  });
});
