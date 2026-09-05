// Content-type resolution for stored attachments and inline images.
//
// A MIME part's declared Content-Type is frequently wrong or absent: senders
// routinely ship PDFs, images, and office documents as `application/octet-stream`,
// and some omit the header entirely. Downstream rendering (the dashboard's inline
// PDF/image preview) and the S3 object's served Content-Type both depend on an
// accurate type, so we recover it here from three signals, in order of trust:
//
//   1. Magic bytes — the file's own header. Bytes don't lie; this wins over
//      everything, including a declared type, because a mislabeled part is exactly
//      the case we're correcting.
//   2. The declared Content-Type — trusted only when it is present AND specific
//      (not the octet-stream catch-all).
//   3. The filename extension — last resort when the header is missing/generic.
//
// This module also maps a resolved MIME type back to a canonical extension, so a
// part with no filename (or a synthetic `attachment-0`) can be given a meaningful
// download name like `image.png` instead of an extensionless blob.

const OCTET_STREAM = "application/octet-stream";

// Non-standard declared types that map to a single canonical type. Senders (and some
// calendar servers) ship iCalendar parts as `application/ics` or `application/calendar`
// rather than the IETF-registered `text/calendar`. Left unnormalized, these bypass every
// downstream `text/calendar` check (calendar detection, the API's attachment filter) AND
// get served from S3 with the wrong Content-Type. Canonicalize them at the type-recovery
// boundary so a single fix covers all consumers.
const DECLARED_TYPE_ALIASES: Record<string, string> = {
  "application/ics": "text/calendar",
  "application/calendar": "text/calendar",
  "text/x-vcalendar": "text/calendar",
};

// Extension -> canonical MIME type. Intentionally small and IANA-aligned: it covers
// the types a mail attachment realistically carries and that we either render inline
// or want a correct download name for. Not a general-purpose registry — anything not
// listed falls back to octet-stream, which is the safe default for "unknown binary".
const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  heic: "image/heic",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  xml: "application/xml",
  ics: "text/calendar",
  zip: "application/zip",
  gz: "application/gzip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  pkpass: "application/vnd.apple.pkpass",
};

// MIME type -> canonical extension. The inverse of the table above but not a naive
// reversal: several extensions map to one type (jpg/jpeg, html/htm), so we pin the
// single canonical extension we want to synthesize for each type.
const MIME_TO_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tif",
  "image/x-icon": "ico",
  "image/heic": "heic",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/xml": "xml",
  "text/calendar": "ics",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/vnd.apple.pkpass": "pkpass",
};

/**
 * Detects a content type from a buffer's leading bytes (magic numbers). Returns the
 * MIME type when the signature is recognized, or `undefined` when the bytes match no
 * known signature — the caller then falls back to the declared type or extension.
 *
 * Only the binary types where a mislabeled `octet-stream` is common and where we care
 * about inline rendering are detected. Text-based formats (HTML, CSV, JSON) have no
 * reliable magic bytes and are left to the declared type / extension.
 */
export function sniffContentType(bytes: Uint8Array): string | undefined {
  // Need at least a few bytes to match any signature.
  if (bytes.length < 4) return undefined;

  const b = bytes;

  // %PDF
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";

  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";

  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";

  // WebP: "RIFF" .... "WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }

  // BMP: "BM"
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";

  // TIFF: "II*\0" (little-endian) or "MM\0*" (big-endian)
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return "image/tiff";
  if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return "image/tiff";

  return undefined;
}

/** Lower-cased extension (without dot) from a filename, or undefined when there is none. */
function extractExtension(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return undefined;
  return filename.slice(dot + 1).toLowerCase();
}

/** Maps a filename extension to a MIME type, or undefined when the extension is unknown. */
export function mimeFromExtension(filename: string | undefined): string | undefined {
  const ext = extractExtension(filename);
  if (!ext) return undefined;
  return EXTENSION_TO_MIME[ext];
}

/** The canonical file extension for a MIME type (without dot), or undefined when unmapped. */
export function extensionFromMime(mimeType: string): string | undefined {
  // Strip any parameters (e.g. `text/calendar; method=REQUEST`) before lookup.
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_TO_EXTENSION[base];
}

/**
 * Resolves the effective content type for an attachment from its bytes, declared type,
 * and filename — in that order of trust (see file header). Never returns an empty string;
 * falls back to `application/octet-stream` when no signal identifies the type.
 */
export function resolveContentType(input: {
  content: Uint8Array;
  declaredType: string | undefined;
  filename: string | undefined;
}): string {
  const sniffed = sniffContentType(input.content);
  if (sniffed) return sniffed;

  const declared = input.declaredType?.split(";")[0]?.trim().toLowerCase();
  if (declared && declared !== OCTET_STREAM) {
    // Canonicalize known non-standard aliases (e.g. application/ics -> text/calendar) so
    // downstream type checks and the served Content-Type see the registered type. Any
    // parameters on the declared type (e.g. `; method=REQUEST`) are dropped for aliased
    // types — they carry no meaning once the base type is corrected.
    const alias = DECLARED_TYPE_ALIASES[declared];
    if (alias) return alias;
    return input.declaredType!.trim();
  }

  const fromExtension = mimeFromExtension(input.filename);
  if (fromExtension) return fromExtension;

  return OCTET_STREAM;
}

/**
 * Ensures a filename carries an extension matching its content type. When the filename
 * already has any extension it is returned unchanged (the sender's choice wins). When it
 * has none — including synthesized names like `attachment-0` — the canonical extension for
 * the MIME type is appended so downloads land with a usable name (`attachment-0.pdf`).
 */
export function ensureFilenameExtension(filename: string, mimeType: string): string {
  if (extractExtension(filename)) return filename;
  const ext = extensionFromMime(mimeType);
  if (!ext) return filename;
  return `${filename}.${ext}`;
}

// Types the dashboard renders inline (preview iframe / <img>). For these we set
// `Content-Disposition: inline` so the browser displays rather than downloads; everything
// else gets `attachment` so it downloads with a real filename. PDFs are the load-bearing
// case — a mislabeled/omitted disposition is why they failed to preview.
const INLINE_RENDERABLE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
]);

/**
 * Builds a `Content-Disposition` header value for a stored object. Renderable types
 * (PDF, images) get `inline` so the browser previews them; all other types get
 * `attachment`. The filename is emitted both as a plain `filename=` (ASCII fallback) and,
 * when it contains non-ASCII characters, an RFC 5987 `filename*=UTF-8''` form so unicode
 * names survive.
 */
export function buildContentDisposition(mimeType: string, filename: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const kind = INLINE_RENDERABLE_TYPES.has(base) ? "inline" : "attachment";

  // ASCII fallback: strip characters that would break the quoted-string form.
  const asciiName = filename.replace(/["\\\r\n]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  let disposition = `${kind}; filename="${asciiName}"`;

  // Add the RFC 5987 encoded form only when the name has non-ASCII characters.
  if (/[^\x20-\x7e]/.test(filename)) {
    disposition += `; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  return disposition;
}
