// ---------------------------------------------------------------------------
// Calendar_Forwarder — constructs a proxy .ics and sends it to the user's
// real calendar address via SES. Triggered as a side-effect by the
// forwardCalendarInvite rule action.
// ---------------------------------------------------------------------------

import type { EmailService } from "../../email/email-service.js";
import type { Signal, CalendarEventData } from "../../types/index.js";
import type { DbError, TransientSesError, Result } from "../../errors.js";
import { ok, err, dbError } from "../../errors.js";
import type { Logger } from "../../logger.js";
import { buildProxyUid } from "./proxy-uid.js";
import { buildForwardIcs } from "./ics-builder.js";

// ---------------------------------------------------------------------------
// Dependencies (injected at cold start)
// ---------------------------------------------------------------------------

export interface CalendarForwarderDeps {
  emailService: EmailService;
  serviceDomain: string;
}

// ---------------------------------------------------------------------------
// Options for a single forwarding invocation
// ---------------------------------------------------------------------------

export interface ForwardCalendarInviteOpts {
  calendarSignal: Signal<CalendarEventData>;
  calendarForwardingAddress: string;
  accountId: string;
  arcId: string;
  aliasAddress: string;
}

// ---------------------------------------------------------------------------
// forwardCalendarInvite — the side-effect handler
// ---------------------------------------------------------------------------

export async function forwardCalendarInvite(
  opts: ForwardCalendarInviteOpts,
  deps: CalendarForwarderDeps,
  logger: Logger,
): Promise<Result<void, DbError | TransientSesError>> {
  const { calendarSignal, calendarForwardingAddress, accountId, arcId } = opts;
  const { emailService, serviceDomain } = deps;
  const calendarData = calendarSignal.data;

  // No-op if calendarForwardingAddress is empty
  if (!calendarForwardingAddress) {
    logger.track("Calendar forwarding skipped — no calendarForwardingAddress configured.", {
      code: "processor.calendar_forwarder.no_forwarding_address",
      accountId,
      signalId: calendarSignal.id,
    });
    return ok(undefined);
  }

  // Build proxy UID
  const proxyUid = await buildProxyUid({
    accountId,
    arcId,
    originalVeventUid: calendarData.originalVeventUid,
    serviceDomain,
  });

  // Build proxy ORGANIZER: mailto:{arcId}@{accountId}.{serviceDomain}
  const proxyOrganizer = `mailto:${arcId}@${accountId}.${serviceDomain}`;

  // Construct the forwarding .ics
  const icsContent = buildForwardIcs({
    calendarData,
    proxyUid,
    proxyOrganizer,
    organizerCn: calendarData.organizerCn ?? calendarData.organizer,
    attendeeAddress: calendarForwardingAddress,
  });

  // Send via SES with the calendar signal ID header
  try {
    const result = await emailService.send({
      to: calendarForwardingAddress,
      subject: calendarData.title,
      textBody: icsContent,
      accountId,
      headers: [
        { Name: "X-Numaeel-Calendar-Signal-Id", Value: calendarSignal.id },
        { Name: "Content-Type", Value: "text/calendar; method=" + calendarData.method },
      ],
    });

    if (result.isErr()) {
      return err(result.error);
    }

    logger.track("Calendar invite forwarded successfully.", {
      code: "processor.calendar_forwarder.sent",
      accountId,
      signalId: calendarSignal.id,
      method: calendarData.method,
      messageId: result.value.messageId,
    });

    return ok(undefined);
  } catch (e) {
    return err(dbError(e));
  }
}
