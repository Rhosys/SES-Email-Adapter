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
import { buildProxyUid, validateProxyUid } from "./proxy-uid.js";
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

export interface SendRsvpToOrganizerOpts {
  decision: "accepted" | "declined" | "tentative";
  /**
   * The ORIGINAL calendar meeting invite being responded to — always the stored REQUEST, never
   * the RSVP itself. Both callers converge here: the API path loads the invite the user clicked
   * on; the relay path decodes the inbound REPLY's proxy UID and loads the same stored invite.
   * sendRsvpToOrganizer validates this invite (must be a REQUEST carrying an organizer) before
   * emitting a REPLY to that organizer.
   */
  originalCalendarMeetingInvite: CalendarEventData;
  /**
   * Whether the invite's latest collapsed state is a cancellation. Derived from the whole event
   * group (a later CANCEL, or a CANCEL since reinstated by a newer REQUEST), which a single
   * invite record cannot reveal — so the caller computes it and supplies it here. A cancelled
   * invite is accepted but never relayed upstream.
   */
  cancelled: boolean;
  /** The alias that received/represents the user — the ATTENDEE address on the outgoing REPLY. */
  aliasAddress: string;
  /** The From address of the outgoing REPLY (the alias, masking the user's real mailbox). */
  fromAddress: string;
  accountId: string;
}

const PARTSTAT_MAP = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
} as const;

const PARTSTAT_TO_DECISION: Record<string, "accepted" | "declined" | "tentative"> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
};

// ---------------------------------------------------------------------------
// Inbound RSVP validation — the stateless half of the calendar loop.
//
// Given a parsed inbound .ics, decide whether it is a genuine RSVP to an invite
// WE forwarded. Every check is pure computation over the .ics plus the HMAC
// secret — no I/O, no database. The only trust anchor is the proxy UID's HMAC:
// an attacker can address a message to the public {threadId}@{accountId}.domain
// reply address, but cannot forge a UID that validates without the secret, so
// the accountId/threadId/originalVeventUid returned here are authoritative and
// the untrusted recipient address is never consulted for identity.
// ---------------------------------------------------------------------------

/** A validated RSVP, with identity taken from the HMAC-authenticated proxy UID. */
export interface ValidatedRsvp {
  decision: "accepted" | "declined" | "tentative";
  accountId: string;
  threadId: string;
  originalVeventUid: string;
  organizerAddress: string;
}

/**
 * Why an inbound message that reached the RSVP reply address is not a processable
 * RSVP. Each variant carries the log `code` the caller emits before dropping.
 * `not_reply_method` and `no_partstat` are malformed-but-benign; `hmac_failed` is
 * the security-relevant one (forged or misrouted proxy UID).
 */
