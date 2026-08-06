// ---------------------------------------------------------------------------
// RFC 5322 message builder
//
// SES accepts a structured payload (SendEmailCommand's Simple content) and assembles the
// message itself. Provider send APIs do not: Gmail's messages.send and Graph's message
// resource both want a complete RFC 5322 message. This builds one from the same fields the
// SES path uses, so both send routes carry identical headers and body.
//
// Generation only — nothing here parses untrusted content, so it stays outside the isolated
// sanitizer boundary (see docs/adr/011-content-sanitizer-security-boundary.md).
// ---------------------------------------------------------------------------

export interface MimeMessageOptions {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  /** Extra headers (In-Reply-To, References, …). Values are sanitized like every other header. */
  headers?: Array<{ Name: string; Value: string }>;
  /** Defaults to now. Injectable so tests get a stable Date header. */
  date?: Date;
}

const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;

/**
 * Strips CR and LF from a header value.
 *
 * Header values here can originate from user-composed drafts (subject lines, display names),
 * and a bare newline in one would let the rest of the value be read as additional headers —
 * the classic header-injection route to an attacker-chosen Bcc or a forged body. Folding
 * whitespace is collapsed to a single space rather than preserved, because we never need to
 * emit multi-line headers and allowing them re-opens the same hole.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** RFC 2047 encoded-word (base64, UTF-8) — used only when a value is not plain ASCII. */
function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Encodes an unstructured header value (Subject) if it carries anything beyond ASCII. */
function encodeUnstructured(value: string): string {
  const clean = sanitizeHeaderValue(value);
  return ASCII_PRINTABLE.test(clean) ? clean : encodeWord(clean);
}

/**
 * Encodes an address header, leaving the addr-spec untouched and RFC 2047-encoding a
 * non-ASCII display name. `Ada Lovelace <ada@example.com>` and a bare `ada@example.com`
 * are both accepted; a comma-separated list is handled element by element.
 */
function encodeAddressList(value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (ASCII_PRINTABLE.test(clean)) return clean;
  return clean.split(",").map((entry) => {
    const trimmed = entry.trim();
    const match = /^(.*?)\s*<([^>]+)>$/.exec(trimmed);
    if (!match) return ASCII_PRINTABLE.test(trimmed) ? trimmed : encodeWord(trimmed);
    const displayName = match[1]!.replace(/^"|"$/g, "").trim();
    const address = match[2]!;
    if (!displayName) return `<${address}>`;
    return `${ASCII_PRINTABLE.test(displayName) ? `"${displayName}"` : encodeWord(displayName)} <${address}>`;
  }).join(", ");
}

/** Base64 body, wrapped at 76 characters as RFC 2045 requires. */
function encodeBody(body: string): string {
  const encoded = Buffer.from(body, "utf8").toString("base64");
  return (encoded.match(/.{1,76}/g) ?? []).join("\r\n");
}

/** Headers the builder always emits itself — a caller-supplied duplicate is dropped. */
const RESERVED_HEADERS = new Set(["from", "to", "subject", "date", "mime-version", "content-type", "content-transfer-encoding"]);

/**
 * Builds a complete RFC 5322 message. Body is always UTF-8 base64 so that non-ASCII content
 * and long lines survive intact regardless of what the provider does with the bytes.
 */
export function buildMimeMessage(options: MimeMessageOptions): Uint8Array {
  const date = options.date ?? new Date();

  const lines: string[] = [
    `From: ${encodeAddressList(options.from)}`,
    `To: ${encodeAddressList(options.to)}`,
    `Subject: ${encodeUnstructured(options.subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];

  for (const header of options.headers ?? []) {
    if (RESERVED_HEADERS.has(header.Name.toLowerCase())) continue;
    const value = sanitizeHeaderValue(header.Value);
    if (!value) continue;
    lines.push(`${sanitizeHeaderValue(header.Name)}: ${ASCII_PRINTABLE.test(value) ? value : encodeWord(value)}`);
  }

  return new Uint8Array(Buffer.from(`${lines.join("\r\n")}\r\n\r\n${encodeBody(options.textBody)}\r\n`, "utf8"));
}
