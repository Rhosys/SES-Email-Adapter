/**
 * Builds a display-safe copy of the raw MIME source: a byte-faithful copy of the
 * original with attachment bodies stripped out entirely, except for small inline
 * images (kept so the message still renders correctly if the .eml is opened in a
 * real mail client — those clients resolve `cid:` references against the file's
 * own MIME parts, unlike our app's htmlBody rendering, which resolves them
 * against a CDN url instead). This is the copy served by the "view original
 * email" / download-as-.eml feature; the true, unmodified original stays in S3
 * for internal use (e.g. reprocessing) and is never served through that path.
 *
 * This is a textual boundary walk, not a semantic MIME parse — it never decodes
 * or interprets attachment bytes, only locates part boundaries/headers to decide
 * what to keep. Operates on the raw MIME text as fetched, inside the sanitizer's
 * security boundary (see docs/adr/011-content-sanitizer-security-boundary.md).
 */

// Per-image cap: an inline image bigger than this is truncated regardless of
// how much of the cumulative budget remains.
const MAX_DISPLAY_INLINE_IMAGE_SIZE = 100 * 1024; // 100KB

// Cumulative cap across all inline images kept in one message — once reached,
// every remaining inline image is truncated even if individually under the
// per-image cap.
const MAX_DISPLAY_INLINE_TOTAL_SIZE = 300 * 1024; // 300KB

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildDisplayRawEmail(raw: string): string {
  const boundaries = new Set<string>();
  const boundaryRegex = /boundary\s*=\s*"?([^";\r\n]+)"?/gi;
  let boundaryMatch: RegExpExecArray | null;
  while ((boundaryMatch = boundaryRegex.exec(raw))) {
    boundaries.add(boundaryMatch[1]!);
  }
  if (boundaries.size === 0) return raw; // not multipart — nothing to strip

  const boundaryLineRegex = new RegExp(
    `^--(${[...boundaries].map(escapeRegExp).join("|")})(--)?\\s*$`,
  );

  const lines = raw.split(/\r\n|\n/);
  const output: string[] = [];
  let i = 0;
  let inlineBudgetRemaining = MAX_DISPLAY_INLINE_TOTAL_SIZE;

  // Preamble / top-level headers before the first boundary — unchanged
  while (i < lines.length && !boundaryLineRegex.test(lines[i]!)) {
    output.push(lines[i]!);
    i++;
  }

  while (i < lines.length) {
    const boundaryLine = lines[i]!;
    output.push(boundaryLine);
    i++;
    if (/--\s*$/.test(boundaryLine)) break; // closing boundary — no part follows

    const headerLines: string[] = [];
    while (i < lines.length && lines[i] !== "" && !boundaryLineRegex.test(lines[i]!)) {
      headerLines.push(lines[i]!);
      output.push(lines[i]!);
      i++;
    }
    if (i < lines.length && lines[i] === "") {
      output.push(lines[i]!);
      i++;
    }

    const bodyStart = i;
    while (i < lines.length && !boundaryLineRegex.test(lines[i]!)) {
      i++;
    }
    const bodyLines = lines.slice(bodyStart, i);
    const bodyHasContent = bodyLines.some(line => line.trim() !== "");

    if (!bodyHasContent) {
      output.push(...bodyLines);
      continue;
    }

    const headerText = headerLines.join("\n");
    const isInlineImage = /Content-Disposition:\s*inline/i.test(headerText) && /Content-Type:\s*image\//i.test(headerText);
    const isFilePart =
      /Content-Disposition:\s*attachment/i.test(headerText) ||
      /Content-Disposition:[^\r\n]*\bfilename\*?=/i.test(headerText) ||
      /Content-Type:[^\r\n]*\bname\s*=/i.test(headerText);

    if (isInlineImage) {
      const approxBytes = Math.floor(bodyLines.join("").length * 0.75); // base64 -> raw bytes estimate
      if (approxBytes <= MAX_DISPLAY_INLINE_IMAGE_SIZE && approxBytes <= inlineBudgetRemaining) {
        output.push(...bodyLines);
        inlineBudgetRemaining -= approxBytes;
      } else {
        output.push(`[inline image omitted: exceeds display size limit (~${formatBytes(approxBytes)})]`);
        output.push("");
      }
      continue;
    }

    if (isFilePart) {
      const filenameMatch =
        headerText.match(/filename\*?=\s*"?([^";\r\n]+)"?/i) ?? headerText.match(/name\s*=\s*"?([^";\r\n]+)"?/i);
      const filename = filenameMatch ? filenameMatch[1] : null;
      const approxBytes = Math.floor(bodyLines.join("").length * 0.75);
      output.push(`[attachment content omitted${filename ? `: ${filename}` : ""} (~${formatBytes(approxBytes)})]`);
      output.push("");
      continue;
    }

    output.push(...bodyLines);
  }

  return output.join("\r\n");
}
