import { DateTime } from "luxon";

import type { Logger } from "../logger.js";
import { CLASSIFIER_WORKFLOW_REGISTRY } from "../types/workflow-registry.js";

/**
 * Coerces raw LLM workflowData fields to their declared types.
 *
 * LLMs output JSON — but they don't reliably distinguish between:
 * - `0` and `"0"` (number vs string)
 * - `true` and `"true"` (boolean vs string)
 * - `2` and `"2"` or `"two"` (numeric string variations)
 *
 * This module applies deterministic coercion at the classifier output boundary.
 * If a value cannot be deterministically coerced, it is nullified and a TRACK
 * log is emitted for follow-up investigation.
 *
 * Rules:
 * - string fields: accept string, number, boolean → String(). Reject objects/arrays.
 * - number fields (amounts, counts): accept number or numeric string → String().
 *   These are stored as strings because the LLM cannot reliably output numbers.
 *   Non-numeric strings (e.g. "two", "CHF 5") → null + TRACK.
 * - boolean fields: accept true/false, "true"/"false", 1/0, "1"/"0", "yes"/"no" → boolean.
 *   Anything else → null + TRACK.
 * - array fields: accept arrays, pass through. Non-arrays → null + TRACK.
 * - enum fields: accept only declared enum values. Anything else → null + TRACK.
 */

interface FieldSpec {
  name: string;
  type: string;
  required: boolean;
  enumValues?: Array<{ value: string }>;
}

/** Build a lookup from workflow name → field specs for fast access. */
const WORKFLOW_FIELDS: Map<string, FieldSpec[]> = new Map(
  CLASSIFIER_WORKFLOW_REGISTRY.map(w => [w.name, w.fields]),
);

/**
 * Coerces a numeric-like value to a string representation suitable for storage.
 * Accepts: number, or string that parses to a finite number.
 * Returns null if the value cannot be deterministically converted.
 */
function coerceNumericToString(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Try parsing as a number — handles "0", "149.00", "1,234.56" (after comma removal)
    const normalized = trimmed.replace(/,/g, "");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return String(parsed);
    return null;
  }
  return null;
}

/**
 * Coerces a boolean-like value to an actual boolean.
 * Accepts: boolean, "true"/"false", "yes"/"no", 1/0, "1"/"0".
 * Returns null if the value cannot be deterministically converted.
 */
function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "1") return true;
    if (lower === "false" || lower === "no" || lower === "0") return false;
    return null;
  }
  return null;
}

/**
 * Coerces a value to string. Accepts primitives — rejects objects/arrays.
 */
function coerceString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

interface CoercionContext {
  signalId?: string | undefined;
  accountId?: string | undefined;
  workflow: string;
}

/**
 * Coerces raw workflowData fields based on the workflow registry type declarations.
 * Returns a new record with coerced values — does not mutate the input.
 */
