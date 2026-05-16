import { simpleParser } from "mailparser";
import { sanitizeHtml } from "./html-sanitizer.js";

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
  cdnUrl: string;
  contentId?: string;
}

interface ContentSanitizeRequest {
  presignedGetUrl: string;
  presignedPost: {
    url: string;
    fields: Record<string, string>;
  };
  accountId: string;
  senderEtld1: string;
  contentBaseUrl: string;
  keyPrefix: string;
  retentionTag: "365" | "3650" | null;
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
  };
  urlMapping: Record<string, string>;
}

interface ContentSanitizeError {
  success: false;
  error: {
    message: string;
    type: "parse_error" | "limits_exceeded" | "missing_sender" | "fetch_failed";
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTACHMENTS = 50;
const MAX_TOTAL_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_SINGLE_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const IMAGE_DOWNLOAD_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_SIZE) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_SIZE) return null;

    return buffer;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(event: ContentSanitizeRequest): Promise<ContentSanitizeResponse | ContentSanitizeError> {
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

  // 5. Extract attachments: upload each via pre-signed POST
  let uploadIndex = 0;
  const attachmentRefs: AttachmentRef[] = [];

  for (const attachment of attachments) {
    // Skip attachments > 10MB
    if (attachment.size > MAX_SINGLE_ATTACHMENT_SIZE) {
      continue;
    }

    const s3Key = `${event.keyPrefix}${uploadIndex}`;
    const contentType = attachment.contentType || "application/octet-stream";

    const uploaded = await uploadViaPresignedPost(
      event.presignedPost,
      s3Key,
      attachment.content,
      contentType,
      event.retentionTag,
    );

    if (!uploaded) {
      // Skip on upload failure
      uploadIndex++;
      continue;
    }

    const ref: AttachmentRef = {
      filename: attachment.filename ?? `attachment-${uploadIndex}`,
      mimeType: contentType,
      sizeBytes: attachment.size,
      s3Key,
      cdnUrl: `${event.contentBaseUrl}/content/${s3Key}`,
    };

    if (attachment.contentId) {
      ref.contentId = attachment.contentId;
    }

    attachmentRefs.push(ref);
    uploadIndex++;
  }

  // 6. Sanitize HTML
  const urlMapping: Record<string, string> = {};
  let htmlBody: string | undefined;

  if (parsed.html) {
    const htmlInput = typeof parsed.html === "string" ? parsed.html : "";
    const sanitized = sanitizeHtml(htmlInput);
    htmlBody = sanitized.html;

    // 7. Download external images and upload via pre-signed POST
    for (const imageUrl of sanitized.externalImageUrls) {
      const imageBuffer = await downloadImage(imageUrl);
      if (!imageBuffer) {
        // Failed to download or too large — skip
        continue;
      }

      const s3Key = `${event.keyPrefix}${uploadIndex}`;
      const uploaded = await uploadViaPresignedPost(
        event.presignedPost,
        s3Key,
        imageBuffer,
        "image/png", // default content type for downloaded images
        event.retentionTag,
      );

      if (uploaded) {
        urlMapping[imageUrl] = `/content/${s3Key}`;
      }

      uploadIndex++;
    }

    // 8. Map cid: references to corresponding attachment CDN paths
    for (const cidRef of sanitized.cidReferences) {
      const matchingAttachment = attachmentRefs.find(a => a.contentId === cidRef);
      if (matchingAttachment) {
        urlMapping[`cid:${cidRef}`] = `/content/${matchingAttachment.s3Key}`;
      }
    }
  }

  // 9. Build response
  const to = parseAddressList(parsed.to);
  const cc = parseAddressList(parsed.cc);
  const replyTo = parseAddress(parsed.replyTo);
  const subject = parsed.subject ?? "";

  // Extract headers as flat Record<string, string>
  const headers: Record<string, string> = {};
  if (parsed.headers) {
    for (const [key, value] of parsed.headers) {
      if (typeof value === "string") {
        headers[key] = value;
      } else if (value && typeof value === "object" && "value" in value) {
        headers[key] = String(value.value);
      }
    }
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
    urlMapping,
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

  return result;
}
