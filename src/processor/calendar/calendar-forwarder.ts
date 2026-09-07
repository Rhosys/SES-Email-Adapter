// ---------------------------------------------------------------------------
// CalendarForwarder — the single owner of every outbound calendar send.
//
// Two operations, one send mechanism:
//   - forwardInvite: relays an inbound invite to the user's real calendar. Sent
//     under the PLATFORM tenant from the platform domain, behind a proxy UID and
//     proxy ORGANIZER so the user's real calendar identity is never exposed. The
//     iCalendar METHOD is passed through unchanged (REQUEST, CANCEL, COUNTER, …).
//   - sendReply: relays the user's RSVP back to the organizer. Sent under the
//     CUSTOMER tenant from the alias address, carrying the ORIGINAL event UID so
//     the organizer's calendar matches it to the event (RFC 6047). Always REPLY.
//
// Both must reach SES the same way: as a raw text/calendar MIME message. SESv2's
// Simple content cannot carry a calendar part — it always sends the body as
// text/plain and rejects a caller Content-Type header outright ("Header
// <Content-Type> is not supported"). That shared constraint is why the send lives
// in ONE private method here: the two paths differ only in identity and payload,
// never in how the bytes reach SES, so they cannot drift apart on it again.
// ---------------------------------------------------------------------------

import type { EmailService, EmailServiceError } from "../../email/email-service.js";
import type { Signal, CalendarEventData } from "../../types/index.js";
import type { DbError, Result } from "../../errors.js";
import { ok, err, dbError } from "../../errors.js";
import type { Logger } from "../../logger.js";
import { buildProxyUid } from "./proxy-uid.js";
import { buildForwardIcs, buildReplyIcs } from "./ics-builder.js";
import { buildMimeMessage } from "../../email/mime-builder.js";
import type { HmacSecretGenerator } from "./hmac-secret-generator.js";

// ---------------------------------------------------------------------------
// Options for a single forwarding invocation
// ---------------------------------------------------------------------------

export interface ForwardInviteOpts {
  calendarSignal: Signal<CalendarEventData>;
  calendarForwardingAddress: string;
  accountId: string;
  threadId: string;
  aliasAddress: string;
}

// ---------------------------------------------------------------------------
// Options for a single RSVP reply
// ---------------------------------------------------------------------------

export interface SendReplyOpts {
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

// ---------------------------------------------------------------------------
// Internal shape describing one calendar send — the identity + payload that
// differ per operation, funnelled through the single sendCalendarMessage path.
// ---------------------------------------------------------------------------

interface CalendarSend {
  from: string;
  to: string;
  subject: string;
  icsContent: string;
  method: string;
  tenant: string;
  /** Extra MIME headers (e.g. the calendar signal ID). Also mirrored as SES tags. */
  headers?: Array<{ Name: string; Value: string }>;
  /** Log `code` used when SES permanently rejects the send. */
  permanentLogCode: string;
  /** Context fields attached to the permanent-rejection warn log. */
  logContext: Record<string, unknown>;
}

export class CalendarForwarder {
  private readonly emailService: EmailService;
  private readonly serviceDomain: string;
  private readonly hmac: HmacSecretGenerator;

  constructor(deps: { emailService: EmailService; serviceDomain: string; hmac: HmacSecretGenerator }) {
    this.emailService = deps.emailService;
    this.serviceDomain = deps.serviceDomain;
    this.hmac = deps.hmac;
  }

