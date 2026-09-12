import { DateTime } from "luxon";

import type { Logger } from "../logger.js";
import { CLASSIFIER_WORKFLOW_REGISTRY } from "../types/workflow-registry.js";
import type { AmbiguousDateFormat } from "../types/index.js";
import { displayToInstant } from "./display-to-instant.js";

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
  ambiguousDateFormat: AmbiguousDateFormat = "skip",
  accountTimezone = "Europe/London",
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
        const coerced = coerceDate(raw, receivedAt, localeHints, ambiguousDateFormat);
        if (coerced === null && typeof raw === "string" && raw.trim() !== "") {
          if (isAmbiguousSlashSkip(raw, ambiguousDateFormat)) {
            // Expected policy skip — the date is a valid slash format but its
            // month/day order is ambiguous and the account opted to skip. Omit the
            // raw date: the value itself is not the problem, the ambiguity is.
            logger.warn("Classifier returned an ambiguous slash date format — skipped per account setting.", {
              code: "classifier.date_ambiguous_skipped",
              field: field.name,
              ...ctx,
            });
          } else {
            logger.track(`Classifier returned unparseable date value "${raw}" — nullified.`, {
              code: "classifier.date_parse_failed",
              field: field.name,
              value: raw,
              ...ctx,
            });
          }
        }
        result[field.name] = coerced;
        // Compute the UTC instant once, here, alongside the display string. The
        // account timezone is only a fallback for offset-free display strings.
        // Stored as a "<field>Instant" sibling so downstream consumers (resource
        // resolution, thread triggers) never reparse the display string.
        result[`${field.name}Instant`] = coerced === null ? null : displayToInstant(coerced, accountTimezone);
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

  // Post-coercion defaults — workflow-specific fields that should never be empty
  if (workflow === "payments" && !result.date) {
    const dt = DateTime.fromISO(receivedAt, { zone: "utc" });
    if (dt.isValid) {
      result.date = dt.toFormat("yyyy-MM-dd");
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

const TIME_SUFFIXES = [
  "",
  " HH:mm",
  " h:mm a",
  " 'at' HH:mm",
  " 'at' h:mm a",
  // Comma before the time, and a dot instead of a colon (e.g. "Oct 27, 2026, 18.30").
  ", HH.mm",
];

/** Ordinal day suffixes ("1st", "2nd", "3rd", "10th") — luxon's `d` token needs a bare number. */
const ORDINAL_DAY_SUFFIX = /(\d)(?:st|nd|rd|th)\b/gi;

/** A trailing parenthesized timezone abbreviation, e.g. "(CEST)", "(GMT)". */
const TRAILING_ZONE_ABBREVIATION = /\s*\([A-Za-z]{2,5}\)\s*$/;

/** Pattern to detect slash-separated numeric dates (e.g. 01/02/2025, 1/2/25). */
const SLASH_DATE_PATTERN = /\d+\/\d+/;

/** Captures the two numeric components and optional year of a slash date. */
const SLASH_DATE_COMPONENTS = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/;

/**
 * True when a value was nullified specifically because it is a slash date whose
 * component order is genuinely ambiguous (both ≤ 12) and the account setting is
 * `skip`. Lets the caller downgrade the log to a WARN without the raw date — this
 * is an expected policy skip, not a parse failure. A slash date with a component
 * > 12 is unambiguous and would have parsed, so it is never an ambiguous skip.
 */
export function isAmbiguousSlashSkip(value: unknown, ambiguousDateFormat: AmbiguousDateFormat): boolean {
  if (ambiguousDateFormat !== "skip") return false;
  if (typeof value !== "string") return false;
  const match = value.trim().match(SLASH_DATE_COMPONENTS);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first >= 1 && first <= 12 && second >= 1 && second <= 12;
}

/** Captures an optional clock time (with optional meridiem) anywhere in the string. */
const SLASH_DATE_TIME = /(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/i;
const SLASH_DATE_TIME_24H = /(\d{1,2}):(\d{2})/;

/**
 * Parses a slash-separated numeric date, disambiguating month/day order.
 *
 * Disambiguation:
 * - If the first component > 12, it must be the day → day_then_month order.
 * - Else if the second component > 12, it must be the day → month_then_day order.
 * - Else both are ≤ 12 (genuinely ambiguous) → use `ambiguousDateFormat`:
 *   month_then_day → first is month; day_then_month → first is day; skip → null.
 *
 * A two-digit year is interpreted via luxon's pivot (fromObject with a 4-digit
 * year is unambiguous; two-digit years are expanded to 20xx by prefixing). A
 * missing year resolves to the next future occurrence relative to receivedAt.
 * An optional trailing time (after any separator, including "|") is preserved.
 */
function coerceSlashDate(
  input: string,
  receivedAt: DateTime,
  ambiguousDateFormat: AmbiguousDateFormat,
): string | null {
  const dateMatch = input.match(SLASH_DATE_COMPONENTS);
  if (!dateMatch) return null;

  const first = Number(dateMatch[1]);
  const second = Number(dateMatch[2]);
  const yearRaw = dateMatch[3];

  let month: number;
  let day: number;
  if (first > 12 && second <= 12) {
    day = first; month = second;
  } else if (second > 12 && first <= 12) {
    month = first; day = second;
  } else if (first > 12 && second > 12) {
    return null; // Neither can be a month — not a real date.
  } else {
    // Ambiguous — both ≤ 12.
    if (ambiguousDateFormat === "skip") return null;
    if (ambiguousDateFormat === "month_then_day") { month = first; day = second; }
    else { day = first; month = second; }
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Optional time — prefer meridiem form, fall back to bare 24h. Search the whole
  // string so separators like "03/02/2027 | 18:30" don't need special handling.
  let hour: number | null = null;
  let minute = 0;
  const meridiem = input.match(SLASH_DATE_TIME);
  const bare = input.match(SLASH_DATE_TIME_24H);
  if (meridiem) {
    hour = Number(meridiem[1]) % 12;
    if (meridiem[3]!.toLowerCase() === "p") hour += 12;
    minute = Number(meridiem[2]);
  } else if (bare) {
    hour = Number(bare[1]);
    minute = Number(bare[2]);
  }

  const hasTime = hour !== null;

  let dt: DateTime;
  if (yearRaw !== undefined) {
    const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
    dt = DateTime.fromObject({ year, month, day, ...(hasTime ? { hour: hour!, minute } : {}) });
  } else {
    const resolved = resolveYearFree(month, day, receivedAt);
    dt = hasTime ? resolved.set({ hour: hour!, minute }) : resolved;
  }

  if (!dt.isValid) return null;
  if (hasTime) return `${dt.toFormat("yyyy-MM-dd")}T${dt.toFormat("HH:mm")}`;
  return dt.toFormat("yyyy-MM-dd");
}

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
 * Dotted meridiem markers (a.m./p.m. and locale-cased variants) that luxon's `a`
 * token does not match — it expects the undotted form (am/AM). Only the meridiem
 * is normalized; other periods (dd.MM.yyyy separators, MMM. month abbreviations)
 * are left intact. Requires a preceding digit so it can't collide with sentence text.
 */
const DOTTED_MERIDIEM = /(?<=\d)\s*([ap])\.\s*m\.?/gi;

/**
 * Date connectors by base language subtag. Emails often phrase appointments
 * time-first ("9:30 a.m. on February 1"), but every parse format is date-first.
 * These connectors introduce the DATE portion in a time-first string; we use the
 * classifier-detected locale to pick the right one and reorder to date-first.
 *
 * Ordering within each list matters: multi-word/longer connectors first so they
 * match before a shorter substring (e.g. "a las" before any bare token).
 */
const DATE_CONNECTORS_BY_LANG: Record<string, string[]> = {
  en: ["on"],
  de: ["am"],
  fr: ["le"],
  es: ["el"],
  it: ["il"],
  nl: ["op"],
};

/**
 * Leading time connectors that introduce the TIME portion when it comes first
 * (German "um 17:00", French "à 14:30"). Stripped from the front before reorder
 * so the residual time token is clean. English "at" is handled by TIME_SUFFIXES.
 */
const LEADING_TIME_CONNECTOR = /^(?:um|à|a las|alle|om)\s+/i;

/** A bare clock time at the start of the string: "9:30", "14:30". */
const LEADING_TIME = /^\d{1,2}:\d{2}/;

/** An optional meridiem token immediately following a leading time: " am", " p.m.". */
const LEADING_MERIDIEM = /^\s*[ap]\.?\s*m\.?/i;

/**
 * Reorders a time-first string ("TIME <connector> DATE") into date-first
 * ("DATE TIME") so the existing date-first format machinery can parse it.
 * Returns the original string unchanged if it is not time-first.
 *
 * Locale-driven: the DATE connector is chosen from the detected language subtags,
 * which avoids cross-locale collisions (German "am" is a connector only under a
 * German hint, never treated as the English meridiem).
 */
function reorderTimeFirst(input: string, localeHints: string[]): string {
  const withoutLeadConnector = input.replace(LEADING_TIME_CONNECTOR, "");
  const timeMatch = withoutLeadConnector.match(LEADING_TIME);
  if (!timeMatch) return input;

  // Text after the bare clock time, before any meridiem token is consumed.
  const afterTime = withoutLeadConnector.slice(timeMatch[0].length);

  const langs = new Set(localeHints.map(h => h.split("-")[0]!.toLowerCase()));
  langs.add("en"); // English "on" is always in scope regardless of hint
  const connectors = [...langs].flatMap(lang => DATE_CONNECTORS_BY_LANG[lang] ?? []);

  // Try connector match twice: once treating a bare meridiem word as a connector
  // (German "am"), once treating it as the time's meridiem (English "9:30 am on").
  // Prefer the meridiem-inclusive read so "9:30 am on <date>" keeps its meridiem;
  // fall back to bare-time read so "17:00 am <date>" (de) reorders correctly.
  const meridiemMatch = afterTime.match(LEADING_MERIDIEM);
  const candidates: Array<{ time: string; rest: string }> = [];
  if (meridiemMatch) {
    candidates.push({
      time: (timeMatch[0] + meridiemMatch[0]).trim(),
      rest: afterTime.slice(meridiemMatch[0].length).trimStart(),
    });
  }
  candidates.push({ time: timeMatch[0].trim(), rest: afterTime.trimStart() });

  for (const { time, rest } of candidates) {
    for (const connector of connectors) {
      const re = new RegExp(`^${connector}\\s+`, "i");
      if (re.test(rest)) {
        const datePart = rest.replace(re, "");
        return `${datePart} ${time}`;
      }
    }
  }
  return input;
}

/**
 * Coerces a raw date value into a Display_Date string.
 *
 * Parse order:
 * 1. ISO 8601 (with or without offset)
 * 2. Human-readable formats (day MMMM yyyy, MMMM d yyyy, dot-separated, year-free, with/without time)
 * 3. Locale-aware fallback using localeHints (Content-Language, html lang, classifier-detected)
 * 4. null on failure
 *
 * Slash-separated numeric dates ("03/02/2027") are disambiguated by value where
 * possible (a component > 12 must be the day); when both components are ≤ 12 the
 * order is genuinely ambiguous and the account's `ambiguousDateFormat` setting
 * decides (month_then_day / day_then_month / skip).
 *
 * Output format:
 * - date+time+offset → "YYYY-MM-DDTHH:mm±HH:mm"
 * - date+time, no offset → "YYYY-MM-DDTHH:mm"
 * - date only → "YYYY-MM-DD"
 */
export function coerceDate(
  value: unknown,
  receivedAt: string,
  localeHints: string[] = [],
  ambiguousDateFormat: AmbiguousDateFormat = "skip",
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const receivedAtDt = DateTime.fromISO(receivedAt, { zone: "utc" });

  // Slash-separated numeric dates are ambiguous (dd/MM vs MM/dd). Disambiguate by
  // value, else fall back to the account setting. Handled before the format loops
  // because ISO/word-based formats never contain slashes.
  if (SLASH_DATE_PATTERN.test(trimmed)) {
    return coerceSlashDate(trimmed, receivedAtDt, ambiguousDateFormat);
  }

  // 1. Try ISO 8601
  const iso = DateTime.fromISO(trimmed, { setZone: true });
  if (iso.isValid) {
    return formatDisplayDate(iso, trimmed);
  }

  // Reorder time-first phrasings ("9:30 a.m. on February 1") into date-first,
  // then normalize dotted meridiem (a.m. → am) so luxon's `a` token matches, then
  // strip locale time noise (e.g. "Uhr", "o'clock") and a trailing zone abbreviation
  // (e.g. "(CEST)") for format-based parsing. Ordinal day suffixes ("3rd", "10th")
  // and the non-standard "Sept" abbreviation are normalized to forms luxon's `d`/`MMM`
  // tokens accept.
  const reordered = reorderTimeFirst(trimmed, localeHints);
  const normalized = reordered.replace(DOTTED_MERIDIEM, " $1m");
  const cleaned = normalized
    .replace(LOCALE_TIME_NOISE, "")
    .replace(TRAILING_ZONE_ABBREVIATION, "")
    .replace(ORDINAL_DAY_SUFFIX, "$1")
    .replace(/\bSept\b/gi, "Sep")
    .trim();
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
