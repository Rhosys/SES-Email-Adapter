import { describe, it, expect, vi } from "vitest";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import JSZip from "jszip";
import { extractQrFromHtmlBody, extractQrFromImageAttachments, extractPkPassAssets, extractResourceAssets } from "../../src/processor/asset-extractor.js";
import type { Attachment, Signal, EmailSignalData } from "../../src/types/index.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const NOW = "2024-06-15T10:30:00.000Z";
const SIGNAL_ID = "sgn-test-001";

async function makeQrPngBuffer(text: string): Promise<Buffer> {
  const dataUrl: string = await QRCode.toDataURL(text, { margin: 1, width: 100 });
  const b64 = dataUrl.split(",")[1]!;
  return Buffer.from(b64, "base64");
}

async function makeQrPngBase64(text: string): Promise<string> {
  return (await makeQrPngBuffer(text)).toString("base64");
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

function mockS3(files: Record<string, Buffer>) {
  return {
    send: vi.fn().mockImplementation((cmd: { input: { Key: string } }) => {
      const buf = files[cmd.input.Key];
      if (!buf) throw new Error("NoSuchKey");
      return Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(buf)) } });
    }),
  } as any;
}

function makeSignal(overrides: Partial<EmailSignalData> = {}): Signal<EmailSignalData> {
  return {
    id: SIGNAL_ID,
    signalLookupId: SIGNAL_ID,
    threadId: "thr-001",
    accountId: "acct-1",
    source: "email",
    type: "email",
    status: "active",
    labels: [],
    createdAt: NOW,
    data: {
      receivedAt: NOW,
      summary: "Test",
      actions: [],
      from: { address: "test@example.com" },
      to: [{ address: "inbox@example.com" }],
      cc: [],
      subject: "Test",
      attachments: [],
      headers: {},
      recipientAddress: "inbox@example.com",
      workflow: "events",
      workflowData: { workflow: "events", eventName: "Concert", eventStartDatetime: "2024-08-01T20:00:00Z" },
      tags: [],
      s3Key: "content/raw/test.eml",
      ...overrides,
    },
  } as Signal<EmailSignalData>;
}

describe("extractQrFromHtmlBody", () => {
  it("decodes a QR code from an inline data:image/png", async () => {
    const qrB64 = await makeQrPngBase64("https://example.com/ticket/123");
    const html = `<div><img src="data:image/png;base64,${qrB64}" alt="ticket"></div>`;

    const assets = extractQrFromHtmlBody(html, SIGNAL_ID, NOW);

    expect(assets).toHaveLength(1);
    expect(assets[0]!.type).toBe("qr_code");
    expect(assets[0]!.rawValue).toBe("https://example.com/ticket/123");
    expect(assets[0]!.sourceSignalId).toBe(SIGNAL_ID);
    expect(assets[0]!.extractedAt).toBe(NOW);
  });

  it("deduplicates by rawValue when the same QR appears twice", async () => {
    const qrB64 = await makeQrPngBase64("DUPE-VALUE");
    const html = `<img src="data:image/png;base64,${qrB64}"><img src="data:image/png;base64,${qrB64}">`;

    const assets = extractQrFromHtmlBody(html, SIGNAL_ID, NOW);
    expect(assets).toHaveLength(1);
  });

  it("returns [] when htmlBody has no inline images", () => {
    expect(extractQrFromHtmlBody("<p>Hello</p>", SIGNAL_ID, NOW)).toEqual([]);
  });

  it("returns [] when inline image has no QR code", () => {
    const plainB64 = makePlainPngBuffer(100, 100).toString("base64");
    const html = `<img src="data:image/png;base64,${plainB64}">`;

    expect(extractQrFromHtmlBody(html, SIGNAL_ID, NOW)).toEqual([]);
  });

  it("skips images smaller than 50x50", () => {
    const tinyB64 = makePlainPngBuffer(10, 10).toString("base64");
    const html = `<img src="data:image/png;base64,${tinyB64}">`;

    expect(extractQrFromHtmlBody(html, SIGNAL_ID, NOW)).toEqual([]);
  });

  it("returns [] on corrupt base64 data without throwing", () => {
    const html = `<img src="data:image/png;base64,NOT_VALID_BASE64_DATA!!">`;
    expect(() => extractQrFromHtmlBody(html, SIGNAL_ID, NOW)).not.toThrow();
    expect(extractQrFromHtmlBody(html, SIGNAL_ID, NOW)).toEqual([]);
  });
});

