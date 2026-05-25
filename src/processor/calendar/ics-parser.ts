import type { Attachment } from "../../types/index.js";
import type { Logger } from "../../logger.js";

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