export function coerceWorkflowData(
  workflowData: Record<string, unknown>,
  workflow: string,
  logger: Logger,
  ctx: CoercionContext,
  receivedAt: string,
  localeHints: string[] = [],
): Record<string, unknown> {
  const result = { ...workflowData };
  const fields = WORKFLOW_FIELDS.get(workflow);
  if (!fields) return result;

  for (const field of fields) {
    if (!(field.name in result)) continue;
    const raw = result[field.name];
    if (raw === null || raw === undefined) {
      // Already null/undefined — leave as-is (will be omitted in output)
      continue;
    }

    switch (field.type) {
      case "string": {
        if (field.enumValues) {
          // Enum field — must match a declared value exactly (case-insensitive match → store canonical)
          const coerced = coerceEnumValue(raw, field.enumValues);
          if (coerced === null) {
            logger.track("Classifier returned invalid enum value — nullified.", {
              code: "classifier.coercion_failed",
              field: field.name,
              value: raw,
              expectedValues: field.enumValues.map(e => e.value),
              ...ctx,
            });
            result[field.name] = null;
          } else {
            result[field.name] = coerced;
          }
        } else {
          const coerced = coerceString(raw);
          if (coerced === null) {
            logger.track("Classifier returned non-coercible value for string field — nullified.", {
              code: "classifier.coercion_failed",
              field: field.name,
              value: raw,
              ...ctx,
            });
            result[field.name] = null;
          } else {
            result[field.name] = coerced;
          }
        }
        break;
      }

      case "enum": {
        const coerced = coerceEnumValue(raw, field.enumValues ?? []);
        if (coerced === null) {
          logger.track("Classifier returned invalid enum value — nullified.", {
            code: "classifier.coercion_failed",
            field: field.name,
            value: raw,
            expectedValues: (field.enumValues ?? []).map(e => e.value),
            ...ctx,
          });
          result[field.name] = null;
        } else {
          result[field.name] = coerced;
        }
        break;
      }

      case "number": {
        // Numbers from the LLM are stored as strings — see design doc.
        const coerced = coerceNumericToString(raw);
        if (coerced === null) {
          logger.track("Classifier returned non-numeric value for number field — nullified.", {
            code: "classifier.coercion_failed",
            field: field.name,
            value: raw,
            ...ctx,
          });
          result[field.name] = null;
        } else {
          result[field.name] = coerced;
        }
        break;
      }

      case "boolean": {
        const coerced = coerceBoolean(raw);
        if (coerced === null) {
          logger.track("Classifier returned non-boolean value for boolean field — nullified.", {
            code: "classifier.coercion_failed",
            field: field.name,
            value: raw,
            ...ctx,
          });
          result[field.name] = null;
        } else {
          result[field.name] = coerced;
        }
        break;
      }

      case "date": {
        const coerced = coerceDate(raw, receivedAt, localeHints);
        if (coerced === null && typeof raw === "string" && raw.trim() !== "") {
          logger.track(`Classifier returned unparseable date value "${raw}" — nullified.`, {
            code: "classifier.date_parse_failed",
            field: field.name,
            value: raw,
            ...ctx,
          });
        }
        result[field.name] = coerced;
        break;
      }

      case "array": {
        if (!Array.isArray(raw)) {
          logger.track("Classifier returned non-array value for array field — nullified.", {
            code: "classifier.coercion_failed",
            field: field.name,
            value: raw,
            ...ctx,
          });
          result[field.name] = null;
        }
        // Arrays pass through as-is — inner element coercion is out of scope
        // (items are typed loosely in the registry as notes)
        break;
      }

      default:
        // Unknown type in registry — pass through without coercion
        break;
    }
  }

  return result;
}

function coerceEnumValue(raw: unknown, enumValues: Array<{ value: string }>): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  for (const ev of enumValues) {
    if (ev.value.toLowerCase() === trimmed) return ev.value;
  }
  return null;
}

/**
 * Formats for human-readable date parsing (first match wins after ISO).
 * Slash-separated numeric formats are explicitly excluded — they are ambiguous.
 */
const BASE_DATE_FORMATS_WITH_YEAR = [
  "d MMMM yyyy",
  "MMMM d, yyyy",
  "d MMM yyyy",
  "MMM d, yyyy",
  "dd.MM.yyyy",
];

const BASE_DATE_FORMATS_YEARFREE = [
  "d MMMM",
  "MMMM d",
  "d MMM",
  "MMM d",
];

/**
 * Expands a format list with a leading-weekday variant of each entry, using luxon's
 * own "ccc"/"cccc" weekday tokens rather than an enumerated word list — those tokens
 * resolve locale-specific weekday names via Intl (same mechanism already relied on for
 * MMM/MMMM month names below), so this covers "Fri, ...", "Friday, ...", and their
 * equivalents in any locale hint without us hardcoding weekday names per language.
 */
function withWeekdayPrefix(formats: string[]): string[] {
  return formats.flatMap(fmt => [fmt, `ccc, ${fmt}`, `cccc, ${fmt}`, `ccc ${fmt}`, `cccc ${fmt}`]);
}

