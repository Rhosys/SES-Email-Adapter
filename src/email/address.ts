// ---------------------------------------------------------------------------
// RFC 5322 mailbox formatting/parsing helpers.
//
// The rest of the codebase treats an address as `{ address, name? }` — bare addr-spec plus an
// optional display name — from the moment it's parsed off the wire (src/isolated/content-
// sanitizer.ts, via mailparser) through storage (the EmailAddress schema) to send time. These
// helpers are the only place that ever turns that pair into a single RFC 5322 string (for a
// MIME header or an SES call) or pulls one back apart, so every call site handles a display
// name the same, correct way instead of re-deriving ad hoc regexes.
// ---------------------------------------------------------------------------

export interface Address {
  address: string;
  name?: string;
}

/** RFC 2047 encoded-word (base64, UTF-8) — used only when a display name is not plain ASCII. */
function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;
/** Display-name words safe to emit unquoted (RFC 5322 atext plus spaces/dots, the common case). */
const SAFE_UNQUOTED_NAME = /^[A-Za-z0-9 '.-]+$/;

/**
 * Formats one `{address, name?}` as an RFC 5322 mailbox: `Name <addr>` when a name is present,
 * a bare `addr` otherwise. A name is never trusted verbatim — it can come off an inbound
 * message's From/To/Cc header — so CR/LF is stripped first (header-injection defense, same
 * reasoning as sanitizeHeaderValue in mime-builder.ts) and the result is quoted/escaped or
 * RFC 2047-encoded as needed so a comma, quote, or non-ASCII character in the name can never be
 * misread as part of the surrounding address list.
 */
export function formatAddress(a: Address): string {
  const address = a.address.trim();
  const name = a.name?.replace(/[\r\n]+/g, " ").trim();
  if (!name) return address;

  if (!ASCII_PRINTABLE.test(name)) return `${encodeWord(name)} <${address}>`;
  if (SAFE_UNQUOTED_NAME.test(name)) return `${name} <${address}>`;
  const escaped = name.replace(/(["\\])/g, "\\$1");
  return `"${escaped}" <${address}>`;
}

/** Formats a list of addresses as the comma-joined RFC 5322 form used in a To/Cc header. */
export function formatAddressList(list: Address[]): string {
  return list.map(formatAddress).join(", ");
}

/**
 * Splits an RFC 5322 address-list string on its top-level commas, honoring commas that fall
 * inside a quoted display name (`"Doe, Jane" <jane@x.com>, bob@y.com`) or an angle-bracketed
 * addr-spec. A naive `.split(",")` cuts a quoted display name in half; this walks the string
 * tracking quote/bracket depth instead.
 */
export function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let inQuotes = false;
  let inBrackets = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\" && inQuotes) {
      current += ch + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "\"") inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inBrackets = true;
    else if (ch === ">" && !inQuotes) inBrackets = false;

    if (ch === "," && !inQuotes && !inBrackets) {
      entries.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

/**
 * Pulls the addr-spec out of one RFC 5322 mailbox string — `"Name" <addr@host>` or a bare
 * `addr@host` — trimmed and lowercased. Used wherever a from/to value that may carry a display
 * name needs to be reduced to just the address (alias lookup, domain checks).
 */
export function extractAddress(value: string): string {
  const match = /<([^>]+)>\s*$/.exec(value.trim());
  return (match ? match[1]! : value).trim().toLowerCase();
}

/** The domain half of an address, tolerant of a leading display name (`extractAddress` first). */
export function addressDomain(value: string): string {
  return extractAddress(value).split("@").pop() ?? "";
}
