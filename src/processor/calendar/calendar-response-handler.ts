// ---------------------------------------------------------------------------
// Calendar Response Handler — routes inbound native calendar REPLY messages
// from the user's calendar app back to the original organizer.
//
// Inbound emails at {arcId}@{accountId}.{serviceDomain} are validated via
// stateless checksum + HMAC before any database I/O occurs.
// ---------------------------------------------------------------------------

import { DateTime } from "luxon";
import { ok, err } from "../../errors.js";
import type { DbError, Result } from "../../errors.js";
import type { InboundSignalMessage } from "../processor.js";
import type { ArcDatabase } from "../../database/arc-database.js";
import type { Logger } from "../../logger.js";
import type { Signal, CalendarEventData, CalendarResponseData } from "../../types/index.js";
import type { EmailService } from "../../email/email-service.js";
import { validateProxyUid } from "./proxy-uid.js";
import { parseIcs } from "./ics-parser.js";
import type { sendRsvp } from "./rsvp-composer.js";
import { validateId } from "../../utils/id.js";

// ---------------------------------------------------------------------------
// Dependencies (injected at cold start)
// ---------------------------------------------------------------------------

export interface CalendarResponseHandlerDeps {
  hmacSecret: Uint8Array;
  serviceDomain: string;
  arcDatabase: ArcDatabase;
  rsvpComposer: typeof sendRsvp;
  signalStore: { saveSignal(signal: Signal<CalendarResponseData>): Promise<Result<void, DbError>> };
  emailService: EmailService;
}

// ---------------------------------------------------------------------------
// PARTSTAT extraction from iCal REPLY
// ---------------------------------------------------------------------------

const PARTSTAT_TO_DECISION: Record<string, "accepted" | "declined" | "tentative"> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
};

/**
 * Extract the ATTENDEE PARTSTAT from parsed CalendarData.
 * For a REPLY, the first attendee's PARTSTAT indicates the decision.
 */