/**
 * Expands a format list with a trailing-period variant for any bare "MMM" token (not
 * "MMMM"), e.g. "MMM d, yyyy" → also try "MMM. d, yyyy". Many locales abbreviate months
 * with a trailing period (English "Nov.", French "janv."); luxon's MMM token already
 * resolves the locale-specific abbreviation itself, so adding the period as a literal
 * in the format string covers it without us enumerating month abbreviations.
 */
function withAbbrevMonthPeriod(formats: string[]): string[] {
  const bareMmm = /(?<!M)MMM(?!M)/;
  return formats.flatMap(fmt => (bareMmm.test(fmt) ? [fmt, fmt.replace(bareMmm, "MMM.")] : [fmt]));
}

const DATE_FORMATS_WITH_YEAR = withWeekdayPrefix(withAbbrevMonthPeriod(BASE_DATE_FORMATS_WITH_YEAR));
const DATE_FORMATS_YEARFREE = withWeekdayPrefix(withAbbrevMonthPeriod(BASE_DATE_FORMATS_YEARFREE));

const TIME_SUFFIXES = ["", " HH:mm", " h:mm a", " 'at' HH:mm", " 'at' h:mm a"];

/** Pattern to detect slash-separated numeric dates (e.g. 01/02/2025, 1/2/25). */
const SLASH_DATE_PATTERN = /\d+\/\d+/;

/**
 * Resolves a year-free date to the next occurrence strictly after receivedAt.
 * If the candidate (in the receivedAt year) is after receivedAt, use it.
 * Otherwise advance to the next year.
 */
function resolveYearFree(month: number, day: number, receivedAt: DateTime): DateTime {
  const candidate = DateTime.fromObject({ year: receivedAt.year, month, day });
  if (candidate > receivedAt) return candidate;
  return DateTime.fromObject({ year: receivedAt.year + 1, month, day });
}

/**
 * Known locale time-noise suffixes that carry no semantic value beyond the time digits.
 * Stripped before attempting format-based parsing.
 */
const LOCALE_TIME_NOISE = /(?<=\d)\s*(?:Uhr|o'clock|h(?:rs?)?|heure[s]?|ч(?:ас(?:ов|а)?)?|uur|ore|godzin[ay]?)\s*$/i;

/**
 * Coerces a raw date value into a Display_Date string.
 *
 * Parse order:
 * 1. ISO 8601 (with or without offset)
 * 2. Human-readable formats (day MMMM yyyy, MMMM d yyyy, dot-separated, year-free, with/without time)
 * 3. Locale-aware fallback using localeHints (Content-Language, html lang, classifier-detected)
 * 4. null on failure
 *
 * Slash-separated numeric dates are rejected as ambiguous.
 *
 * Output format:
 * - date+time+offset → "YYYY-MM-DDTHH:mm±HH:mm"
 * - date+time, no offset → "YYYY-MM-DDTHH:mm"
 * - date only → "YYYY-MM-DD"
 */
export function coerceDate(value: unknown, receivedAt: string, localeHints: string[] = []): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // Reject slash-separated numeric dates (ambiguous dd/MM vs MM/dd)
  if (SLASH_DATE_PATTERN.test(trimmed)) return null;

  const receivedAtDt = DateTime.fromISO(receivedAt, { zone: "utc" });

  // 1. Try ISO 8601
  const iso = DateTime.fromISO(trimmed, { setZone: true });
  if (iso.isValid) {
    return formatDisplayDate(iso, trimmed);
  }

  // Strip locale time noise (e.g. "Uhr", "o'clock") for format-based parsing
  const cleaned = trimmed.replace(LOCALE_TIME_NOISE, "").trim();
  const input = cleaned || trimmed;

  // 2. Try human-readable formats with year + time variants
  for (const fmt of DATE_FORMATS_WITH_YEAR) {
    for (const timeSuffix of TIME_SUFFIXES) {
      const fullFmt = fmt + timeSuffix;
      const parsed = DateTime.fromFormat(input, fullFmt);
      if (parsed.isValid) {
        return formatDisplayDate(parsed, trimmed, timeSuffix !== "");
      }
    }
  }

  // 3. Try year-free formats + time variants
  for (const fmt of DATE_FORMATS_YEARFREE) {
    for (const timeSuffix of TIME_SUFFIXES) {
      const fullFmt = fmt + timeSuffix;
      const parsed = DateTime.fromFormat(input, fullFmt);
      if (parsed.isValid) {
        const resolved = resolveYearFree(parsed.month, parsed.day, receivedAtDt);
        if (timeSuffix !== "") {
          const withTime = resolved.set({ hour: parsed.hour, minute: parsed.minute });
          return formatDisplayDate(withTime, trimmed, true);
        }
        return resolved.toFormat("yyyy-MM-dd");
      }
    }
  }

  // 4. Locale-aware fallback — try each locale hint with all formats
  const uniqueLocales = [...new Set(localeHints.filter(Boolean))];
  for (const locale of uniqueLocales) {
    for (const fmt of DATE_FORMATS_WITH_YEAR) {
      for (const timeSuffix of TIME_SUFFIXES) {
        const fullFmt = fmt + timeSuffix;
        const parsed = DateTime.fromFormat(input, fullFmt, { locale });
        if (parsed.isValid) {
          return formatDisplayDate(parsed, trimmed, timeSuffix !== "");
        }
      }
    }
    for (const fmt of DATE_FORMATS_YEARFREE) {
      for (const timeSuffix of TIME_SUFFIXES) {
        const fullFmt = fmt + timeSuffix;
        const parsed = DateTime.fromFormat(input, fullFmt, { locale });
        if (parsed.isValid) {
          const resolved = resolveYearFree(parsed.month, parsed.day, receivedAtDt);
          if (timeSuffix !== "") {
            const withTime = resolved.set({ hour: parsed.hour, minute: parsed.minute });
            return formatDisplayDate(withTime, trimmed, true);
          }
          return resolved.toFormat("yyyy-MM-dd");
        }
      }
    }
  }

  return null;
}

