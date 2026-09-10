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

export interface IcsEventsParseResult {
  events: CalendarEventData[];
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
// parseIcs / parseIcsEvents
// ---------------------------------------------------------------------------

interface ParsedVCalendar {
  vcalendar: InstanceType<typeof ICAL.Component>;
  method: string | null;
  rawIcsContent: string;
  startTime: number;
}

/**
 * Shared jCal parse + validation: size limit, malformed-structure/nesting-depth
 * checks, VTIMEZONE bomb check, and VALARM stripping. Used by both the
 * single-event and all-events entry points below.
 */
function parseVCalendar(icsBytes: Uint8Array): Result<ParsedVCalendar, IcsParseError> {
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

  // --- Extract METHOD from VCALENDAR level ---
  // METHOD is not strictly required by RFC 5545 but we need it for routing;
  // callers fall back to "REQUEST" if missing (common in standalone .ics files).
  const method = vcalendar.getFirstPropertyValue("method") as string | null;

  return ok({ vcalendar, method, rawIcsContent, startTime });
}

/**
 * Extracts structured CalendarEventData from a single VEVENT component.
 * Pure function — no I/O.
 */
function buildEventData(vevent: InstanceType<typeof ICAL.Component>, method: string | null): CalendarEventData {
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
  const startTimeIso = icalTimeToIso(dtstart);
  const dtendIso = dtend ? icalTimeToIso(dtend) : undefined;
  // Guard against malformed source data (e.g. a stale DTEND from a cloned recurring
  // event template): an end before the start isn't a usable range, so drop it rather
  // than surface a nonsensical date span.
  const endTimeIso = dtendIso && startTimeIso && dtendIso < startTimeIso ? undefined : dtendIso;
  const createdIso = created ? icalTimeToIso(created) : undefined;
  const lastModifiedIso = lastModified ? icalTimeToIso(lastModified) : undefined;
  const recurrenceIdIso = recurrenceId ? icalTimeToIso(recurrenceId) : undefined;

  return {
    title,
    ...(description !== null ? { description } : {}),
    startTime: startTimeIso ?? "",
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
}

/**
 * Parses raw .ics bytes into structured CalendarEventData from its first VEVENT.
 *
 * Enforces size/complexity limits, strips VALARM, sanitizes URLs.
 * Pure function — no I/O.
 */
export function parseIcs(icsBytes: Uint8Array): Result<IcsParseResult, IcsParseError> {
  const parsed = parseVCalendar(icsBytes);
  if (parsed.isErr()) return err(parsed.error);
  const { vcalendar, method, rawIcsContent, startTime } = parsed.value;

  const vevent = vcalendar.getFirstSubcomponent("vevent");
  if (!vevent) {
    return err({ reason: "Malformed iCal structure: no VEVENT component found" });
  }

  const calendarData = buildEventData(vevent, method);

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
 * Parses raw .ics bytes into structured CalendarEventData for EVERY VEVENT
 * component present (a single .ics can carry a master recurring event plus
 * RECURRENCE-ID exceptions, or unrelated events entirely).
 *
 * Enforces size/complexity limits, strips VALARM, sanitizes URLs.
 * Pure function — no I/O.
 */
export function parseIcsEvents(icsBytes: Uint8Array): Result<IcsEventsParseResult, IcsParseError> {
  const parsed = parseVCalendar(icsBytes);
  if (parsed.isErr()) return err(parsed.error);
  const { vcalendar, method, rawIcsContent, startTime } = parsed.value;

  const vevents = vcalendar.getAllSubcomponents("vevent");
  if (vevents.length === 0) {
    return err({ reason: "Malformed iCal structure: no VEVENT component found" });
  }

  const events = vevents.map((vevent) => buildEventData(vevent, method));

  // --- Output size limit ---
  const serialized = JSON.stringify(events);
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_SIZE) {
    return err({ reason: "Parsed calendar data exceeds 100 KB limit" });
  }

  // --- Post-parse timeout check ---
  if (Date.now() - startTime > PARSE_TIMEOUT_MS) {
    return err({ reason: "Parse timeout exceeded 5 seconds" });
  }

  return ok({ events, rawIcsContent });
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
 * Finds every calendar attachment on a signal's attachment list.
 *
 * An attachment is a calendar attachment if it has MIME type `text/calendar` OR
 * filename ending in `.ics`. Every match is returned — none are discarded — so
 * the caller can extract and merge events across all of them (see
 * `collapseCalendarEvents`). Logs TRACK when more than one is found.
 */
export function findCalendarAttachments(attachments: Attachment[], logger: Logger): Attachment[] {
  const calendarAttachments = attachments.filter(isCalendarAttachment);

  if (calendarAttachments.length > 1) {
    logger.track(
      `Multiple calendar attachments found on signal (${calendarAttachments.length}). Extracting events from all of them.`,
      {
        code: "ics_parser.multiple_calendar_attachments",
        count: calendarAttachments.length,
        candidates: calendarAttachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType })),
      },
    );
  }

