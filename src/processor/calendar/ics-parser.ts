import ICAL from "ical.js";
import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";

import type { Attachment } from "../../types/index.js";
import type { CalendarEventData, CalendarAttendee } from "../../types/calendar.js";
import type { Logger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IcsParseResult {
  calendarData: CalendarEventData;
  rawIcsContent: string;
}

export interface IcsParseError {
  reason: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 1_048_576; // 1 MB
const MAX_VTIMEZONE_COMPONENTS = 100;
const MAX_ATTENDEES = 100;
const MAX_NESTING_DEPTH = 5;
const PARSE_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_SIZE = 102_400; // 100 KB

// ---------------------------------------------------------------------------
// URL sanitization
// ---------------------------------------------------------------------------

const ALLOWED_SCHEMES = new Set(["https:", "http:", "mailto:"]);
const BASIC_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Private IPv4 ranges: 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.x.x.x
const PRIVATE_IP_PATTERNS = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
];

/**
 * Validates and sanitizes a URL extracted from iCal data.
 * Returns the URL if valid, empty string if disallowed.
 */
export function sanitizeUrl(raw: string): string {
  if (!raw) return "";

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) return "";

  if (parsed.protocol === "mailto:") {
    // Extract email from mailto: URI (pathname contains the address)
    const email = parsed.pathname;
    if (!BASIC_EMAIL_REGEX.test(email)) return "";
    return raw;
  }

  // http/https: validate hostname
  const hostname = parsed.hostname;

  // Reject IP literals (IPv6 brackets or IPv4 dotted notation)
  if (hostname.startsWith("[")) return "";
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    // It's an IPv4 address — check if private or localhost
    if (PRIVATE_IP_PATTERNS.some(p => p.test(hostname))) return "";
    // Even public IPs are rejected (spec says "no IP address literals")
    return "";
  }

  // Reject localhost
  if (hostname === "localhost" || hostname === "localhost.localdomain") return "";

  return raw;
}

// ---------------------------------------------------------------------------
// Nesting depth check
// ---------------------------------------------------------------------------