describe("extractQrFromImageAttachments", () => {
  it("decodes a QR code from a PNG image attachment", async () => {
    const qrBuf = await makeQrPngBuffer("ATT-QR-001");
    const att: Attachment = { filename: "qr.png", mimeType: "image/png", sizeBytes: qrBuf.length, s3Key: "content/att/qr.png" };
    const s3 = mockS3({ "content/att/qr.png": qrBuf });

    const assets = await extractQrFromImageAttachments([att], SIGNAL_ID, NOW, s3, "bucket");

    expect(assets).toHaveLength(1);
    expect(assets[0]!.rawValue).toBe("ATT-QR-001");
  });

  it("skips non-image attachments", async () => {
    const att: Attachment = { filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 100, s3Key: "content/att/doc.pdf" };
    const s3 = mockS3({});

    const assets = await extractQrFromImageAttachments([att], SIGNAL_ID, NOW, s3, "bucket");
    expect(assets).toEqual([]);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("returns [] when S3 fetch fails", async () => {
    const att: Attachment = { filename: "qr.png", mimeType: "image/png", sizeBytes: 100, s3Key: "content/att/missing.png" };
    const s3 = mockS3({});

    const assets = await extractQrFromImageAttachments([att], SIGNAL_ID, NOW, s3, "bucket");
    expect(assets).toEqual([]);
  });

  it("returns [] when image has no QR code", async () => {
    const plainBuf = makePlainPngBuffer(100, 100);
    const att: Attachment = { filename: "photo.png", mimeType: "image/png", sizeBytes: plainBuf.length, s3Key: "content/att/photo.png" };
    const s3 = mockS3({ "content/att/photo.png": plainBuf });

    const assets = await extractQrFromImageAttachments([att], SIGNAL_ID, NOW, s3, "bucket");
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
    const att: Attachment = { filename: "boardingpass.pkpass", mimeType: "application/vnd.apple.pkpass", sizeBytes: zipBuf.length, s3Key: "content/att/boardingpass.pkpass" };
    const s3 = mockS3({ "content/att/boardingpass.pkpass": zipBuf });

    const assets = await extractPkPassAssets([att], SIGNAL_ID, NOW, s3, "bucket");

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
    const att: Attachment = { filename: "ticket.pkpass", mimeType: "application/vnd.apple.pkpass", sizeBytes: zipBuf.length, s3Key: "content/att/ticket.pkpass" };
    const s3 = mockS3({ "content/att/ticket.pkpass": zipBuf });

    const assets = await extractPkPassAssets([att], SIGNAL_ID, NOW, s3, "bucket");

    expect(assets).toHaveLength(1);
    expect(assets[0]!.rawValue).toBe("TICKET-999");
  });

  it("detects pkpass by filename extension when MIME type is generic", async () => {
    const passJson = { barcodes: [{ format: "PKBarcodeFormatQR", message: "GENERIC-MIME" }] };
    const zipBuf = await makePkPassZip(passJson);
    const att: Attachment = { filename: "pass.pkpass", mimeType: "application/octet-stream", sizeBytes: zipBuf.length, s3Key: "content/att/pass.pkpass" };
    const s3 = mockS3({ "content/att/pass.pkpass": zipBuf });

    const assets = await extractPkPassAssets([att], SIGNAL_ID, NOW, s3, "bucket");
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
    const att: Attachment = { filename: "multi.pkpass", mimeType: "application/vnd.apple.pkpass", sizeBytes: zipBuf.length, s3Key: "content/att/multi.pkpass" };
    const s3 = mockS3({ "content/att/multi.pkpass": zipBuf });

    const assets = await extractPkPassAssets([att], SIGNAL_ID, NOW, s3, "bucket");
    expect(assets).toHaveLength(2);
  });

  it("returns [] for a corrupt pkpass ZIP", async () => {
    const att: Attachment = { filename: "bad.pkpass", mimeType: "application/vnd.apple.pkpass", sizeBytes: 10, s3Key: "content/att/bad.pkpass" };
    const s3 = mockS3({ "content/att/bad.pkpass": Buffer.from("not a zip") });

    const assets = await extractPkPassAssets([att], SIGNAL_ID, NOW, s3, "bucket");
    expect(assets).toEqual([]);
  });

  it("returns [] when pass.json is missing from the zip", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", "{}");
    const zipBuf = await zip.generateAsync({ type: "nodebuffer" }) as Buffer;
    const att: Attachment = { filename: "nopass.pkpass", mimeType: "application/vnd.apple.pkpass", sizeBytes: zipBuf.length, s3Key: "content/att/nopass.pkpass" };
    const s3 = mockS3({ "content/att/nopass.pkpass": zipBuf });

    const assets = await extractPkPassAssets([att], SIGNAL_ID, NOW, s3, "bucket");
    expect(assets).toEqual([]);
  });

  it("uses filename (minus extension) as label when pass.json has no description", async () => {
    const passJson = { barcodes: [{ format: "PKBarcodeFormatQR", message: "NO-DESC" }] };
    const zipBuf = await makePkPassZip(passJson);
    const att: Attachment = { filename: "boarding.pkpass", mimeType: "application/vnd.apple.pkpass", sizeBytes: zipBuf.length, s3Key: "content/att/boarding.pkpass" };
    const s3 = mockS3({ "content/att/boarding.pkpass": zipBuf });

    const assets = await extractPkPassAssets([att], SIGNAL_ID, NOW, s3, "bucket");
    expect(assets[0]!.label).toBe("boarding");
  });
});

describe("extractResourceAssets (orchestrator)", () => {
  it("merges results from inline QR and pkpass extractors", async () => {
    const qrB64 = await makeQrPngBase64("INLINE-QR");
    const passJson = { description: "Pass", barcodes: [{ format: "PKBarcodeFormatQR", message: "PKPASS-BC" }] };
    const zipBuf = await makePkPassZip(passJson);

    const signal = makeSignal({
      htmlBody: `<img src="data:image/png;base64,${qrB64}">`,
      attachments: [{ filename: "pass.pkpass", mimeType: "application/vnd.apple.pkpass", sizeBytes: zipBuf.length, s3Key: "content/att/pass.pkpass" }],
    });
    const s3 = mockS3({ "content/att/pass.pkpass": zipBuf });

    const assets = await extractResourceAssets(signal, s3, "bucket", createMockLogger());

    expect(assets).toHaveLength(2);
    expect(assets.map(a => a.rawValue).sort()).toEqual(["INLINE-QR", "PKPASS-BC"]);
  });

  it("deduplicates across extractors by rawValue", async () => {
    const qrB64 = await makeQrPngBase64("SAME-VALUE");
    const qrBuf = await makeQrPngBuffer("SAME-VALUE");

    const signal = makeSignal({
      htmlBody: `<img src="data:image/png;base64,${qrB64}">`,
      attachments: [{ filename: "qr.png", mimeType: "image/png", sizeBytes: qrBuf.length, s3Key: "content/att/qr.png" }],
    });
    const s3 = mockS3({ "content/att/qr.png": qrBuf });

    const assets = await extractResourceAssets(signal, s3, "bucket", createMockLogger());

    expect(assets).toHaveLength(1);
    expect(assets[0]!.rawValue).toBe("SAME-VALUE");
  });

  it("returns [] when signal has no htmlBody and no attachments", async () => {
    const signal = makeSignal({ attachments: [] });
    delete (signal.data as unknown as Record<string, unknown>).htmlBody;
    const s3 = mockS3({});

    const assets = await extractResourceAssets(signal, s3, "bucket", createMockLogger());
    expect(assets).toEqual([]);
  });

  it("never throws — returns [] on unexpected failure", async () => {
    const signal = makeSignal();
    const s3 = { send: vi.fn().mockRejectedValue(new Error("boom")) } as any;

    const assets = await extractResourceAssets(signal, s3, "bucket", createMockLogger());
    expect(assets).toEqual([]);
  });
});
