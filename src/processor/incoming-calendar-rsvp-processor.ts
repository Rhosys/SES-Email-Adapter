// ---------------------------------------------------------------------------
// IncomingCalendarRsvpProcessor — the lifecycle half of the inbound calendar loop.
//
// A message addressed to {threadId}@{accountId}.{serviceDomain} is NOT a normal
// inbound email: it is an RSVP to an invite WE forwarded, coming back from the
// attendee's calendar app. It creates no email signal, has no classification, no
// thread-matching. Its job is narrow: fetch the raw message, pull the .ics (MIME
// parsing delegated to MailparserMimeParser, outside this boundary per ADR 011), ask
// CalendarForwarder to validate it (stateless: METHOD:REPLY + PARTSTAT + proxy-UID
// HMAC), then — only on success — look up the thread, relay the RSVP back to the
// organizer under the alias, and record a calendar_response signal.
//
// Every failure short of that resolves to ok(undefined) with a WARN: a message
// that reached this address but isn't a processable RSVP (no .ics, unparseable,
// wrong METHOD, forged HMAC, unknown thread) is dropped silently, never retried,
// never turned into a signal. Only genuine infrastructure errors (S3/DB) return err.
// ---------------------------------------------------------------------------

import { DateTime } from "luxon";
import { ok, err } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { EmailServiceError } from "../email/email-service.js";
import type { InboundSignalMessage } from "./incoming-email-processor.js";
import type { EmailContentStore } from "../content-store.js";
import { MailparserMimeParser } from "../mime-parser.js";
import type { CalendarForwarder } from "./calendar/calendar-forwarder.js";
import { parseIcs } from "./calendar/ics-parser.js";
import type { Logger } from "../logger.js";
import type { Thread, Signal, CalendarResponseData, CalendarEventData } from "../types/index.js";
import { generateId } from "../utils/id.js";

// ---------------------------------------------------------------------------
// Narrow database surface — only what the RSVP loop touches. Kept minimal so the
// processor never grows an appetite for the wider signal pipeline.
// ---------------------------------------------------------------------------

export interface RsvpThreadStore {
  getThread(accountId: string, id: string): Promise<Result<Thread | null, DbError>>;
  saveSignal(signal: Signal<CalendarResponseData>): Promise<Result<void, DbError>>;
}

export interface IncomingCalendarRsvpProcessorDeps {
  emailContentStore: EmailContentStore;
  calendarForwarder: CalendarForwarder;
  threadStore: RsvpThreadStore;
  logger: Logger;
}

export class IncomingCalendarRsvpProcessor {
  private readonly emailContentStore: EmailContentStore;
  private readonly calendarForwarder: CalendarForwarder;
  private readonly threadStore: RsvpThreadStore;
  private readonly logger: Logger;
  private readonly mimeParser = new MailparserMimeParser();

  constructor(deps: IncomingCalendarRsvpProcessorDeps) {
    this.emailContentStore = deps.emailContentStore;
    this.calendarForwarder = deps.calendarForwarder;
    this.threadStore = deps.threadStore;
    this.logger = deps.logger;
  }

  async process(msg: InboundSignalMessage): Promise<Result<void, DbError | EmailServiceError>> {
    const recipient = msg.destination[0] ?? "";

    // --- 1. Fetch raw MIME + extract the .ics part ---
    const icsBytes = await this.extractIcsBytes(msg.s3Key);
    if (!icsBytes) {
      this.logger.warn("Calendar RSVP: no calendar attachment on message — dropping.", {
        code: "processor.calendar_response.no_ics",
        recipient,
        compositeMailMessageId: msg.compositeMailMessageId,
      });
      return ok(undefined);
    }

    // --- 2. Parse the .ics ---
    const parseResult = parseIcs(icsBytes);
    if (parseResult.isErr()) {
      this.logger.warn("Calendar RSVP: failed to parse .ics — dropping.", {
        code: "processor.calendar_response.ics_parse_failed",
        recipient,
        reason: parseResult.error.reason,
      });
      return ok(undefined);
    }

    // --- 3. Stateless validation (METHOD:REPLY + PARTSTAT + proxy-UID HMAC) ---
    const validation = await this.calendarForwarder.validateRsvp(parseResult.value.calendarData);
    if (validation.isErr()) {
      this.logger.warn("Calendar RSVP: validation rejected — dropping.", {
        code: validation.error.code,
        recipient,
        rejection: validation.error.kind,
      });
      return ok(undefined);
    }

    const { decision, accountId, threadId, originalVeventUid, organizerAddress } = validation.value;

    // --- 4. Look up the thread (identity is HMAC-authoritative from here on) ---
    const threadResult = await this.threadStore.getThread(accountId, threadId);
    if (threadResult.isErr()) return err(threadResult.error);
    if (!threadResult.value) {
      this.logger.warn("Calendar RSVP: thread not found — dropping.", {
        code: "processor.calendar_response.thread_not_found",
        accountId,
        threadId,
      });
      return ok(undefined);
    }

    // The reply address that received this RSVP is also the alias we send FROM,
    // masking the user's real mailbox back to the organizer.
    const aliasAddress = recipient;

    // --- 5. Relay the RSVP back to the organizer (send-first, record-second) ---
    const replyResult = await this.calendarForwarder.sendReply(
      {
        decision,
        originalCalendarData: {
          ...parseResult.value.calendarData,
          originalVeventUid,
          linkedSignalId: "",
        } as CalendarEventData,
        aliasAddress,
        organizerAddress,
        fromAddress: aliasAddress,
        accountId,
      },
      this.logger,
    );
    if (replyResult.isErr()) return err(replyResult.error);

    // --- 6. Record the calendar_response signal ---
    const now = DateTime.utc().toISO()!;
    const signalId = generateId("sgn-");
    const responseSignal: Signal<CalendarResponseData> = {
      id: signalId,
      signalLookupId: signalId,
      threadId,
      accountId,
      source: "user",
      type: "calendar_response",
      status: "active",
      labels: [],
      createdAt: now,
      data: {
        decision,
        respondedAt: now,
        veventUid: originalVeventUid,
        linkedSignalId: `cal-${organizerAddress}-${originalVeventUid}`,
        sendStatus: "sent",
      },
    };

    const saveResult = await this.threadStore.saveSignal(responseSignal);
    if (saveResult.isErr()) return err(saveResult.error);

    this.logger.track("Calendar RSVP processed successfully.", {
      code: "processor.calendar_response.success",
      accountId,
      threadId,
      decision,
      originalVeventUid,
    });

    return ok(undefined);
  }

  /**
   * Fetch the raw inbound MIME from S3 and return the bytes of its first
   * text/calendar (or .ics) part, or null when none is present. MIME parsing lives
   * in MailparserMimeParser (outside src/processor/) per ADR 011.
   */
  private async extractIcsBytes(s3Key: string): Promise<Uint8Array | null> {
    const rawMime = await this.emailContentStore.getRawEmail(s3Key);
    return this.mimeParser.extractCalendarAttachment(Buffer.from(rawMime));
  }
}
