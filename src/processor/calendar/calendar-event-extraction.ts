// ---------------------------------------------------------------------------
// Shared calendar-attachment extraction: fetches every calendar attachment on
// a signal, parses all VEVENTs out of each, and collapses them by event
// identity into the CalendarEventData snapshots that should become
// calendar_event signals. Used by both initial ingest (processor.ts) and the
// post-approval path (post-approval-handler.ts) so the two don't drift.
// ---------------------------------------------------------------------------

import type { Attachment } from "../../types/index.js";
import type { Logger } from "../../logger.js";
import { findCalendarAttachments, parseIcsEvents, collapseCalendarEvents } from "./ics-parser.js";
import type { CalendarEventRecord, CollapsedCalendarEvent } from "./ics-parser.js";

export interface ContentFetcher {
  getContent(s3Key: string): Promise<Uint8Array>;
}

export interface InvalidCalendarAttachment {
  attachment: Attachment;
  reason: string;
}

export interface CalendarAttachmentExtractionResult {
  validEvents: CollapsedCalendarEvent[];
  invalidAttachments: InvalidCalendarAttachment[];
}

/**
 * Finds, fetches, and parses every calendar attachment on a signal, then
 * collapses the resulting VEVENTs into one snapshot per distinct event. Returns
 * null when the signal has no calendar attachments at all — callers use that
 * to skip calendar processing entirely, same as the old single-attachment path.
 */
export async function extractCalendarEvents(
  attachments: Attachment[],
  contentStore: ContentFetcher,
  logger: Logger,
): Promise<CalendarAttachmentExtractionResult | null> {
  const calendarAttachments = findCalendarAttachments(attachments, logger);
  if (calendarAttachments.length === 0) return null;

  const records: CalendarEventRecord[] = [];
  const invalidAttachments: InvalidCalendarAttachment[] = [];

  for (const attachment of calendarAttachments) {
    logger.trackPoint("calendar_attachment_found", { filename: attachment.filename, mimeType: attachment.mimeType });

    const icsBytes = await contentStore.getContent(attachment.s3Key);
    const parseResult = parseIcsEvents(new Uint8Array(icsBytes));

    if (parseResult.isErr()) {
      invalidAttachments.push({ attachment, reason: parseResult.error.reason });
      continue;
    }

    for (const event of parseResult.value.events) {
      records.push({ event, rawIcsContent: parseResult.value.rawIcsContent });
    }
  }

  const { collapsed } = collapseCalendarEvents(records, logger);
  return { validEvents: collapsed, invalidAttachments };
}
