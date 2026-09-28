// ---------------------------------------------------------------------------
// Shared calendar-attachment extraction: fetches every calendar attachment on
// a signal, parses all VEVENTs out of each, and collapses them by event
// identity into the CalendarEventData snapshots that should become
// calendar_event signals. Used by both initial ingest (processor.ts) and the
// post-approval path (post-approval-handler.ts) so the two don't drift.
// ---------------------------------------------------------------------------

import type { Attachment } from "../../types/index.js";
import type { Logger } from "../../logger.js";
import { IcsParser, parseIcsEvents } from "./ics-parser.js";
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
 * Fetches and parses every calendar attachment on a signal, then collapses the
 * resulting VEVENTs into one snapshot per distinct event. Used by both initial
 * ingest and the post-approval path so the two don't drift. The content store
 * and logger are constructor collaborators — callers say "extract these
 * attachments", never how to fetch or where to log.
 */
export class CalendarExtractor {
  private readonly icsParser: IcsParser;

  constructor(
    private readonly contentStore: ContentFetcher,
    private readonly logger: Logger,
  ) {
    this.icsParser = new IcsParser(logger);
  }

  /**
   * Returns null when the signal has no calendar attachments at all — callers
   * use that to skip calendar processing entirely.
   */
  async extract(attachments: Attachment[]): Promise<CalendarAttachmentExtractionResult | null> {
    const calendarAttachments = this.icsParser.findCalendarAttachments(attachments);
    if (calendarAttachments.length === 0) return null;

    const records: CalendarEventRecord[] = [];
    const invalidAttachments: InvalidCalendarAttachment[] = [];

    for (const attachment of calendarAttachments) {
      this.logger.trackPoint("calendar_attachment_found", { filename: attachment.filename, mimeType: attachment.mimeType });

      const icsBytes = await this.contentStore.getContent(attachment.s3Key);
      const parseResult = parseIcsEvents(new Uint8Array(icsBytes));

      if (parseResult.isErr()) {
        invalidAttachments.push({ attachment, reason: parseResult.error.reason });
        continue;
      }

      for (const event of parseResult.value.events) {
        records.push({ event, rawIcsContent: parseResult.value.rawIcsContent });
      }
    }

    const { collapsed } = this.icsParser.collapseCalendarEvents(records);
    return { validEvents: collapsed, invalidAttachments };
  }
}
