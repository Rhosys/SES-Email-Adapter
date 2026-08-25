import { simpleParser } from "mailparser";
import { Window } from "happy-dom";
import { sanitizeHtml } from "./html-sanitizer.js";
import { extractAssets, type ExtractedAsset } from "./asset-extractor.js";

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

interface ContentSanitizeRequest {
  presignedGetUrl: string;
  presignedPost: {
    url: string;
    fields: Record<string, string>;
  };
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

async function uploadViaPresignedPost(
  presignedPost: { url: string; fields: Record<string, string> },
  s3Key: string,
  content: Buffer | Uint8Array,
  contentType: string,
  retentionTag: "365" | "3650" | null,
): Promise<boolean> {
  const formData = new FormData();

  // Add all pre-signed fields
  for (const [key, value] of Object.entries(presignedPost.fields)) {
    formData.append(key, value);
  }

  // Override the key with our specific key
  formData.append("key", s3Key);
  formData.append("Content-Type", contentType);

  if (retentionTag) {
    formData.append("x-amz-tagging", `retention=${retentionTag}`);
  }

  // The file must be the last field
  formData.append("file", new Blob([Buffer.from(content)], { type: contentType }));

  try {
    const response = await fetch(presignedPost.url, {
      method: "POST",
      body: formData,
    });
    return response.ok || response.status === 204;
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Wraps processEmail so that any exception we didn't anticipate becomes a structured
// ContentSanitizeError instead of an opaque Lambda "Unhandled" FunctionError — the
// processor can then surface the real message/type instead of just "Unhandled".
export async function handler(event: ContentSanitizeRequest): Promise<ContentSanitizeResponse | ContentSanitizeError> {
  try {
    return await processEmail(event);
  } catch (e) {
    return {
      success: false,
      error: { message: e instanceof Error ? e.message : String(e), type: "internal_error" },
    };
  }
}

async function processEmail(event: ContentSanitizeRequest): Promise<ContentSanitizeResponse | ContentSanitizeError> {
  if (event.invocationId) {
    const { RequestLogger } = await import("../logger.js");
    const logger = new RequestLogger();
    logger.startInvocation(event.invocationId);
    logger.info("content-sanitizer.invoked", { code: "content_sanitizer.invoked", invocationId: event.invocationId, accountId: event.accountId });
  }

  // 1. Fetch raw MIME via presignedGetUrl
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
  } catch (e) {
    return {
      success: false,
      error: { message: `Failed to fetch MIME: ${e instanceof Error ? e.message : "unknown error"}`, type: "fetch_failed" },
    };
  }

  // 2. Parse with mailparser
  let parsed;
  try {
    parsed = await simpleParser(rawMime);
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

  // 5. Build CID map for inline images and upload real attachments to S3
  let uploadIndex = 0;
  const attachmentRefs: AttachmentRef[] = [];
  const cidMap: Record<string, string> = {};
  const inlineImages: Array<{ mimeType: string; content: Buffer }> = [];
  const attachmentsWithBytes: Array<{ filename: string; mimeType: string; content: Buffer; s3Key?: string }> = [];

  for (const attachment of attachments) {
    if (attachment.size > MAX_SINGLE_ATTACHMENT_SIZE) {
      continue;
    }

    const contentType = attachment.contentType || "application/octet-stream";

    if (attachment.contentId) {
      // Inline image — embed as data URI, no S3 upload needed
      cidMap[attachment.contentId] = `data:${contentType};base64,${attachment.content.toString("base64")}`;
      if (contentType.startsWith("image/")) {
        inlineImages.push({ mimeType: contentType, content: attachment.content });
      }
      continue;
    }

    const s3Key = `${event.keyPrefix}${uploadIndex}`;
    const uploaded = await uploadViaPresignedPost(event.presignedPost, s3Key, attachment.content, contentType, event.retentionTag);

    if (uploaded) {
      const filename = attachment.filename ?? `attachment-${uploadIndex}`;
      attachmentRefs.push({ filename, mimeType: contentType, sizeBytes: attachment.size, s3Key });
      attachmentsWithBytes.push({ filename, mimeType: contentType, content: attachment.content, s3Key });
    }

    uploadIndex++;
  }

  // 6. Sanitize HTML and inline CID images
  let htmlBody: string | undefined;
  const extractedLinks: Array<{ url: string; text: string | null }> = [];

  if (parsed.html) {
    const htmlInput = typeof parsed.html === "string" ? parsed.html : "";
    const sanitized = sanitizeHtml(htmlInput);
    htmlBody = sanitized.html.replace(/cid:([^"'\s>]+)/g, (_, id: string) => cidMap[id] ?? "");

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

  // 7. Extract scannable assets (QR codes, PKPass barcodes) — best-effort
  let extractedAssets: ExtractedAsset[] = [];
  try {
    extractedAssets = await extractAssets(inlineImages, attachmentsWithBytes);
  } catch {
    // extraction failure must never fail the sanitizer
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

  return result;
}
