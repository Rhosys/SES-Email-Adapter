import { createRequire } from "node:module";
import { PNG } from "pngjs";
import * as jpegJs from "jpeg-js";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const jsQR = require("jsqr") as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

const MAX_INLINE_IMAGES = 10;
const MAX_ATTACHMENT_IMAGES = 5;
const MIN_QR_DIMENSION = 50;
// QR scanning needs the image fully decoded to RGBA (4 bytes/pixel) plus jsQR's own
// greyscale + binarized copies — ~7 bytes/pixel at peak, so 12MP ≈ 85MB. Images above this
// are not scanned for QR codes (they are still stored and displayed as normal). Checked from
// the file header before decoding, so a small file that decodes huge is never decoded.
const MAX_QR_SCAN_MEGAPIXELS = 12;
// Backstop inside jpeg-js itself (its default is 512MB) in case the header check is fooled.
const MAX_JPEG_DECODE_MEMORY_MB = 100;

export interface ExtractedAsset {
  type: "qr_code" | "pkpass";
  label: string;
  rawValue: string;
  s3Key?: string;
}

/**
 * An image that was not (fully) scanned for a QR code. Returned to the processor in the
 * sanitizer response so it can log it — nothing here is user-facing.
 */
export interface QrScanIssue {
  source: "inline_image" | "attachment" | "extraction";
  reason: "over_megapixel_cap" | "unreadable_dimensions" | "decode_failed" | "over_image_count_limit" | "extraction_failed";
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  detail?: string;
}

interface AttachmentWithBytes {
  filename: string;
  mimeType: string;
  content: Buffer;
  s3Key?: string;
}

/** Reads width/height from a PNG IHDR chunk or a JPEG SOF segment without decoding. */
export function readImageDimensions(format: string, bytes: Buffer): { width: number; height: number } | null {
  if (format === "png") {
    // 8-byte signature, then IHDR: length(4) "IHDR"(4) width(4) height(4)
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset++; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; } // no length
    const length = bytes.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > bytes.length) return null;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function decodePixels(format: string, bytes: Buffer): { data: Uint8ClampedArray; width: number; height: number } | null {
  if (format === "png") {
    const png = PNG.sync.read(bytes);
    // View over the decoded buffer — copying it would double an already width×height×4 allocation.
    return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  }
  const jpeg = jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_QR_SCAN_MEGAPIXELS, maxMemoryUsageInMB: MAX_JPEG_DECODE_MEMORY_MB });
  return { data: new Uint8ClampedArray(jpeg.data.buffer, jpeg.data.byteOffset, jpeg.data.length), width: jpeg.width, height: jpeg.height };
}

type ScanOutcome = { value: string | null } | { issue: Pick<QrScanIssue, "reason" | "width" | "height" | "detail"> };

function scanQrFromBytes(format: string, bytes: Buffer): ScanOutcome {
  const dimensions = readImageDimensions(format, bytes);
  if (!dimensions) return { issue: { reason: "unreadable_dimensions" } };
  if (dimensions.width * dimensions.height > MAX_QR_SCAN_MEGAPIXELS * 1_000_000) {
    return { issue: { reason: "over_megapixel_cap", width: dimensions.width, height: dimensions.height, detail: `cap is ${MAX_QR_SCAN_MEGAPIXELS}MP` } };
  }
  let pixels;
  try {
    pixels = decodePixels(format, bytes);
  } catch (e) {
    return { issue: { reason: "decode_failed", width: dimensions.width, height: dimensions.height, detail: e instanceof Error ? e.message : String(e) } };
  }
  if (!pixels || pixels.width < MIN_QR_DIMENSION || pixels.height < MIN_QR_DIMENSION) return { value: null };
  const qr = jsQR(pixels.data, pixels.width, pixels.height);
  return { value: qr?.data || null };
}

