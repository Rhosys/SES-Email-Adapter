import { simpleParser } from "mailparser";
import { Window } from "happy-dom";
import { sanitizeHtml } from "./html-sanitizer.js";
import { extractAssets, type ExtractedAsset } from "./asset-extractor.js";
import { buildDisplayRawEmail } from "./raw-email-display.js";
import type { Logger } from "../logger.js";
import { S3ObjectStorage, type PresignedPost, type UploadField } from "../s3-object-storage.js";
import { resolveContentType, ensureFilenameExtension, buildContentDisposition } from "./mime.js";

// Lambda timeout is 60s (see deploy/compute.tf). Emitting a TRACK log past this
// threshold surfaces invocations that are close to timing out, before they start
// actually failing — mirrors the api.slow_request pattern in src/api/app.ts.
const SLOW_INVOCATION_THRESHOLD_MS = 50_000;

// Lower-bar threshold so a message that's merely slow to parse (large/complex MIME,
// many attachments) shows up before it gets anywhere near the 50s near-timeout alert —
// gives us an early signal to look at parsing performance, not just imminent failures.
const SLOW_PARSE_THRESHOLD_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailAddress {
  address: string;
  name?: string;
}

interface AttachmentRef {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
}

interface DroppedAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  reason: "too_large" | "upload_failed";
  /** Populated for "upload_failed" — the HTTP status or caught error that made the S3 upload fail. */
  detail?: string;
}

/**
 * Builds a human-readable reason summary for the TRACK log title — not just the payload.
 * Reasons carrying a `detail` (currently only "upload_failed") are listed individually
 * with their full detail text, since that's the actual "why" and different attachments
 * can fail for different reasons; reasons with no further detail (e.g. "too_large") are
 * collapsed into a single count.
 */
function summarizeDroppedReasons(dropped: { reason: string; detail?: string }[]): string {
  const parts: string[] = [];
  const countsByReason = new Map<string, number>();
  for (const d of dropped) {
    if (d.detail) {
      parts.push(`${d.reason}: ${d.detail}`);
    } else {
      countsByReason.set(d.reason, (countsByReason.get(d.reason) ?? 0) + 1);
    }
  }
  for (const [reason, count] of countsByReason) parts.push(`${count} ${reason}`);
  return parts.join("; ");
}

interface InlineImageRef {
  contentId: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
  // A display name carried so that, if this image turns out NOT to be referenced by the
  // rendered body, it can be promoted into the attachment list (see the body-or-attachments
  // reclassification after HTML sanitization) with a meaningful, extension-bearing name.
  filename: string;
}

interface ContentSanitizeRequest {
  presignedGetUrl: string;
  presignedPost: PresignedPost<UploadField>;
  accountId: string;
  senderEtld1: string;
  keyPrefix: string;
  retentionTag: "365" | "3650" | null;
  invocationId?: string;
}

interface ExtractedLink {
  url: string;
  text: string | null;
}

interface ContentSanitizeResponse {
  success: true;
  parsed: {
    from: EmailAddress;
    to: EmailAddress[];
    cc: EmailAddress[];
    replyTo?: EmailAddress;
    subject: string;
    textBody?: string;
    htmlBody?: string;
    attachments: AttachmentRef[];
    headers: Record<string, string>;
    sentAt?: string;
    assets?: ExtractedAsset[];
    links?: ExtractedLink[];
    droppedAttachments?: DroppedAttachment[];
    inlineImages?: InlineImageRef[];
    displayRawS3Key?: string;
  };
}