function extractDecision(calendarData: { attendees: Array<{ partstat?: string }> }): "accepted" | "declined" | "tentative" | null {
  for (const attendee of calendarData.attendees) {
    if (attendee.partstat) {
      const decision = PARTSTAT_TO_DECISION[attendee.partstat.toUpperCase()];
      if (decision) return decision;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// handleCalendarResponse — the main entry point
// ---------------------------------------------------------------------------

/**
 * Process an inbound calendar REPLY routed to {arcId}@{accountId}.{serviceDomain}.
 *
 * Validation sequence (all pure computation, no I/O until both pass):
 * 1. Extract arcId and accountId from recipient address
 * 2. Validate accountId checksum
 * 3. Validate arcId checksum
 * 4. Parse .ics attachment, extract proxy UID
 * 5. Validate proxy UID HMAC via validateProxyUid
 * 6. On failure: silent drop + WARN log
 * 7. On success: look up arc, trigger RSVP_Composer, create calendar_response signal
 */
export async function handleCalendarResponse(
  message: InboundSignalMessage,
  deps: CalendarResponseHandlerDeps,
  logger: Logger,
  icsBytes: Uint8Array,
): Promise<Result<void, DbError>> {
  const { hmacSecret, serviceDomain, arcDatabase, rsvpComposer, signalStore, emailService } = deps;

  // --- Step 1: Extract arcId and accountId from recipient address ---
  // Pattern: {arcId}@{accountId}.{serviceDomain}
  const recipient = message.destination[0];
  if (!recipient) {
    logger.warn("Calendar response handler: no recipient address.", {
      code: "processor.calendar_response.no_recipient",
    });
    return ok(undefined);
  }

  const atIndex = recipient.indexOf("@");
  if (atIndex === -1) {
    logger.warn("Calendar response handler: invalid recipient format.", {
      code: "processor.calendar_response.invalid_format",
      recipient,
    });
    return ok(undefined);
  }

  const arcId = recipient.slice(0, atIndex);
  const domainPart = recipient.slice(atIndex + 1);

  // Domain should be {accountId}.{serviceDomain}
  const serviceDomainSuffix = `.${serviceDomain}`;
  if (!domainPart.endsWith(serviceDomainSuffix)) {
    logger.warn("Calendar response handler: domain does not match service domain.", {
      code: "processor.calendar_response.domain_mismatch",
      recipient,
      validationType: "domain_mismatch",
    });
    return ok(undefined);
  }

  const accountId = domainPart.slice(0, domainPart.length - serviceDomainSuffix.length);
  if (!accountId) {
    logger.warn("Calendar response handler: empty accountId.", {
      code: "processor.calendar_response.empty_account_id",
      recipient,
      validationType: "empty_account_id",
    });
    return ok(undefined);
  }

  // --- Step 2: Validate accountId checksum ---
  if (!validateId(accountId, "acc-")) {
    logger.warn("Calendar response handler: accountId checksum failed.", {
      code: "processor.calendar_response.checksum_failed",
      recipient,
      validationType: "accountId_checksum",
    });
    return ok(undefined);
  }

  // --- Step 3: Validate arcId checksum ---
  if (!validateId(arcId, "arc-")) {
    logger.warn("Calendar response handler: arcId checksum failed.", {
      code: "processor.calendar_response.checksum_failed",
      recipient,
      validationType: "arcId_checksum",
    });
    return ok(undefined);
  }

  // --- Step 4: Parse .ics attachment, extract proxy UID ---
  const parseResult = parseIcs(icsBytes);
  if (parseResult.isErr()) {
    logger.warn("Calendar response handler: failed to parse .ics attachment.", {
      code: "processor.calendar_response.ics_parse_failed",
      recipient,
      validationType: "ics_parse",
      reason: parseResult.error.reason,
    });
    return ok(undefined);
  }

  const { calendarData } = parseResult.value;

  // Verify METHOD:REPLY
  if (calendarData.method.toUpperCase() !== "REPLY") {
    logger.warn("Calendar response handler: .ics does not contain METHOD:REPLY.", {
      code: "processor.calendar_response.no_reply_method",
      recipient,
      validationType: "no_valid_reply_ics",
      method: calendarData.method,
    });
    return ok(undefined);
  }

  // The proxy UID is the veventUid in the parsed .ics (user's calendar uses proxy UID)
  const proxyUid = calendarData.veventUid;

  // --- Step 5: Validate proxy UID HMAC ---
  const uidResult = validateProxyUid({
    proxyUid,
    hmacSecret,
    serviceDomain,
  });

  if (uidResult.isErr()) {
    logger.warn("Calendar response handler: proxy UID HMAC validation failed.", {
      code: "processor.calendar_response.hmac_failed",
      recipient,
      validationType: "hmac_failed",
      reason: uidResult.error,
    });
    return ok(undefined);
  }

  // --- All stateless validation passed — proceed with I/O ---

  const { originalVeventUid } = uidResult.value;

  // Extract RSVP decision from ATTENDEE PARTSTAT
  const decision = extractDecision(calendarData);
  if (!decision) {
    logger.warn("Calendar response handler: no valid PARTSTAT in REPLY.", {
      code: "processor.calendar_response.no_partstat",
      recipient,
      validationType: "no_partstat",
    });
    return ok(undefined);
  }

  // --- Step 6: Look up the arc ---
  const arcResult = await arcDatabase.getArc(accountId, arcId);
  if (arcResult.isErr()) return err(arcResult.error);

  const arc = arcResult.value;
  if (!arc) {
    logger.warn("Calendar response handler: arc not found.", {
      code: "processor.calendar_response.arc_not_found",
      accountId,
      arcId,
    });
    return ok(undefined);
  }

  // The alias address is the proxy ORGANIZER address that received this REPLY.
  // For the masked REPLY back to the organizer, we send FROM this address.
  const aliasAddress = recipient;
  const organizerAddress = calendarData.organizer;

  // --- Step 7: Trigger RSVP_Composer (send-first, record-second) ---
  const rsvpResult = await rsvpComposer(
    {
      decision,
      originalCalendarData: {
        ...calendarData,
        originalVeventUid,
        linkedSignalId: "",
      } as CalendarEventData,
      aliasAddress,
      organizerAddress,
      fromAddress: aliasAddress,
    },
    { emailService },
  );

  if (rsvpResult.isErr()) return err(rsvpResult.error);

  // --- Step 8: Create calendar_response signal ---
  const now = DateTime.utc().toISO()!;
  const signalId = `sgn-cal-resp-${Date.now()}`;

  const responseSignal: Signal<CalendarResponseData> = {
    id: signalId,
    signalLookupId: signalId,
    arcId,
    accountId,
    source: "user",
    type: "calendar_response",
    status: "active",
    createdAt: now,
    data: {
      decision,
      respondedAt: now,
      veventUid: originalVeventUid,
      linkedSignalId: `cal-${organizerAddress}-${originalVeventUid}`,
      sendStatus: "sent",
    },
  };

  const saveResult = await signalStore.saveSignal(responseSignal);
  if (saveResult.isErr()) return err(saveResult.error);

  logger.track("Calendar REPLY processed successfully.", {
    code: "processor.calendar_response.success",
    accountId,
    arcId,
    decision,
    originalVeventUid,
  });

  return ok(undefined);
}