export type RsvpRejection =
  | { kind: "not_reply_method"; code: "processor.calendar_response.no_reply_method"; method: string }
  | { kind: "no_partstat"; code: "processor.calendar_response.no_partstat" }
  | { kind: "hmac_failed"; code: "processor.calendar_response.hmac_failed"; reason: string };

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
      logger.info("Calendar invite forwarded successfully.", {
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
  /**
   * Emit a METHOD:REPLY back to the organizer of an ORIGINAL calendar meeting invite. This is
   * the single mechanism both RSVP entry points converge on — the dashboard API (the user clicks
   * Accept/Decline) and the inbound-REPLY relay (the user's native calendar client replied to our
   * proxy address). Each caller maps its own incoming shape to the same original invite and passes
   * it here; this method is the sole validator of RSVP eligibility. It sends only when the invite's
   * latest state is a schedulable REQUEST that carries an organizer and is not cancelled. Anything
   * else is accepted but not relayed upstream — an expected, benign outcome, swallowed to an empty
   * messageId (the client already gates its RSVP control on the same `rsvpable` rule).
   */
  async sendRsvpToOrganizer(opts: SendRsvpToOrganizerOpts, logger: Logger): Promise<Result<{ messageId: string }, DbError | EmailServiceError>> {
    const { decision, originalCalendarMeetingInvite, cancelled, aliasAddress, fromAddress, accountId } = opts;
    const organizerAddress = originalCalendarMeetingInvite.organizer;
    const veventUid = originalCalendarMeetingInvite.originalVeventUid;

    // Cancelled: the invite's latest collapsed state is a CANCEL. Accept the RSVP, don't relay.
    if (cancelled) {
      logger.info("RSVP for a cancelled calendar invite — accepted but not relayed to the organizer.", {
        code: "rsvp.invite_cancelled", accountId, veventUid,
      });
      return ok({ messageId: "" });
    }

    // Not a schedulable REQUEST (PUBLISH informational, CANCEL, REPLY/COUNTER, …): nothing to
    // RSVP to. Expected traffic, not a failure — drop with INFO.
    if (originalCalendarMeetingInvite.method.toUpperCase() !== "REQUEST") {
      logger.info("RSVP for a non-REQUEST calendar invite — not RSVP-eligible. Dropping.", {
        code: "rsvp.not_rsvpable_method", accountId, veventUid, method: originalCalendarMeetingInvite.method,
      });
      return ok({ messageId: "" });
    }

    // A REQUEST with no organizer has nowhere to reply to. Per RFC 5546 a METHOD:REQUEST MUST
    // carry ORGANIZER, so an empty value is non-conformant (or a poisoned pre-PUBLISH record) —
    // never normal traffic, hence ERROR. Short-circuit before building the MIME or calling SES.
    if (!organizerAddress.trim()) {
      logger.error("RSVP invite has no organizer address — non-conformant (RFC 5546 requires ORGANIZER on a REQUEST). Dropping.", {
        code: "rsvp.no_organizer_address", accountId, veventUid,
      });
      return ok({ messageId: "" });
    }

    const icsContent = buildReplyIcs({
      veventUid,
      sequence: originalCalendarMeetingInvite.sequence,
      attendeeAddress: aliasAddress,
      decision: PARTSTAT_MAP[decision],
      organizerAddress,
    });

    return this.sendCalendarMessage({
      from: fromAddress,
      to: organizerAddress,
      subject: `Re: ${originalCalendarMeetingInvite.title}`,
      icsContent,
      method: "REPLY",
      tenant: accountId,
      permanentLogCode: "rsvp.send_permanent",
      logContext: { accountId },
    }, logger);
  }

  /**
   * Validate an inbound .ics as an RSVP to an invite we forwarded. Stateless: no
   * I/O. On success returns the decision plus the identity decoded from the
   * HMAC-authenticated proxy UID (the .ics VEVENT UID is the proxy UID we stamped
   * on the forwarded invite). Any rejection is returned typed, with its log code,
   * for the caller to log-and-drop — nothing here writes or sends.
   */
  async validateRsvp(calendarData: CalendarEventData): Promise<Result<ValidatedRsvp, RsvpRejection>> {
    // Must be a REPLY. REQUEST/CANCEL/PUBLISH at this address are not RSVPs.
    if (calendarData.method.toUpperCase() !== "REPLY") {
      return err({ kind: "not_reply_method", code: "processor.calendar_response.no_reply_method", method: calendarData.method });
    }

    // Decision from the first attendee bearing a recognised PARTSTAT.
    let decision: "accepted" | "declined" | "tentative" | undefined;
    for (const attendee of calendarData.attendees) {
      if (attendee.partstat) {
        const mapped = PARTSTAT_TO_DECISION[attendee.partstat.toUpperCase()];
        if (mapped) { decision = mapped; break; }
      }
    }
    if (!decision) {
      return err({ kind: "no_partstat", code: "processor.calendar_response.no_partstat" });
    }

    // The proxy UID (the VEVENT UID) is the only trust anchor. Its HMAC binds
    // accountId + threadId + originalVeventUid; a valid one is authoritative.
    const uidResult = await validateProxyUid({
      proxyUid: calendarData.veventUid,
      serviceDomain: this.serviceDomain,
      hmac: this.hmac,
    });
    if (uidResult.isErr()) {
      return err({ kind: "hmac_failed", code: "processor.calendar_response.hmac_failed", reason: uidResult.error });
    }

    const { accountId, threadId, originalVeventUid } = uidResult.value;
    return ok({ decision, accountId, threadId, originalVeventUid, organizerAddress: calendarData.organizer });
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
        to: [send.to],
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
