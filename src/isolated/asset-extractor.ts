import { createRequire } from "node:module";
import { PNG } from "pngjs";
import * as jpegJs from "jpeg-js";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const jsQR = require("jsqr") as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

const MAX_INLINE_IMAGES = 10;
const MAX_ATTACHMENT_IMAGES = 5;
const MIN_QR_DIMENSION = 50;

export interface ExtractedAsset {
  type: "qr_code" | "pkpass";
  label: string;
  rawValue: string;
  s3Key?: string;
}

interface AttachmentWithBytes {
  filename: string;
  mimeType: string;
  content: Buffer;
  s3Key?: string;
}

function decodePixels(format: string, bytes: Buffer): { data: Uint8ClampedArray; width: number; height: number } | null {
  if (format === "png") {
    const png = PNG.sync.read(bytes);
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  const jpeg = jpegJs.decode(new Uint8Array(bytes), { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(jpeg.data), width: jpeg.width, height: jpeg.height };
}

function scanQrFromBytes(format: string, bytes: Buffer): string | null {
  const pixels = decodePixels(format, bytes);
  if (!pixels || pixels.width < MIN_QR_DIMENSION || pixels.height < MIN_QR_DIMENSION) return null;
  const qr = jsQR(pixels.data, pixels.width, pixels.height);
  return qr?.data || null;
}

export function extractQrFromInlineImages(inlineImages: Array<{ mimeType: string; content: Buffer }>): ExtractedAsset[] {
  const assets: ExtractedAsset[] = [];
  const seen = new Set<string>();

  for (const img of inlineImages.slice(0, MAX_INLINE_IMAGES)) {
    try {
      const format = img.mimeType.includes("png") ? "png" : "jpeg";
      const value = scanQrFromBytes(format, img.content);
      if (value && !seen.has(value)) {
        seen.add(value);
        assets.push({ type: "qr_code", label: "QR code", rawValue: value });
      }
    } catch {
      // corrupt image — skip
    }
  }

  return assets;
}

export function extractQrFromAttachments(attachments: AttachmentWithBytes[]): ExtractedAsset[] {
  const assets: ExtractedAsset[] = [];
  const seen = new Set<string>();
  const images = attachments.filter(a => /^image\/(png|jpeg|jpg)$/i.test(a.mimeType)).slice(0, MAX_ATTACHMENT_IMAGES);

  for (const att of images) {
    try {
      const format = att.mimeType.includes("png") ? "png" : "jpeg";
      const value = scanQrFromBytes(format, att.content);
      if (value && !seen.has(value)) {
        seen.add(value);
        assets.push({ type: "qr_code", label: "QR code", rawValue: value });
      }
    } catch {
      // decode failure — skip
    }
  }

  return assets;
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
): Promise<ExtractedAsset[]> {
  try {
    const [inlineQr, attachmentQr, pkpass] = await Promise.all([
      Promise.resolve(extractQrFromInlineImages(inlineImages)),
      Promise.resolve(extractQrFromAttachments(attachments)),
      extractPkPassAssets(attachments),
    ]);

    const all = [...inlineQr, ...attachmentQr, ...pkpass];

    const seen = new Set<string>();
    return all.filter(a => {
      if (seen.has(a.rawValue)) return false;
      seen.add(a.rawValue);
      return true;
    });
  } catch {
    return [];
  }
}