function scanImages(
  images: Array<{ mimeType: string; content: Buffer; filename?: string }>,
  limit: number,
  source: "inline_image" | "attachment",
  issues?: QrScanIssue[],
): ExtractedAsset[] {
  const assets: ExtractedAsset[] = [];
  const seen = new Set<string>();
  const describe = (img: { mimeType: string; content: Buffer; filename?: string }) => ({
    source, mimeType: img.mimeType, sizeBytes: img.content.length, ...(img.filename ? { filename: img.filename } : {}),
  });

  for (const img of images.slice(limit)) {
    issues?.push({ ...describe(img), reason: "over_image_count_limit", detail: `only the first ${limit} are scanned` });
  }
  for (const img of images.slice(0, limit)) {
    const format = img.mimeType.includes("png") ? "png" : "jpeg";
    let outcome: ScanOutcome;
    try {
      outcome = scanQrFromBytes(format, img.content);
    } catch (e) {
      outcome = { issue: { reason: "decode_failed", detail: e instanceof Error ? e.message : String(e) } };
    }
    if ("issue" in outcome) {
      issues?.push({ ...describe(img), ...outcome.issue });
      continue;
    }
    if (outcome.value && !seen.has(outcome.value)) {
      seen.add(outcome.value);
      assets.push({ type: "qr_code", label: "QR code", rawValue: outcome.value });
    }
  }

  return assets;
}

export function extractQrFromInlineImages(inlineImages: Array<{ mimeType: string; content: Buffer }>, issues?: QrScanIssue[]): ExtractedAsset[] {
  return scanImages(inlineImages, MAX_INLINE_IMAGES, "inline_image", issues);
}

export function extractQrFromAttachments(attachments: AttachmentWithBytes[], issues?: QrScanIssue[]): ExtractedAsset[] {
  const images = attachments.filter(a => /^image\/(png|jpeg|jpg)$/i.test(a.mimeType));
  return scanImages(images, MAX_ATTACHMENT_IMAGES, "attachment", issues);
}

export async function extractPkPassAssets(attachments: AttachmentWithBytes[]): Promise<ExtractedAsset[]> {
  const assets: ExtractedAsset[] = [];
  const pkpassFiles = attachments.filter(a => a.mimeType === "application/vnd.apple.pkpass" || a.filename.endsWith(".pkpass"));

  for (const att of pkpassFiles) {
    try {
      const zip = await JSZip.loadAsync(att.content);
      const passFile = zip.file("pass.json");
      if (!passFile) continue;
      const passText = await passFile.async("text");
      const pass = JSON.parse(passText) as {
        description?: string;
        barcodes?: Array<{ format: string; message: string; messageEncoding?: string }>;
        barcode?: { format: string; message: string; messageEncoding?: string };
      };

      const barcodes = pass.barcodes ?? (pass.barcode ? [pass.barcode] : []);
      const label = pass.description ?? att.filename.replace(/\.pkpass$/i, "");

      for (const bc of barcodes) {
        if (!bc.message) continue;
        assets.push({
          type: "pkpass", label, rawValue: bc.message,
          ...(att.s3Key ? { s3Key: att.s3Key } : {}),
        });
      }
    } catch {
      // corrupt pkpass — skip
    }
  }

  return assets;
}

export async function extractAssets(
  inlineImages: Array<{ mimeType: string; content: Buffer }>,
  attachments: AttachmentWithBytes[],
  issues?: QrScanIssue[],
): Promise<ExtractedAsset[]> {
  try {
    const [inlineQr, attachmentQr, pkpass] = await Promise.all([
      Promise.resolve(extractQrFromInlineImages(inlineImages, issues)),
      Promise.resolve(extractQrFromAttachments(attachments, issues)),
      extractPkPassAssets(attachments),
    ]);

    const all = [...inlineQr, ...attachmentQr, ...pkpass];

    const seen = new Set<string>();
    return all.filter(a => {
      if (seen.has(a.rawValue)) return false;
      seen.add(a.rawValue);
      return true;
    });
  } catch (e) {
    issues?.push({ source: "extraction", reason: "extraction_failed", detail: e instanceof Error ? e.message : String(e) });
    return [];
  }
}
