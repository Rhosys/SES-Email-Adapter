// ---------------------------------------------------------------------------
// RSVP Composer — composes METHOD:REPLY and sends from alias to organizer
// ---------------------------------------------------------------------------

import { buildReplyIcs } from "./ics-builder.js";
import { ok, err } from "../../errors.js";
import type { Result } from "../../errors.js";
import type { EmailService, EmailServiceError } from "../../email/email-service.js";
import type { CalendarEventData } from "../../types/calendar.js";
import type { Logger } from "../../logger.js";

export interface RsvpComposeOpts {
  decision: "accepted" | "declined" | "tentative";
  originalCalendarData: CalendarEventData;
  aliasAddress: string;
  organizerAddress: string;
  fromAddress: string;
  accountId: string;
}

const PARTSTAT_MAP = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
} as const;

/**
 * Compose a METHOD:REPLY .ics and send it from the alias address to the
 * organizer address per RFC 6047 §2.3.
 *
 * - ATTENDEE in REPLY = aliasAddress with correct PARTSTAT
 * - VEVENT_UID = original UID (not proxy)
 * - SEQUENCE = copied from originalCalendarData
 * - Sent TO: organizerAddress (ORGANIZER mailto: from original .ics)
 * - Sent FROM: aliasAddress
 */
export async function sendRsvp(
  opts: RsvpComposeOpts,
  deps: { emailService: EmailService; logger: Logger },
): Promise<Result<{ messageId: string }, EmailServiceError>> {
  const { decision, originalCalendarData, aliasAddress, organizerAddress, fromAddress } = opts;

  const icsContent = buildReplyIcs({
    veventUid: originalCalendarData.originalVeventUid,
    sequence: originalCalendarData.sequence,
    attendeeAddress: aliasAddress,
    decision: PARTSTAT_MAP[decision],
    organizerAddress,
  });

  const result = await deps.emailService.send({
    to: organizerAddress,
    subject: `Re: ${originalCalendarData.title}`,
    textBody: icsContent,
    fromOverride: fromAddress,
    accountId: opts.accountId,
    headers: [
      { Name: "Content-Type", Value: "text/calendar; method=REPLY; charset=UTF-8" },
    ],
  });

  if (result.isErr()) {
    if (result.error.kind === "permanent_ses_error") {
      deps.logger.warn("RSVP send permanently rejected by SES — will not retry.", { code: "rsvp.send_permanent", accountId: opts.accountId, error: result.error });
      return ok({ messageId: "" });
    }
    return err(result.error);
  }

  return ok({ messageId: result.value.messageId });
}