interface ContentSanitizeError {
  success: false;
  error: {
    message: string;
    type: "parse_error" | "limits_exceeded" | "missing_sender" | "fetch_failed" | "internal_error";
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTACHMENTS = 50;
const MAX_TOTAL_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_SINGLE_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB

// DynamoDB's per-item cap is 400KB; MAX_HTML_BODY_BYTES in processor.ts already reserves
// 300KB of that for htmlBody as a last-resort truncation guard. These two caps keep most
// messages from ever needing that guard: a data URI runs ~33% larger than its source bytes,
// so 3 images at 100KB each tops out around 400KB of embedded text — big enough for a
// typical logo/signature image, small enough that inline images can't silently balloon
// htmlBody the way an unbounded embed would. Anything past either cap is uploaded to S3
// instead (see InlineImageRef) and resolved to a CDN url at API read time.
const MAX_INLINE_DATA_URI_SIZE = 100 * 1024; // 100KB
const MAX_INLINE_DATA_URI_COUNT = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders a text/plain body as safe HTML for display when the message has no
 * text/html part at all (e.g. plain-text-only newsletters). The result is
 * already escaped, so it is not passed through sanitizeHtml/DOMPurify.
 */
function textToHtml(text: string): string {
  return `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(text)}</pre>`;
}

function parseAddress(addr: unknown): EmailAddress | undefined {
  if (!addr || typeof addr !== "object") return undefined;
  const obj = addr as { value?: Array<{ address?: string; name?: string }> };
  const first = obj.value?.[0];
  if (!first?.address) return undefined;
  return { address: first.address, ...(first.name ? { name: first.name } : {}) };
}

function parseAddressList(addr: unknown): EmailAddress[] {
  if (!addr || typeof addr !== "object") return [];
  const obj = addr as { value?: Array<{ address?: string; name?: string }> };
  if (!obj.value) return [];
  return obj.value
    .filter((v): v is { address: string; name?: string } => Boolean(v.address))
    .map(v => ({ address: v.address, ...(v.name ? { name: v.name } : {}) }));
}

// Thin adapter over the shared S3ObjectStorage.upload primitive. The isolate holds no AWS
// credentials, so it only ever POSTs to a ticket it was handed — S3ObjectStorage.upload is
// static and touches no S3 client. Keeps the local { ok, detail } shape the callsites below
// branch on; all S3 field-name/policy handling lives in S3ObjectStorage.
async function uploadViaPresignedPost(
  presignedPost: PresignedPost<UploadField>,
  s3Key: string,
  content: Buffer | Uint8Array,
  contentType: string,
  contentDisposition?: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const result = await S3ObjectStorage.upload(presignedPost, s3Key, content, contentType, contentDisposition);
  if (result.isErr()) return { ok: false, detail: result.error.reason };
  return { ok: true };
}


// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Wraps processEmail so that any exception we didn't anticipate becomes a structured
// ContentSanitizeError instead of an opaque Lambda "Unhandled" FunctionError — the
// processor can then surface the real message/type instead of just "Unhandled".
export async function handler(event: ContentSanitizeRequest): Promise<ContentSanitizeResponse | ContentSanitizeError> {
  const start = Date.now();
  let logger: Logger | undefined;
  if (event.invocationId) {
    const { RequestLogger } = await import("../logger.js");
    const requestLogger = new RequestLogger();
    requestLogger.startInvocation(event.invocationId);
    requestLogger.info("content-sanitizer.invoked", { code: "content_sanitizer.invoked", invocationId: event.invocationId, accountId: event.accountId });
    logger = requestLogger;
  }

  // Fires on its own clock at the 50s mark regardless of whether processEmail ever
  // settles — a stuck fetch/parse would never reach a `finally` after `await`, since
  // the await itself never returns. This is a plain timer, not a Promise.race, precisely
  // so it still fires even if the awaited work hangs all the way to the Lambda timeout.
  const slowInvocationTimer = setTimeout(() => {
    logger?.track("Content sanitizer invocation exceeded 50s — at risk of Lambda timeout.", { code: "content_sanitizer.slow_invocation", elapsedMs: Date.now() - start, accountId: event.accountId });
  }, SLOW_INVOCATION_THRESHOLD_MS);

  try {
    return await processEmail(event, logger);
  } catch (e) {
    return {
      success: false,
      error: { message: e instanceof Error ? e.message : String(e), type: "internal_error" },
    };
  } finally {
    clearTimeout(slowInvocationTimer);
  }
}

async function processEmail(event: ContentSanitizeRequest, logger?: Logger): Promise<ContentSanitizeResponse | ContentSanitizeError> {
  // 1. Fetch raw MIME via presignedGetUrl
  logger?.trackPoint("fetch_mime_start");
  let rawMime: Buffer;
  try {
    const response = await fetch(event.presignedGetUrl);
    if (!response.ok) {
      return {
        success: false,
        error: { message: `Failed to fetch MIME: HTTP ${response.status}`, type: "fetch_failed" },
      };
    }
    rawMime = Buffer.from(await response.arrayBuffer());
    logger?.trackPoint("fetch_mime_complete", { sizeBytes: rawMime.length });
  } catch (e) {
    return {
      success: false,
      error: { message: `Failed to fetch MIME: ${e instanceof Error ? e.message : "unknown error"}`, type: "fetch_failed" },
    };
  }

  // 1b. Build a display-safe copy of the raw MIME (attachments stripped, small inline
  // images kept — see raw-email-display.ts) and upload it. This is what the "view original
  // email" / download-as-.eml feature serves; the true original is never exposed through
  // that path. Best-effort — a failure here must not fail the whole sanitize, the feature
  // just falls back to unavailable for this message.
  logger?.trackPoint("display_raw_build_start");
  let displayRawS3Key: string | undefined;
  try {
    const displayRaw = buildDisplayRawEmail(rawMime.toString("latin1"));
    const key = `${event.keyPrefix}raw-display.eml`;
    const uploadResult = await uploadViaPresignedPost(event.presignedPost, key, Buffer.from(displayRaw, "latin1"), "message/rfc822");
    if (uploadResult.ok) displayRawS3Key = key;
    logger?.trackPoint("display_raw_build_complete", { uploaded: uploadResult.ok, ...(uploadResult.ok ? {} : { detail: uploadResult.detail }) });
  } catch {
    logger?.trackPoint("display_raw_build_failed");
  }

  // 2. Parse with mailparser
  logger?.trackPoint("mime_parse_start");
  const parseStart = Date.now();
  let parsed;
  try {
    // keepCidLinks: mailparser's default behaviour is to eagerly replace every `cid:`
    // reference in the HTML with a base64 data URI itself, before this file ever sees the
    // parsed message — which would silently bypass the inline-image size/count budget below.
    // With this set, `cid:` references are left as-is in parsed.html for us to resolve.
    parsed = await simpleParser(rawMime, { keepCidLinks: true });
    const parseElapsedMs = Date.now() - parseStart;
    logger?.trackPoint("mime_parse_complete");
    if (parseElapsedMs > SLOW_PARSE_THRESHOLD_MS) {
      logger?.track("MIME parse exceeded 10s.", { code: "content_sanitizer.slow_parse", elapsedMs: parseElapsedMs, sizeBytes: rawMime.length, accountId: event.accountId });
    }
  } catch (e) {
    return {
      success: false,
      error: { message: `MIME parse error: ${e instanceof Error ? e.message : "unknown error"}`, type: "parse_error" },
    };
  }

  // 3. Validate: from present
  const from = parseAddress(parsed.from);
  if (!from) {
    return {
      success: false,
      error: { message: "Sender address is required", type: "missing_sender" },
    };
  }

  // 4. Validate: attachment count ≤ 50, total size ≤ 25MB
  const attachments = parsed.attachments ?? [];
  if (attachments.length > MAX_ATTACHMENTS) {
    return {
      success: false,
      error: { message: `Message has ${attachments.length} attachments, exceeds limit of ${MAX_ATTACHMENTS}`, type: "limits_exceeded" },
    };
  }

  const totalAttachmentSize = attachments.reduce((sum, a) => sum + a.size, 0);
  if (totalAttachmentSize > MAX_TOTAL_ATTACHMENT_SIZE) {
    return {
      success: false,
      error: { message: `Total attachment size ${totalAttachmentSize} bytes exceeds limit of 25MB`, type: "limits_exceeded" },
    };
  }
  logger?.trackPoint("attachment_limits_validated", { attachmentCount: attachments.length, totalAttachmentSize });

  // 5. Build CID map for inline images and upload real attachments to S3
  let uploadIndex = 0;
  const attachmentRefs: AttachmentRef[] = [];
  const cidMap: Record<string, string> = {};
  const inlineImages: Array<{ mimeType: string; content: Buffer }> = [];
  const attachmentsWithBytes: Array<{ filename: string; mimeType: string; content: Buffer; s3Key?: string }> = [];
  const droppedAttachments: DroppedAttachment[] = [];
  const inlineImageRefs: InlineImageRef[] = [];
  let inlinedDataUriCount = 0;

  for (const attachment of attachments) {
    // Recover the true content type: a mislabeled or absent header (senders routinely ship
    // PDFs/images as octet-stream) breaks the dashboard's inline preview and the served S3
    // Content-Type. resolveContentType trusts magic bytes first, then a specific declared
    // type, then the filename extension.
    const contentType = resolveContentType({
      content: attachment.content,
      declaredType: attachment.contentType,
      filename: attachment.filename,
    });

    if (attachment.size > MAX_SINGLE_ATTACHMENT_SIZE) {
      droppedAttachments.push({
        filename: ensureFilenameExtension(attachment.filename ?? `attachment-${uploadIndex}`, contentType),
        mimeType: contentType,
        sizeBytes: attachment.size,
        reason: "too_large",
      });
      continue;
    }

    // `cid` (not `contentId`) is the bracket-stripped form mailparser itself matches
    // `cid:` references against — it's what appears bare in `<img src="cid:...">`.
    // Gmail adds Content-ID to ALL parts (even PDFs, pkpass, ICS) — only treat as
    // inline when the part is NOT explicitly marked Content-Disposition: attachment.
    if (attachment.cid && attachment.contentDisposition !== "attachment") {
      const cid = attachment.cid;
      const fitsInlineBudget = attachment.size <= MAX_INLINE_DATA_URI_SIZE && inlinedDataUriCount < MAX_INLINE_DATA_URI_COUNT;

      if (fitsInlineBudget) {
        // Small inline image, still within the per-message budget — embed as a data URI, no S3 upload needed
        cidMap[cid] = `data:${contentType};base64,${attachment.content.toString("base64")}`;
        inlinedDataUriCount++;
        if (contentType.startsWith("image/")) {
          inlineImages.push({ mimeType: contentType, content: attachment.content });
        }
      } else {
        // Too large, or past the per-message inline budget — upload to S3 like a regular
        // attachment instead of embedding. Its `cid:` reference is deliberately left
        // unresolved below; the API layer resolves it to a CDN url at read time.
        const s3Key = `${event.keyPrefix}${uploadIndex}`;
        const filename = ensureFilenameExtension(attachment.filename ?? `inline-${uploadIndex}`, contentType);
        const uploadResult = await uploadViaPresignedPost(
          event.presignedPost,
          s3Key,
          attachment.content,
          contentType,
          buildContentDisposition(contentType, filename),
        );

        if (uploadResult.ok) {
          inlineImageRefs.push({ contentId: cid, mimeType: contentType, sizeBytes: attachment.size, s3Key, filename });
          // Still eligible for QR scanning via the attachment-image path in extractAssets
          if (contentType.startsWith("image/")) {
            attachmentsWithBytes.push({ filename, mimeType: contentType, content: attachment.content, s3Key });
          }
        } else {
          droppedAttachments.push({ filename, mimeType: contentType, sizeBytes: attachment.size, reason: "upload_failed", detail: uploadResult.detail });
        }
        uploadIndex++;
      }
      continue;
    }

    const s3Key = `${event.keyPrefix}${uploadIndex}`;
    const filename = ensureFilenameExtension(attachment.filename ?? `attachment-${uploadIndex}`, contentType);
    const uploadResult = await uploadViaPresignedPost(
      event.presignedPost,
      s3Key,
      attachment.content,
      contentType,
      buildContentDisposition(contentType, filename),
    );

    if (uploadResult.ok) {
      attachmentRefs.push({ filename, mimeType: contentType, sizeBytes: attachment.size, s3Key });
      attachmentsWithBytes.push({ filename, mimeType: contentType, content: attachment.content, s3Key });
    } else {
      droppedAttachments.push({ filename, mimeType: contentType, sizeBytes: attachment.size, reason: "upload_failed", detail: uploadResult.detail });
    }

    uploadIndex++;
  }
  logger?.trackPoint("attachments_processed", { attachmentRefCount: attachmentRefs.length, inlineImageCount: inlineImages.length, inlineImageRefCount: inlineImageRefs.length, droppedCount: droppedAttachments.length });
  if (droppedAttachments.length > 0) {
    const reasonSummary = summarizeDroppedReasons(droppedAttachments);
    logger?.track(`Attachment(s) dropped from message: ${reasonSummary}`, {
      code: "content_sanitizer.attachments_dropped",
      accountId: event.accountId,
      droppedCount: droppedAttachments.length,
      dropped: droppedAttachments.map(d => ({ mimeType: d.mimeType, sizeBytes: d.sizeBytes, reason: d.reason, detail: d.detail })),
    });
  }

  // 6. Sanitize HTML and inline CID images
  let htmlBody: string | undefined;
  const extractedLinks: Array<{ url: string; text: string | null }> = [];

  if (parsed.html) {
    const htmlInput = typeof parsed.html === "string" ? parsed.html : "";
    const sanitized = sanitizeHtml(htmlInput);
    const inlineImageContentIds = new Set(inlineImageRefs.map(ref => ref.contentId));
    htmlBody = sanitized.html.replace(/cid:([^"'\s>]+)/g, (match, id: string) => {
      if (id in cidMap) return cidMap[id] ?? "";
      if (inlineImageContentIds.has(id)) return match; // resolved to a CDN url at API read time
      return "";
    });
    logger?.trackPoint("html_sanitized", { htmlLength: htmlInput.length });

    // Extract links from raw HTML using a DOM parser (before sanitization strips tracking pixels etc.)
    const linkDoc = new Window({ url: "about:blank" }).document;
    linkDoc.body.innerHTML = htmlInput;
    const seenUrls = new Set<string>();
    for (const anchor of linkDoc.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href");
      if (!href) continue;
      try {
        const url = new URL(href);
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      } catch {
        continue;
      }
      if (seenUrls.has(href)) continue;
      seenUrls.add(href);
      const anchorText = (anchor.textContent ?? "").trim();
      const text = anchorText && anchorText !== href ? anchorText : null;
      extractedLinks.push({ url: href, text });
    }
    logger?.trackPoint("links_extracted_from_html", { linkCount: extractedLinks.length });
  }

  // Fallback: extract bare URLs from text body ONLY when no HTML part exists.
  // When HTML is present, it is the rendered view — text/plain may contain attacker-injected
  // URLs invisible to the user's mail client. Never trust text-body links if HTML exists.
  if (!parsed.html && parsed.text) {
    const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
    const seenUrls = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(parsed.text)) !== null) {
      const href = match[0];
      if (seenUrls.has(href)) continue;
      seenUrls.add(href);
      extractedLinks.push({ url: href, text: null });
    }

    // Text-only message (e.g. a plain-text newsletter) — the processor only persists
    // htmlBody on inbound signals (see InboundEmailSignalData), so without this the
    // message would be stored with no visible body at all. Render the plain text as
    // escaped, pre-formatted HTML so it flows through the existing display pipeline.
    htmlBody = textToHtml(parsed.text);
    logger?.trackPoint("links_extracted_from_text_fallback", { linkCount: extractedLinks.length });
  }

  // 8. Body-or-attachments invariant for inline images.
  //
  // An over-budget inline image was recorded as an InlineImageRef on the assumption its
  // `cid:` token survives in the rendered body and gets swapped for a CDN url at API read
  // time. That assumption fails for an orphaned cid — one the sanitizer stripped, or that
  // never appeared in the HTML (e.g. a Content-ID part with no matching <img>, or a
  // text-only message). Such an image would render nowhere AND not appear as an attachment:
  // invisible and unreachable. Promote such an inline image into the attachment list so it
  // stays viewable/downloadable — UNLESS its filename matches a referenced inline image, in
  // which case it's a duplicate copy (e.g. Gmail ships the same logo twice, once with a cid
  // the HTML uses and once with a cid it doesn't) and promoting it would surface a redundant
  // phantom attachment. Those duplicates are dropped instead.
  const renderedBody = htmlBody ?? "";
  const orphanedInlineImages = inlineImageRefs.filter(ref => !renderedBody.includes(`cid:${ref.contentId}`));
  const referencedInlineImages = inlineImageRefs.filter(ref => renderedBody.includes(`cid:${ref.contentId}`));
  const referencedFilenames = new Set(referencedInlineImages.map(ref => ref.filename));
  const promotedInlineImages = orphanedInlineImages.filter(orphan => !referencedFilenames.has(orphan.filename));
  const droppedDuplicateInlineImages = orphanedInlineImages.filter(orphan => referencedFilenames.has(orphan.filename));
  for (const orphan of promotedInlineImages) {
    attachmentRefs.push({
      filename: orphan.filename,
      mimeType: orphan.mimeType,
      sizeBytes: orphan.sizeBytes,
      s3Key: orphan.s3Key,
    });
  }
  if (promotedInlineImages.length > 0) {
    logger?.trackPoint("inline_images_promoted_to_attachments", { promotedCount: promotedInlineImages.length });
  }
  if (droppedDuplicateInlineImages.length > 0) {
    logger?.trackPoint("duplicate_inline_images_dropped", { droppedCount: droppedDuplicateInlineImages.length });
  }

  // 9. Build response
  const to = parseAddressList(parsed.to);
  const cc = parseAddressList(parsed.cc);
  const replyTo = parseAddress(parsed.replyTo);
  const subject = parsed.subject ?? "";

  // Extract headers as flat Record<string, string> — only include headers
  // that are natively strings. Structured headers (address objects) are already
  // captured as from/to/cc fields and must not be coerced.
  const headers: Record<string, string> = {};
  if (parsed.headers) {
    for (const [key, value] of parsed.headers) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }
  }
  logger?.trackPoint("headers_extracted", { headerCount: Object.keys(headers).length });

