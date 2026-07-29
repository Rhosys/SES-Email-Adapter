import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jsQR = require("jsqr") as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
import { PNG } from "pngjs";
import * as jpegJs from "jpeg-js";
import JSZip from "jszip";
import type { Signal, Attachment, ResourceAsset, EmailSignalData } from "../types/index.js";
import type { Logger } from "../logger.js";

const MAX_INLINE_IMAGES = 10;
const MAX_ATTACHMENT_IMAGES = 5;
const MIN_QR_DIMENSION = 50;

const DATA_URI_RE = /src="data:image\/(png|jpeg|jpg);base64,([^"]+)"/gi;

function decodePixels(format: string, bytes: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } | null {
  if (format === "png") {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  const jpeg = jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(jpeg.data), width: jpeg.width, height: jpeg.height };
}

export function extractQrFromHtmlBody(htmlBody: string, signalId: string, now: string): ResourceAsset[] {
  const assets: ResourceAsset[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  let count = 0;

  DATA_URI_RE.lastIndex = 0;
  while ((match = DATA_URI_RE.exec(htmlBody)) !== null && count < MAX_INLINE_IMAGES) {
    count++;
    try {
      const format = match[1]!.replace("jpg", "jpeg");
      const b64 = match[2]!;
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      const pixels = decodePixels(format, bytes);
      if (!pixels || pixels.width < MIN_QR_DIMENSION || pixels.height < MIN_QR_DIMENSION) continue;
      const qr = jsQR(pixels.data, pixels.width, pixels.height);
      if (qr && qr.data && !seen.has(qr.data)) {
        seen.add(qr.data);
        assets.push({ type: "qr_code", label: "QR code", rawValue: qr.data, sourceSignalId: signalId, extractedAt: now });
      }
    } catch {
      // corrupt image — skip
    }
  }

  return assets;
}

export async function extractQrFromImageAttachments(
  attachments: Attachment[], signalId: string, now: string, s3Client: S3Client, bucket: string,
): Promise<ResourceAsset[]> {
  const assets: ResourceAsset[] = [];
  const seen = new Set<string>();
  const images = attachments.filter(a => /^image\/(png|jpeg|jpg)$/i.test(a.mimeType)).slice(0, MAX_ATTACHMENT_IMAGES);

  for (const att of images) {
    try {
      const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: att.s3Key }));
      const bytes = new Uint8Array(await res.Body!.transformToByteArray());
      const format = att.mimeType.includes("png") ? "png" : "jpeg";
      const pixels = decodePixels(format, bytes);
      if (!pixels || pixels.width < MIN_QR_DIMENSION || pixels.height < MIN_QR_DIMENSION) continue;
      const qr = jsQR(pixels.data, pixels.width, pixels.height);
      if (qr && qr.data && !seen.has(qr.data)) {
        seen.add(qr.data);
        assets.push({ type: "qr_code", label: "QR code", rawValue: qr.data, sourceSignalId: signalId, extractedAt: now });
      }
    } catch {
      // S3 fetch or decode failure — skip
    }
  }

  return assets;
}

export async function extractPkPassAssets(
  attachments: Attachment[], signalId: string, now: string, s3Client: S3Client, bucket: string,
): Promise<ResourceAsset[]> {
  const assets: ResourceAsset[] = [];
  const pkpassFiles = attachments.filter(a => a.mimeType === "application/vnd.apple.pkpass" || a.filename.endsWith(".pkpass"));

  for (const att of pkpassFiles) {
    try {
      const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: att.s3Key }));
      const bytes = await res.Body!.transformToByteArray();
      const zip = await JSZip.loadAsync(bytes);
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
          type: "pkpass", label, rawValue: bc.message, sourceSignalId: signalId,
          s3Key: att.s3Key, extractedAt: now,
        });
      }
    } catch {
      // corrupt pkpass — skip
    }
  }

  return assets;
}

export async function extractResourceAssets(
  signal: Signal<EmailSignalData>, s3Client: S3Client, bucket: string, logger: Logger,
): Promise<ResourceAsset[]> {
  const now = new Date().toISOString();
  const signalId = signal.id;
  const attachments = signal.data.attachments ?? [];

  try {
    const results = await Promise.all([
      signal.data.htmlBody ? Promise.resolve(extractQrFromHtmlBody(signal.data.htmlBody, signalId, now)) : Promise.resolve([]),
      extractQrFromImageAttachments(attachments, signalId, now, s3Client, bucket),
      extractPkPassAssets(attachments, signalId, now, s3Client, bucket),
    ]);

    const all = results.flat();

    // Deduplicate by rawValue
    const seen = new Set<string>();
    const deduped = all.filter(a => {
      if (seen.has(a.rawValue)) return false;
      seen.add(a.rawValue);
      return true;
    });

    if (deduped.length > 0) {
      logger.trackPoint("assets_extracted", { count: deduped.length, types: [...new Set(deduped.map(a => a.type))] });
    }

    return deduped;
  } catch {
    logger.warn("Asset extraction failed unexpectedly", { code: "processor.asset_extraction_failed" });
    return [];
  }
}