  /**
   * Relay an inbound invite to the user's real calendar under the platform tenant.
   * No-ops when no forwarding address is configured. A permanent SES rejection is
   * swallowed (logged WARN, returns ok) so a bad invite is never retried.
   */
  async forwardInvite(opts: ForwardInviteOpts, logger: Logger): Promise<Result<void, DbError | EmailServiceError>> {
    const { calendarSignal, calendarForwardingAddress, accountId, threadId } = opts;
    const calendarData = calendarSignal.data;

    if (!calendarForwardingAddress) {
      logger.track("Calendar forwarding skipped — no calendarForwardingAddress configured.", {
        code: "processor.calendar_forwarder.no_forwarding_address",
        accountId,
        signalId: calendarSignal.id,
      });
      return ok(undefined);
    }

    const proxyUid = await buildProxyUid({
      accountId,
      threadId,
      originalVeventUid: calendarData.originalVeventUid,
      serviceDomain: this.serviceDomain,
      hmac: this.hmac,
    });

    // Proxy ORGANIZER: mailto:{threadId}@{accountId}.{serviceDomain} — masks the real organizer.
    const proxyOrganizer = `mailto:${threadId}@${accountId}.${this.serviceDomain}`;

    const icsContent = buildForwardIcs({
      calendarData,
      proxyUid,
      proxyOrganizer,
      organizerCn: calendarData.organizerCn ?? calendarData.organizer,
      attendeeAddress: calendarForwardingAddress,
    });

    const sendResult = await this.sendCalendarMessage({
      // Sent under the platform tenant from the platform domain — NOT the customer tenant.
      // Forwarded invites originate from the service, not the customer's own domain.
      from: this.emailService.platformFrom,
      to: calendarForwardingAddress,
      subject: calendarData.title,
      icsContent,
      method: calendarData.method,
      tenant: this.emailService.platformTenant,
      headers: [{ Name: "X-Numaeel-Calendar-Signal-Id", Value: calendarSignal.id }],
      permanentLogCode: "calendar_forwarder.send_permanent",
      logContext: { accountId, signalId: calendarSignal.id },
    }, logger);

    if (sendResult.isErr()) return err(sendResult.error);
    // A permanent rejection resolves to ok with an empty messageId — nothing more to do.
    if (sendResult.value.messageId) {
      logger.track("Calendar invite forwarded successfully.", {
        code: "processor.calendar_forwarder.sent",
        accountId,
        signalId: calendarSignal.id,
        method: calendarData.method,
        messageId: sendResult.value.messageId,
      });
    }
    return ok(undefined);
  }

  /**
   * Relay the user's RSVP back to the organizer under the customer tenant, from the
   * alias address, using the ORIGINAL event UID (RFC 6047 §2.3). A permanent SES
   * rejection is swallowed (logged WARN, returns ok with an empty messageId).
   */
  async sendReply(opts: SendReplyOpts, logger: Logger): Promise<Result<{ messageId: string }, DbError | EmailServiceError>> {
    const { decision, originalCalendarData, aliasAddress, organizerAddress, fromAddress, accountId } = opts;

    const icsContent = buildReplyIcs({
      veventUid: originalCalendarData.originalVeventUid,
      sequence: originalCalendarData.sequence,
      attendeeAddress: aliasAddress,
      decision: PARTSTAT_MAP[decision],
      organizerAddress,
    });

    return this.sendCalendarMessage({
      from: fromAddress,
      to: organizerAddress,
      subject: `Re: ${originalCalendarData.title}`,
      icsContent,
      method: "REPLY",
      tenant: accountId,
      permanentLogCode: "rsvp.send_permanent",
      logContext: { accountId },
    }, logger);
  }

  /**
   * The one place a calendar message reaches SES. Builds a raw text/calendar MIME
   * message (Simple content cannot carry a calendar part) and sends it via sendRaw.
   * A permanent rejection is logged WARN and resolved to ok with an empty messageId
   * so the caller never retries a malformed send; transient errors propagate.
   */
  private async sendCalendarMessage(send: CalendarSend, logger: Logger): Promise<Result<{ messageId: string }, DbError | EmailServiceError>> {
    const rawData = buildMimeMessage({
      from: send.from,
      to: send.to,
      subject: send.subject,
      textBody: send.icsContent,
      calendar: { method: send.method },
      ...(send.headers ? { headers: send.headers } : {}),
    });

    try {
      const result = await this.emailService.sendRaw({
        to: send.to,
        rawData,
        fromSender: send.from,
        accountId: send.tenant,
        // Mirror custom MIME headers as SES tags so they surface in feedback notifications.
        ...(send.headers ? { tags: send.headers } : {}),
      });

      if (result.isErr()) {
        if (result.error.kind === "permanent_ses_error") {
          logger.warn("Calendar send permanently rejected by SES — will not retry.", {
            code: send.permanentLogCode,
            ...send.logContext,
            error: result.error,
          });
          return ok({ messageId: "" });
        }
        return err(result.error);
      }

      return ok({ messageId: result.value.messageId });
    } catch (e) {
      logger.warn("Calendar send unexpected error", { code: "calendar_forwarder.unexpected_error", error: e });
      return err(dbError(e));
    }
  }
}