function checkNestingDepth(jCal: unknown[], depth: number): boolean {
  if (depth > MAX_NESTING_DEPTH) return false;
  // jCal format: [name, properties[], subcomponents[]]
  const subcomponents = jCal[2];
  if (Array.isArray(subcomponents)) {
    for (const sub of subcomponents) {
      if (Array.isArray(sub) && !checkNestingDepth(sub as unknown[], depth + 1)) {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Time conversion helper
// ---------------------------------------------------------------------------

function icalTimeToIso(time: unknown): string | undefined {
  if (!time) return undefined;
  if (typeof time === "string") return time;
  // ICAL.Time objects have toJSDate()
  if (typeof (time as { toJSDate?: () => Date }).toJSDate === "function") {
    return (time as { toJSDate: () => Date }).toJSDate().toISOString();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// parseIcs
// ---------------------------------------------------------------------------

/**
 * Parses raw .ics bytes into structured CalendarEventData.
 *
 * Enforces size/complexity limits, strips VALARM, sanitizes URLs.
 * Pure function — no I/O.
 */
export function parseIcs(icsBytes: Uint8Array): Result<IcsParseResult, IcsParseError> {
  // --- Size limit ---
  if (icsBytes.byteLength > MAX_FILE_SIZE) {
    return err({ reason: "File exceeds 1 MB size limit" });
  }

  const rawIcsContent = new TextDecoder().decode(icsBytes);

  // --- Parse with timeout ---
  let jCalData: unknown;
  const startTime = Date.now();
  try {
    jCalData = ICAL.parse(rawIcsContent);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown parse error";
    return err({ reason: `Malformed iCal structure: ${message}` });
  }

  if (Date.now() - startTime > PARSE_TIMEOUT_MS) {
    return err({ reason: "Parse timeout exceeded 5 seconds" });
  }

  // --- Nesting depth check ---
  if (!Array.isArray(jCalData) || jCalData.length < 3) {
    return err({ reason: "Malformed iCal structure: invalid jCal data" });
  }
  if (!checkNestingDepth(jCalData as unknown[], 1)) {
    return err({ reason: "Excessive nesting depth" });
  }

  const vcalendar = new ICAL.Component(jCalData as unknown[]);

  // --- VTIMEZONE bomb check ---
  const vtimezones = vcalendar.getAllSubcomponents("vtimezone");
  if (vtimezones.length > MAX_VTIMEZONE_COMPONENTS) {
    return err({ reason: "Suspected VTIMEZONE bomb" });
  }

  // --- Strip all VALARM components ---
  const vevents = vcalendar.getAllSubcomponents("vevent");
  for (const vevent of vevents) {
    vevent.removeAllSubcomponents("valarm");
  }

  // --- Find the first VEVENT ---
  const vevent = vcalendar.getFirstSubcomponent("vevent");
  if (!vevent) {
    return err({ reason: "Malformed iCal structure: no VEVENT component found" });
  }

  // --- Extract METHOD from VCALENDAR level ---
  const method = vcalendar.getFirstPropertyValue("method") as string | null;
  if (!method) {
    // METHOD is not strictly required by RFC 5545 but we need it for routing
    // Fall back to "REQUEST" if missing (common in standalone .ics files)
  }

  // --- Extract VEVENT properties ---
  const title = (vevent.getFirstPropertyValue("summary") as string | null) ?? "";
  const description = vevent.getFirstPropertyValue("description") as string | null;
  const location = vevent.getFirstPropertyValue("location") as string | null;
  const urlRaw = vevent.getFirstPropertyValue("url") as string | null;
  const uid = (vevent.getFirstPropertyValue("uid") as string | null) ?? "";
  const status = vevent.getFirstPropertyValue("status") as string | null;
  const transparency = vevent.getFirstPropertyValue("transp") as string | null;
  const sequenceRaw = vevent.getFirstPropertyValue("sequence");
  const sequence = typeof sequenceRaw === "number" ? sequenceRaw : 0;

  // Time fields
  const dtstart = vevent.getFirstPropertyValue("dtstart");
  const dtend = vevent.getFirstPropertyValue("dtend");
  const created = vevent.getFirstPropertyValue("created");
  const lastModified = vevent.getFirstPropertyValue("last-modified");
  const recurrenceId = vevent.getFirstPropertyValue("recurrence-id");

  // RRULE
  const rruleProp = vevent.getFirstProperty("rrule");
  const recurrenceRule = rruleProp ? rruleProp.getFirstValue()?.toString() : undefined;

  // --- ORGANIZER ---
  const organizerProp = vevent.getFirstProperty("organizer");
  let organizer = "";
  let organizerCn: string | undefined;
  if (organizerProp) {
    const orgValue = organizerProp.getFirstValue() as string | null;
    if (orgValue) {
      // ORGANIZER value is typically "mailto:email@example.com"
      organizer = orgValue.replace(/^mailto:/i, "");
    }
    const cn = organizerProp.getParameter("cn");
    if (cn) {
      organizerCn = Array.isArray(cn) ? cn[0] : cn;
    }
  }

  // --- ATTENDEES (max 100, silently truncated) ---
  const attendeeProps = vevent.getAllProperties("attendee");
  const attendees: CalendarAttendee[] = [];
  for (const prop of attendeeProps.slice(0, MAX_ATTENDEES)) {
    const value = prop.getFirstValue() as string | null;
    if (!value) continue;
    const address = value.replace(/^mailto:/i, "");
    const cn = prop.getParameter("cn");
    const partstat = prop.getParameter("partstat");
    const role = prop.getParameter("role");
    attendees.push({
      address,
      ...(cn ? { cn: Array.isArray(cn) ? cn[0] : cn } : {}),
      ...(partstat ? { partstat: Array.isArray(partstat) ? partstat[0] : partstat } : {}),
      ...(role ? { role: Array.isArray(role) ? role[0] : role } : {}),
    });
  }

  // --- X-Properties ---
  const allProps = vevent.getAllProperties();
  const xProperties: Record<string, string> = {};
  for (const prop of allProps) {
    if (prop.name.startsWith("x-")) {
      const val = prop.getFirstValue();
      if (typeof val === "string") {
        xProperties[prop.name.toUpperCase()] = val;
      }
    }
  }

  // --- URL sanitization ---
  const sanitizedUrl = urlRaw ? sanitizeUrl(urlRaw) : undefined;

  // --- Build CalendarEventData ---
  const endTimeIso = dtend ? icalTimeToIso(dtend) : undefined;
  const createdIso = created ? icalTimeToIso(created) : undefined;
  const lastModifiedIso = lastModified ? icalTimeToIso(lastModified) : undefined;
  const recurrenceIdIso = recurrenceId ? icalTimeToIso(recurrenceId) : undefined;

  const calendarData = {
    title,
    ...(description !== null ? { description } : {}),
    startTime: icalTimeToIso(dtstart) ?? "",
    ...(endTimeIso !== undefined ? { endTime: endTimeIso } : {}),
    ...(location !== null ? { location } : {}),
    ...(sanitizedUrl !== undefined ? { url: sanitizedUrl } : {}),
    organizer,
    ...(organizerCn !== undefined ? { organizerCn } : {}),
    attendees,
    veventUid: uid,
    method: method ?? "REQUEST",
    sequence,
    ...(status !== null ? { status } : {}),
    ...(transparency !== null ? { transparency } : {}),
    ...(createdIso !== undefined ? { created: createdIso } : {}),
    ...(lastModifiedIso !== undefined ? { lastModified: lastModifiedIso } : {}),
    ...(recurrenceRule !== undefined ? { recurrenceRule } : {}),
    ...(recurrenceIdIso !== undefined ? { recurrenceId: recurrenceIdIso } : {}),
    ...(Object.keys(xProperties).length > 0 ? { xProperties } : {}),
    originalVeventUid: uid,
    linkedSignalId: "",
  } satisfies CalendarEventData;

  // --- Output size limit ---
  const serialized = JSON.stringify(calendarData);
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_SIZE) {
    return err({ reason: "Parsed calendar data exceeds 100 KB limit" });
  }

  // --- Post-parse timeout check ---
  if (Date.now() - startTime > PARSE_TIMEOUT_MS) {
    return err({ reason: "Parse timeout exceeded 5 seconds" });
  }

  return ok({ calendarData, rawIcsContent });
}

/**
 * Determines whether an attachment is a calendar attachment based on MIME type or filename extension.
 */
function isCalendarAttachment(attachment: Attachment): boolean {
  if (attachment.mimeType.startsWith("text/calendar")) return true;
  if (attachment.filename.toLowerCase().endsWith(".ics")) return true;
  return false;
}

/**
 * Determines whether an attachment's MIME type includes a METHOD parameter,
 * indicating it was sent as an iMIP calendar message (e.g. text/calendar; method=REQUEST).
 */
function hasMethodParameter(attachment: Attachment): boolean {
  return /;\s*method=/i.test(attachment.mimeType);
}

/**
 * Detects the calendar attachment to parse from a signal's attachment list.
 *
 * Detection rules:
 * - An attachment is a calendar attachment if it has MIME type `text/calendar` OR filename ending in `.ics`
 * - When multiple calendar attachments exist, select the first one with a METHOD parameter in its MIME type
 * - If none has METHOD, fall back to the first calendar attachment
 * - Logs TRACK when multiple calendar attachments found
 * - Returns null if no calendar attachment is found
 */
export function findCalendarAttachment(attachments: Attachment[], logger: Logger): Attachment | null {
  const calendarAttachments = attachments.filter(isCalendarAttachment);

  if (calendarAttachments.length === 0) return null;

  if (calendarAttachments.length > 1) {
    logger.track("Multiple calendar attachments found on signal. Selecting by METHOD priority.", {
      code: "ics_parser.multiple_calendar_attachments",
      count: calendarAttachments.length,
    });
  }

  // Priority: first attachment with a METHOD parameter in its MIME type
  const withMethod = calendarAttachments.find(hasMethodParameter);
  if (withMethod !== undefined) return withMethod;

  // Fallback: first calendar attachment (guaranteed to exist since length > 0)
  return calendarAttachments[0] ?? null;
}