  // 7. Extract scannable assets (QR codes, PKPass barcodes) — best-effort
  let extractedAssets: ExtractedAsset[] = [];
  try {
    extractedAssets = await extractAssets(inlineImages, attachmentsWithBytes);
    logger?.trackPoint("assets_extracted", { assetCount: extractedAssets.length });
  } catch {
    // extraction failure must never fail the sanitizer
    logger?.trackPoint("assets_extraction_failed");
  }

  const result: ContentSanitizeResponse = {
    success: true,
    parsed: {
      from,
      to,
      cc,
      subject,
      attachments: attachmentRefs,
      headers,
    },
  };

  // Add optional fields only if present
  if (replyTo) {
    result.parsed.replyTo = replyTo;
  }
  if (parsed.text) {
    result.parsed.textBody = parsed.text;
  }
  if (htmlBody) {
    result.parsed.htmlBody = htmlBody;
  }
  if (parsed.date) {
    result.parsed.sentAt = parsed.date.toISOString();
  }
  if (extractedAssets.length > 0) {
    result.parsed.assets = extractedAssets;
  }
  if (extractedLinks.length > 0) {
    result.parsed.links = extractedLinks;
  }
  if (droppedAttachments.length > 0) {
    result.parsed.droppedAttachments = droppedAttachments;
  }
  // Only body-referenced inline images stay as inlineImages (resolved to CDN urls at read
  // time). Orphaned ones were promoted into attachmentRefs above and must not also appear
  // here, or they'd be both an attachment and an unresolved inline ref.
  if (referencedInlineImages.length > 0) {
    result.parsed.inlineImages = referencedInlineImages;
  }
  if (displayRawS3Key) {
    result.parsed.displayRawS3Key = displayRawS3Key;
  }

  logger?.trackPoint("response_built");
  return result;
}