  return calendarAttachments;
}

// ---------------------------------------------------------------------------
// Event grouping / collapse
// ---------------------------------------------------------------------------

const REPLY_LIKE_METHODS = new Set(["REPLY", "COUNTER"]);

export interface CalendarEventRecord {
  event: CalendarEventData;
  rawIcsContent: string;
}

export interface CollapsedCalendarEvent {
  key: string;
  data: CalendarEventData;
  rawIcsContent: string;
}

export interface CollapseCalendarEventsResult {
  collapsed: CollapsedCalendarEvent[];
  // REPLY/COUNTER groups with no accompanying REQUEST/CANCEL/PUBLISH record in the
  // same batch — there's no base snapshot to attach the attendee status to, so
  // no calendar_event can be built from them here.
  skippedReplyOnly: number;
}

/** Grouping key: RECURRENCE-ID exceptions are distinct from their master series. */
function eventGroupKey(event: CalendarEventData): string {
  return event.recurrenceId ? `${event.veventUid}::${event.recurrenceId}` : event.veventUid;
}

/**
 * Groups extracted VEVENTs (potentially from multiple .ics attachments on one
 * signal) by event identity (UID, or UID+RECURRENCE-ID for occurrence
 * exceptions), then collapses each group down to the one CalendarEventData
 * snapshot that should become that event's calendar_event signal:
 *
 * - Any CANCEL record in the group cancels the event (status set to CANCELLED).
 * - Otherwise the highest-SEQUENCE REQUEST/PUBLISH record wins as the snapshot.
 * - REPLY/COUNTER records never become the snapshot themselves — they only
 *   overlay their attendee's PARTSTAT onto the winning snapshot's attendees.
 * - A group made up entirely of REPLY/COUNTER records (no REQUEST/CANCEL/PUBLISH
 *   in this same batch to carry title/organizer/start/etc.) can't produce a
 *   valid calendar_event and is skipped — reported via `skippedReplyOnly` and a
 *   TRACK log so it's visible rather than silently dropped.
 */
export function collapseCalendarEvents(records: CalendarEventRecord[], logger: Logger): CollapseCalendarEventsResult {
  const groups = new Map<string, CalendarEventRecord[]>();
  for (const record of records) {
    const key = eventGroupKey(record.event);
    const group = groups.get(key);
    if (group) {
      group.push(record);
      continue;
    }
    groups.set(key, [record]);
  }

  const collapsed: CollapsedCalendarEvent[] = [];
  let skippedReplyOnly = 0;

  for (const [key, group] of groups) {
    const fullRecords = group.filter((r) => !REPLY_LIKE_METHODS.has(r.event.method));
    const replyRecords = group.filter((r) => REPLY_LIKE_METHODS.has(r.event.method));

    if (fullRecords.length === 0) {
      skippedReplyOnly++;
      logger.track("REPLY/COUNTER calendar record has no matching invite in this batch; cannot build a calendar_event from it alone.", {
        code: "ics_parser.reply_only_group_skipped",
        key,
        veventUid: group[0]!.event.veventUid,
        count: replyRecords.length,
      });
      continue;
    }

    const winnerRecord = [...fullRecords].sort((a, b) => a.event.sequence - b.event.sequence).at(-1)!;
    const cancelled = fullRecords.some((r) => r.event.method === "CANCEL");

    if (group.length > 1) {
      logger.track(`Calendar event ${key} assembled from ${group.length} record(s) across attachments; collapsed to one signal.`, {
        code: "ics_parser.multiple_records_collapsed",
        key,
        veventUid: winnerRecord.event.veventUid,
        recordCount: group.length,
        cancelled,
      });
    }

    let attendees = winnerRecord.event.attendees;
    for (const reply of replyRecords) {
      for (const incoming of reply.event.attendees) {
        if (!incoming.partstat) continue;
        const idx = attendees.findIndex((a) => a.address.toLowerCase() === incoming.address.toLowerCase());
        if (idx === -1) continue;
        if (attendees === winnerRecord.event.attendees) attendees = [...attendees];
        attendees[idx] = { ...attendees[idx]!, partstat: incoming.partstat };
      }
    }

    const data: CalendarEventData = {
      ...winnerRecord.event,
      attendees,
      ...(cancelled ? { status: "CANCELLED" } : {}),
    };

    collapsed.push({ key, data, rawIcsContent: winnerRecord.rawIcsContent });
  }

  return { collapsed, skippedReplyOnly };
}
