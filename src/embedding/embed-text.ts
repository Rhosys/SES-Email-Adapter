// ---------------------------------------------------------------------------
// Embed Text Builder
// Pure function. Deterministic. No I/O.
// ---------------------------------------------------------------------------

import type { ParsedMime } from "../processor/mime.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbedTextInput {
  accountId: string;
  from: string;
  replyTo?: string;
  returnPath?: string;
  recipientAddress: string;
  subject: string;
  rawTextBody: string;        // already extracted from MIME (text/plain or html-stripped)
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Removes CSS blocks from HTML content (<style> tags and their content).
 */
function stripCss(html: string): string {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

/**
 * Removes script blocks from HTML content.
 */
function stripScripts(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
}

/**
 * Removes image references (<img> tags) and image alt text.
 * Must run BEFORE stripHtmlTags so that <img> tags are still present.
 */
function stripImages(html: string): string {
  // Remove <img> tags entirely (including self-closing and any alt text within)
  return html.replace(/<img[^>]*\/?>/gi, "");
}

/**
 * Removes all HTML tags from content.
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/**
 * Reduces URLs to domain + first path segment.
 * e.g., "https://amazon.com/products/foo/bar?ref=x" → "amazon.com/products"
 * e.g., "https://example.com" → "example.com"
 * e.g., "http://example.com/path?q=1#frag" → "example.com/path"
 */
function reduceLinks(text: string): string {
  // Match URLs (http/https) — domain required, path optional
  const urlRegex = /https?:\/\/[^\s]+/g;
  return text.replace(urlRegex, (match) => {
    try {
      const parsed = new URL(match);
      const hostname = parsed.hostname;
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length === 0) {
        return hostname;
      }
      return `${hostname}/${parts[0]}`;
    } catch {
      // If URL parsing fails, leave the match as-is
      return match;
    }
  });
}

/**
 * Sanitizes raw HTML/text body:
 * 1. Strip CSS blocks (<style> tags and content)
 * 2. Strip script blocks
 * 3. Strip image references (<img> tags including alt text)
 * 4. Strip all remaining HTML tags
 * 5. Reduce links to domain + first path segment
 * 6. Normalize whitespace
 */
function sanitizeBody(rawTextBody: string): string {
  // Strip CSS and scripts first (block-level HTML elements with content)
  let sanitized = stripCss(rawTextBody);
  sanitized = stripScripts(sanitized);

  // Strip images before stripping all HTML tags (so <img> tags are still present)
  sanitized = stripImages(sanitized);

  // Strip all remaining HTML tags
  sanitized = stripHtmlTags(sanitized);

  // Reduce links to domain + first path segment
  sanitized = reduceLinks(sanitized);

  // Normalize whitespace (collapse multiple spaces/newlines, trim)
  sanitized = sanitized.replace(/\s+/g, " ").trim();

  return sanitized;
}

// ---------------------------------------------------------------------------
// Link reduction (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Extracts domain and first path segment from a URL.
 * e.g., "https://amazon.com/products/foo/bar?ref=x" → "amazon.com/products"
 */
export function reduceLink(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const pathname = parsed.pathname;

    // Extract first path segment
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
      return hostname;
    }
    return `${hostname}/${parts[0]}`;
  } catch {
    // If URL parsing fails, return empty string
    return "";
  }
}

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

/**
 * Constructs the body content for embedding:
 * - If sanitized body > 4000 chars: first 3000 + last 1000 (no overlap)
 * - Otherwise: entire sanitized body
 */
function buildBodyContent(sanitizedBody: string): string {
  if (sanitizedBody.length > 4000) {
    return sanitizedBody.slice(0, 3000) + sanitizedBody.slice(-1000);
  }
  return sanitizedBody;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Builds the embed text from input data.
 *
 * 1. Sanitizes rawTextBody (strip CSS, HTML tags, <img>, alt text)
 * 2. Reduces links to "domain/firstPathSegment"
 * 3. Body = sanitized.length > 4000
 *        ? sanitized.slice(0, 3000) + sanitized.slice(-1000)
 *        : sanitized
 * 4. Joins header lines + body with '\n'
 */
export function buildEmbedText(input: EmbedTextInput): string {
  const sanitizedBody = sanitizeBody(input.rawTextBody);
  const bodyContent = buildBodyContent(sanitizedBody);

  const headerLines: string[] = [
    input.accountId,
    input.from,
  ];

  if (input.replyTo) {
    headerLines.push(input.replyTo);
  }
  if (input.returnPath) {
    headerLines.push(input.returnPath);
  }

  headerLines.push(input.recipientAddress);
  headerLines.push(input.subject);

  return [...headerLines, bodyContent].join("\n");
}

// ---------------------------------------------------------------------------
// MIME integration
// ---------------------------------------------------------------------------

/**
 * Extracts the email address from a return-path header value.
 * simpleParser may store return-path as a structured AddressObject (JSON-serialized)
 * or as a raw string like "<addr>" or "addr".
 */
function extractReturnPathAddress(headerValue: string): string {
  if (!headerValue) return "";

  // Try parsing as JSON (simpleParser stores structured headers as JSON strings)
  try {
    const parsed = JSON.parse(headerValue);
    if (parsed?.value?.[0]?.address) {
      return parsed.value[0].address;
    }
  } catch {
    // Not JSON — fall through to string extraction
  }

  // Strip angle brackets if present: "<addr>" → "addr"
  const match = headerValue.match(/^<(.+)>$/);
  if (match?.[1]) return match[1];

  return headerValue;
}

/**
 * Extracts EmbedTextInput from ParsedMime.
 * Reuses existing MIME parser; ensures from / reply-to / return-path / subject / text body extraction.
 */
export function extractEmbedTextInput(parsed: ParsedMime, accountId: string, recipientAddress: string): EmbedTextInput {
  const rawReturnPath = parsed.headers["return-path"] ?? parsed.headers["Return-Path"] ?? "";
  const returnPath = extractReturnPathAddress(rawReturnPath);

  return {
    accountId,
    from: parsed.from.address,
    ...(parsed.replyTo ? { replyTo: parsed.replyTo.address } : {}),
    ...(returnPath ? { returnPath } : {}),
    recipientAddress,
    subject: parsed.subject,
    rawTextBody: parsed.textBody ?? "",
  };
}