/**
 * Formats a parsed DateTime into the Display_Date output format.
 * - Has offset in original input → preserve as YYYY-MM-DDTHH:mm±HH:mm
 * - Has time but no offset → YYYY-MM-DDTHH:mm
 * - Date only → YYYY-MM-DD
 */
function formatDisplayDate(dt: DateTime, originalInput: string, hasTime?: boolean): string {
  const inputHasOffset = hasExplicitOffset(originalInput);
  const inputHasTime = hasTime ?? hasTimeComponent(originalInput);

  if (inputHasTime && inputHasOffset) {
    // Preserve the offset — format as YYYY-MM-DDTHH:mm±HH:mm
    const offset = dt.toFormat("ZZ");
    return `${dt.toFormat("yyyy-MM-dd")}T${dt.toFormat("HH:mm")}${offset}`;
  }
  if (inputHasTime) {
    return `${dt.toFormat("yyyy-MM-dd")}T${dt.toFormat("HH:mm")}`;
  }
  return dt.toFormat("yyyy-MM-dd");
}

/** Checks if the original string has an explicit timezone offset (Z, +HH:mm, -HH:mm). */
function hasExplicitOffset(input: string): boolean {
  // Z at end after a T separator (ISO style)
  if (/T.+Z$/i.test(input)) return true;
  // +HH:mm or -HH:mm at end
  if (/[+-]\d{2}:\d{2}$/.test(input)) return true;
  // +HHmm or -HHmm at end (compact offset)
  if (/[+-]\d{4}$/.test(input)) return true;
  return false;
}

/** Checks if the original string contains a time component. */
function hasTimeComponent(input: string): boolean {
  // ISO with T separator followed by time
  if (/T\d{2}:\d{2}/.test(input)) return true;
  // Human time pattern: digits:digits, possibly followed by AM/PM
  // Only matches if the colon-separated digits appear after a space (not standalone)
  if (/\s\d{1,2}:\d{2}/.test(input)) return true;
  return false;
}

// Exported for testing
export { coerceNumericToString, coerceBoolean, coerceString };
