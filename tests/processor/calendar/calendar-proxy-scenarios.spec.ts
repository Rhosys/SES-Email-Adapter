import type { IForwardingService } from "../../../src/forwarding/forwarding-service.js";
// ---------------------------------------------------------------------------
// Calendar Proxy Scenario Tests
//
// Named end-to-end scenario tests for each calendar proxy flow.
// Each test uses static, deterministic inputs with explicit expected outputs.
// Each test includes a comment explaining WHY the expected behavior must never change.
//
// Validates: Requirements 20.1, 20.2, 20.3
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CalendarForwarder } from "../../../src/processor/calendar/calendar-forwarder.js";
import type { ForwardInviteOpts } from "../../../src/processor/calendar/calendar-forwarder.js";
import { IncomingCalendarRsvpProcessor } from "../../../src/processor/incoming-calendar-rsvp-processor.js";
import type { RsvpThreadStore } from "../../../src/processor/incoming-calendar-rsvp-processor.js";
import { handlePostApprovalCalendar } from "../../../src/processor/calendar/post-approval-handler.js";
import type { PostApprovalCalendarHandlerDeps } from "../../../src/processor/calendar/post-approval-handler.js";
import { buildProxyUid as buildProxyUidRaw } from "../../../src/processor/calendar/proxy-uid.js";
import { buildCalendarSignalLookupId } from "../../../src/processor/calendar/signal-lookup.js";
import type { CalendarEventData, CalendarResponseData } from "../../../src/types/calendar.js";
import type { Signal, Thread, Attachment } from "../../../src/types/index.js";
import type { InboundSignalMessage } from "../../../src/processor/incoming-email-processor.js";
import type { EmailContentStore } from "../../../src/content-store.js";
import type { EmailService } from "../../../src/email/email-service.js";
import { ok } from "../../../src/errors.js";
import { generateId, generateAccountId } from "../../../src/utils/id.js";
import { createMockLogger } from "../../helpers/mock-logger.js";
import ICAL from "ical.js";

// ---------------------------------------------------------------------------
// Injected deterministic HMAC generator — no real KMS. `buildProxyUid` is
// wrapped so existing call sites (which omit hmac) inject the same generator
// the code-under-test receives via its deps.
// ---------------------------------------------------------------------------

import { makeHmacGeneratorFake } from "../../helpers/hmac-generator-fake.js";

const hmac = makeHmacGeneratorFake();

const buildProxyUid = (opts: Omit<Parameters<typeof buildProxyUidRaw>[0], "hmac">) =>
  buildProxyUidRaw({ ...opts, hmac });

// ---------------------------------------------------------------------------
// Static test fixtures — deterministic, no random generation
// ---------------------------------------------------------------------------

const SERVICE_DOMAIN = "platform.email.rhosys.cloud";
const VALID_ARC_ID = generateId("thr-");
const VALID_ACC_ID = generateAccountId();
const FORWARDING_ADDRESS = "user-real-calendar@gmail.com";
const ALIAS_ADDRESS = "contact@alias.example.com";
const ORGANIZER_EMAIL = "alice@company.com";
const ORGANIZER_CN = "Alice Smith";
const VEVENT_UID = "uid-meeting-2025-03-15";

const PLATFORM_TENANT = "platform-tenant";
const PLATFORM_FROM = "invites@platform.email.rhosys.cloud";

function makeEmailService(): EmailService {
  return {
    send: vi.fn(),
    sendRaw: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001" })),
    platformTenant: PLATFORM_TENANT,
    platformFrom: PLATFORM_FROM,
  } as unknown as EmailService;
}

/** Decode the .ics body from a sendRaw call's raw MIME message. */
function rawIcsOf(emailService: EmailService): string {
  const rawData: Uint8Array = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0].rawData;
  const message = Buffer.from(rawData).toString("utf8");
  const body = message.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
  return Buffer.from(body, "base64").toString("utf8");
}

function makeCalendarSignal(overrides: Partial<CalendarEventData> = {}): Signal<CalendarEventData> {
  return {
    id: "sgn-cal-001",
    signalLookupId: buildCalendarSignalLookupId(ORGANIZER_EMAIL, VEVENT_UID),
    accountId: VALID_ACC_ID,
    threadId: VALID_ARC_ID,
    source: "signal",
    type: "calendar_event",
    status: "active",
    createdAt: "2025-03-15T09:00:00Z",
    data: {
      title: "Quarterly Planning",
      description: "Q2 planning session",
      startTime: "2025-03-15T14:00:00Z",
      endTime: "2025-03-15T15:00:00Z",
      location: "Room 4B",
      organizer: ORGANIZER_EMAIL,
      organizerCn: ORGANIZER_CN,
      attendees: [{ address: "bob@company.com", partstat: "NEEDS-ACTION" }],
      veventUid: VEVENT_UID,
      originalVeventUid: VEVENT_UID,
      method: "REQUEST",
      sequence: 1,
      status: "CONFIRMED",
      linkedSignalId: "sgn-email-001",
      ...overrides,
    },
  } as Signal<CalendarEventData>;
}

function makeForwarder(emailService?: EmailService): CalendarForwarder {
  return new CalendarForwarder({
    emailService: emailService ?? makeEmailService(),
    serviceDomain: SERVICE_DOMAIN,
    hmac,
  });
}

function makeForwarderOpts(overrides: Partial<ForwardInviteOpts> = {}): ForwardInviteOpts {
  return {
    calendarSignal: makeCalendarSignal(),
    calendarForwardingAddress: FORWARDING_ADDRESS,
    accountId: VALID_ACC_ID,
    threadId: VALID_ARC_ID,
    aliasAddress: ALIAS_ADDRESS,
    ...overrides,
  };
}

function buildReplyIcsString(proxyUid: string, partstat = "ACCEPTED"): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//Test//EN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${proxyUid}`,
    "SEQUENCE:1",
    "DTSTART:20250315T140000Z",
    "DTEND:20250315T150000Z",
    "SUMMARY:Quarterly Planning",
    `ORGANIZER;CN=${ORGANIZER_CN}:mailto:${ORGANIZER_EMAIL}`,
    `ATTENDEE;PARTSTAT=${partstat}:mailto:${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/** Wrap a REPLY .ics in a real multipart/mixed email so simpleParser sees it as an attachment. */
function rawRsvpEmailFrom(icsContent: string): Uint8Array {
  const boundary = "mixed_boundary_scn";
  const message = [
    `From: ${ORGANIZER_EMAIL}`,
    `To: ${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`,
    "Subject: Re: Quarterly Planning",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "RSVP",
    "",
    `--${boundary}`,
    'Content-Type: text/calendar; method=REPLY; charset=UTF-8; name="invite.ics"',
    "Content-Transfer-Encoding: 7bit",
    'Content-Disposition: attachment; filename="invite.ics"',
    "",
    icsContent,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return new Uint8Array(Buffer.from(message, "utf8"));
}

function makeRsvpThreadStore(): RsvpThreadStore {
  return {
    getThread: vi.fn().mockResolvedValue(ok({
      id: VALID_ARC_ID,
      accountId: VALID_ACC_ID,
      status: "active",
      labels: ["system:calendar"],
      summary: "Quarterly Planning",
      workflow: "job",
      lastSignalAt: "2025-03-15T09:00:00Z",
      createdAt: "2025-03-15T09:00:00Z",
    })),
    saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

/** Build the RSVP processor over a real CalendarForwarder, driven by the raw email bytes. */
function makeRsvpHarness(icsContent: string, threadStore: RsvpThreadStore = makeRsvpThreadStore()) {
  const logger = createMockLogger();
  const emailService = makeEmailService();
  const calendarForwarder = new CalendarForwarder({ emailService, serviceDomain: SERVICE_DOMAIN, hmac });
  const processor = new IncomingCalendarRsvpProcessor({
    emailContentStore: { getRawEmail: vi.fn().mockResolvedValue(rawRsvpEmailFrom(icsContent)) } as unknown as EmailContentStore,
    calendarForwarder,
    threadStore,
    logger,
  });
  return { processor, logger, threadStore, emailService };
}

function makeRsvpMessage(): InboundSignalMessage {
  return {
    s3Key: "emails/native-reply.eml",
    compositeMailMessageId: "ses-native-001",
    idempotencyKey: "idem-001",
    timestamp: "2025-03-15T15:30:00Z",
    destination: [`${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`],
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
  };
}

// ===========================================================================
// Scenario 1: Inbound REQUEST from approved sender → calendar signal created
//             → .ics constructed and forwarded to calendarForwardingAddress
// ===========================================================================

describe("Scenario: calendar invite from approved sender is forwarded to user's real calendar", () => {
  // WHY: The proxy must deliver all valid invites to the user's real calendar.
  // If forwarding breaks, the user never sees calendar events — the core value
  // proposition of the calendar proxy is lost.

  it("constructs a proxy .ics with proxy UID and sends to calendarForwardingAddress", async () => {
    const emailService = makeEmailService();
    const forwarder = makeForwarder(emailService);
    const opts = makeForwarderOpts();
    const logger = createMockLogger();

    const result = await forwarder.forwardInvite(opts, logger);

    // Forwarding succeeds
    expect(result.isOk()).toBe(true);

    // Email was sent to the user's real calendar address
    const sendCall = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendCall.to).toEqual([FORWARDING_ADDRESS]);

    // The .ics body contains a proxy UID (not the original)
    const icsBody: string = rawIcsOf(emailService);
    expect(icsBody).not.toContain(`UID:${VEVENT_UID}`);
    expect(icsBody).toContain(`@${SERVICE_DOMAIN}`);

    // The .ics preserves METHOD:REQUEST
    const parsed = ICAL.parse(icsBody);
    const comp = new ICAL.Component(parsed);
    expect(comp.getFirstPropertyValue("method")).toBe("REQUEST");

    // The ATTENDEE is the user's real calendar address
    const vevent = comp.getFirstSubcomponent("vevent")!;
    const attendee = vevent.getFirstProperty("attendee")!;
    expect(attendee.getFirstValue()).toBe(`mailto:${FORWARDING_ADDRESS}`);
  });
});

// ===========================================================================
// Scenario 2: Inbound CANCEL for existing event → calendar signal created
//             → constructed CANCEL forwarded to calendarForwardingAddress
// ===========================================================================

describe("Scenario: cancellation is forwarded so user's calendar removes the event", () => {
  // WHY: If CANCEL is not forwarded, the user's calendar shows a stale event
  // that no longer exists. Calendar sync requires all lifecycle methods forwarded.

  it("forwards METHOD:CANCEL with same proxy UID structure as the original REQUEST", async () => {
    const emailService = makeEmailService();
    const forwarder = makeForwarder(emailService);
    const cancelSignal = makeCalendarSignal({ method: "CANCEL", status: "CANCELLED" });
    const opts = makeForwarderOpts({ calendarSignal: cancelSignal });
    const logger = createMockLogger();

    const result = await forwarder.forwardInvite(opts, logger);

    expect(result.isOk()).toBe(true);

    const icsBody: string = rawIcsOf(emailService);

    // Verify METHOD:CANCEL is preserved
    const parsed = ICAL.parse(icsBody);
    const comp = new ICAL.Component(parsed);
    expect(comp.getFirstPropertyValue("method")).toBe("CANCEL");

    // Verify the proxy UID is deterministic (same inputs → same UID as REQUEST)
    const vevent = comp.getFirstSubcomponent("vevent")!;
    const uid = vevent.getFirstPropertyValue("uid") as string;
    const expectedProxyUid = await buildProxyUid({
      accountId: VALID_ACC_ID,
      threadId: VALID_ARC_ID,
      originalVeventUid: VEVENT_UID,
      serviceDomain: SERVICE_DOMAIN,
    });
    expect(uid).toBe(expectedProxyUid);
  });
});

// ===========================================================================
// Scenario 3: Inbound RESCHEDULE (higher SEQUENCE) → calendar signal created
//             → constructed update forwarded to calendarForwardingAddress
// ===========================================================================

describe("Scenario: reschedule with higher SEQUENCE is forwarded so calendar updates the event", () => {
  // WHY: Calendar apps use SEQUENCE to determine which version of an event is
  // current. If a higher-SEQUENCE update is not forwarded, the user's calendar
  // shows outdated time/location. The proxy must forward all updates.

  it("forwards REQUEST with SEQUENCE:3 preserving the updated time and sequence", async () => {
    const emailService = makeEmailService();
    const forwarder = makeForwarder(emailService);
    const rescheduleSignal = makeCalendarSignal({
      method: "REQUEST",
      sequence: 3,
      startTime: "2025-03-16T14:00:00Z",
      endTime: "2025-03-16T15:00:00Z",
    });
    const opts = makeForwarderOpts({ calendarSignal: rescheduleSignal });
    const logger = createMockLogger();

    const result = await forwarder.forwardInvite(opts, logger);

    expect(result.isOk()).toBe(true);

    const icsBody: string = rawIcsOf(emailService);

    const parsed = ICAL.parse(icsBody);
    const comp = new ICAL.Component(parsed);
    const vevent = comp.getFirstSubcomponent("vevent")!;

    // SEQUENCE is preserved at the higher value
    expect(vevent.getFirstPropertyValue("sequence")).toBe(3);

    // Updated DTSTART is reflected
    const dtstart = vevent.getFirstPropertyValue("dtstart") as ICAL.Time;
    expect(dtstart.toICALString()).toBe("20250316T140000Z");
  });
});

// ===========================================================================
// Scenario 4: User RSVP via UI → calendar_response signal created
//             → masked REPLY sent to original organizer with original UID
// ===========================================================================

describe("Scenario: UI RSVP sends masked reply to organizer preserving user privacy", () => {
  // WHY: The organizer must receive the user's accept/decline decision so the
  // event is updated on their end. The REPLY must use the ORIGINAL UID (not proxy)
  // so the organizer's calendar matches it to the correct event. The reply must
  // come FROM the alias address to preserve the user's real email privacy.

  it("sends METHOD:REPLY with original UID and correct PARTSTAT to organizer", async () => {
    const emailService = makeEmailService();
    const forwarder = makeForwarder(emailService);
    const calendarData = makeCalendarSignal().data;

    const result = await forwarder.sendReply(
      {
        decision: "accepted",
        originalCalendarData: calendarData,
        aliasAddress: ALIAS_ADDRESS,
        organizerAddress: ORGANIZER_EMAIL,
        fromAddress: ALIAS_ADDRESS,
        accountId: "acct-test",
      },
      createMockLogger(),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().messageId).toBe("ses-msg-001");

    const sendCall = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];

    // Sent TO the organizer (RFC 6047)
    expect(sendCall.to).toEqual([ORGANIZER_EMAIL]);

    // Sent FROM the alias (privacy preserved)
    expect(sendCall.fromSender).toBe(ALIAS_ADDRESS);

    // Parse the .ics to verify structure
    const icsBody: string = rawIcsOf(emailService);
    const parsed = ICAL.parse(icsBody);
    const comp = new ICAL.Component(parsed);

    // METHOD:REPLY
    expect(comp.getFirstPropertyValue("method")).toBe("REPLY");

    // Uses ORIGINAL UID, not proxy
    const vevent = comp.getFirstSubcomponent("vevent")!;
    expect(vevent.getFirstPropertyValue("uid")).toBe(VEVENT_UID);

    // ATTENDEE has correct PARTSTAT
    const attendee = vevent.getFirstProperty("attendee")!;
    expect(attendee.getParameter("partstat")).toBe("ACCEPTED");
    expect(attendee.getFirstValue()).toBe(`mailto:${ALIAS_ADDRESS}`);
  });
});

// ===========================================================================
// Scenario 5: User's calendar app sends native REPLY → inbound at proxy
//             ORGANIZER address → HMAC validated → calendar_response signal
//             created → masked REPLY sent to original organizer
// ===========================================================================

describe("Scenario: native calendar REPLY is validated and forwarded to organizer", () => {
  // WHY: Users who RSVP from their native calendar app (Google Calendar, Apple
  // Calendar) send a METHOD:REPLY to the proxy ORGANIZER address. The system must
  // validate the HMAC to prevent spoofing, then forward the decision to the real
  // organizer. Without this flow, native calendar RSVPs are silently lost.

  it("valid native REPLY creates calendar_response signal and sends masked REPLY", async () => {
    const proxyUid = await buildProxyUid({
      accountId: VALID_ACC_ID,
      threadId: VALID_ARC_ID,
      originalVeventUid: VEVENT_UID,
      serviceDomain: SERVICE_DOMAIN,
    });

    const { processor, threadStore, emailService } = makeRsvpHarness(buildReplyIcsString(proxyUid, "ACCEPTED"));

    const result = await processor.process(makeRsvpMessage());

    expect(result.isOk()).toBe(true);

    // Reply relayed to the organizer with the accepted decision.
    const sendCall = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendCall.to).toEqual([ORGANIZER_EMAIL]);

    // calendar_response signal was saved with the original UID and decision.
    const savedSignal = (threadStore.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedSignal.type).toBe("calendar_response");
    expect(savedSignal.data.decision).toBe("accepted");
    expect(savedSignal.data.veventUid).toBe(VEVENT_UID);
  });
});

// ===========================================================================
// Scenario 6: Inbound REPLY with invalid HMAC → silently dropped, no signal
// ===========================================================================

describe("Scenario: invalid HMAC REPLY is silently dropped to prevent spoofing", () => {
  // WHY: An attacker who guesses the proxy ORGANIZER address format could send
  // forged RSVPs. The HMAC suffix on the proxy UID is the cryptographic gate —
  // if it doesn't validate, the system must perform ZERO I/O (no DB lookup, no
  // signal creation, no response) to prevent information leakage and resource abuse.

  it("does not create signal or call DB when HMAC is invalid", async () => {
    // A proxy UID with a forged HMAC suffix (attacker who knows the format, not the secret).
    const tamperedProxyUid = `${VALID_ACC_ID}.${VALID_ARC_ID}.${VEVENT_UID}.AAAAAAAAAAAAAAAA@${SERVICE_DOMAIN}`;
    const { processor, logger, threadStore, emailService } = makeRsvpHarness(buildReplyIcsString(tamperedProxyUid, "ACCEPTED"));

    const result = await processor.process(makeRsvpMessage());

    expect(result.isOk()).toBe(true);
    expect(threadStore.getThread).not.toHaveBeenCalled();
    expect(threadStore.saveSignal).not.toHaveBeenCalled();
    expect(emailService.sendRaw).not.toHaveBeenCalled();
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "processor.calendar_response.hmac_failed")).toBe(true);
  });
});

// ===========================================================================
// Scenario 7: Inbound to a bad-checksum account subdomain → not routed as RSVP
// ===========================================================================

describe("Scenario: invalid accountId checksum is not routed to the RSVP processor", () => {
  // WHY: The address checksum is the router's cheap self-consistency gate (it runs
  // in the SES handler before any processor is chosen). A recipient whose accountId
  // fails its checksum is not a well-formed RSVP address, so it must not be routed
  // to the RSVP processor at all — it falls through to the email path, which drops
  // it as belonging to no alias. The cryptographic gate is the HMAC, checked later.

  it("isRsvpReplyAddress rejects a recipient whose accountId checksum fails", async () => {
    const { isRsvpReplyAddress } = await import("../../../src/processor/inbound-router.js");

    const badAccountId = "acc-xxxxxxxxxx000";
    expect(isRsvpReplyAddress(`${VALID_ARC_ID}@${badAccountId}.${SERVICE_DOMAIN}`, SERVICE_DOMAIN)).toBe(false);

    // A well-formed RSVP address is routed.
    expect(isRsvpReplyAddress(`${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`, SERVICE_DOMAIN)).toBe(true);
  });
});

// ===========================================================================
// Scenario 8: Quarantined email with .ics approved → calendar signal created
//             → forwarded to calendarForwardingAddress
// ===========================================================================

describe("Scenario: approving quarantined email triggers calendar forwarding", () => {
  // WHY: When a user approves a quarantined sender, pending calendar invites must
  // be delivered retroactively. Without post-approval forwarding, the user would
  // need to manually find and add the event — defeating the purpose of the proxy.

  it("creates calendar signal and forwards .ics when quarantined signal is approved", async () => {
    const VALID_ICS = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//Test//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      `UID:${VEVENT_UID}`,
      "DTSTART:20250315T140000Z",
      "DTEND:20250315T150000Z",
      "SUMMARY:Quarterly Planning",
      `ORGANIZER;CN=${ORGANIZER_CN}:mailto:${ORGANIZER_EMAIL}`,
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@company.com",
      "SEQUENCE:1",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const threadDb = {
      saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
      updateThread: vi.fn().mockResolvedValue(ok(undefined)),
    } as unknown as PostApprovalCalendarHandlerDeps["threadDb"];

    const accountDb = {
      getAccount: vi.fn().mockResolvedValue(ok({ defaultCalendarInviteForwardingTargetId: FORWARDING_ADDRESS })),
    } as unknown as PostApprovalCalendarHandlerDeps["accountDb"];

    const calendarIForwardingServiceEmailService = makeEmailService();
    const calendarForwarder = new CalendarForwarder({
      emailService: calendarIForwardingServiceEmailService,
      serviceDomain: SERVICE_DOMAIN,
      hmac,
    });

    const contentStore = {
      createReadUrl: vi.fn().mockResolvedValue("https://signed-url"),
      getContent: vi.fn().mockResolvedValue(new TextEncoder().encode(VALID_ICS)),
      saveRawEmail: vi.fn().mockResolvedValue(undefined),
      createContentUploadTicket: vi.fn().mockResolvedValue({ url: "https://post-url", fields: {} }),
      saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined),
    } as unknown as PostApprovalCalendarHandlerDeps["contentStore"];

    const deps: PostApprovalCalendarHandlerDeps = {
      threadDb,
      accountDb,
      contentStore,
      calendarForwarder,
      logger: createMockLogger(),
    };

    const signal: Signal = {
      id: "sgn-email-quarantined-001",
      signalLookupId: "ses-quarantined-001",
      threadId: "arc-001",
      accountId: "acct-test-001",
      source: "email",
      type: "email",
      status: "active",
      labels: [],
      createdAt: "2025-03-15T09:00:00Z",
      data: {
        receivedAt: "2025-03-15T09:00:00Z",
        from: { address: ORGANIZER_EMAIL, name: ORGANIZER_CN },
        to: [{ address: ALIAS_ADDRESS }],
        cc: [],
        subject: "Quarterly Planning",
        attachments: [
          { filename: "invite.ics", mimeType: "text/calendar", sizeBytes: 500, s3Key: "emails/quarantined/invite.ics" },
        ] as Attachment[],
        headers: {},
        recipientAddress: ALIAS_ADDRESS,
        workflow: "job",
        workflowData: { workflow: "job", isReply: false, sentiment: "neutral", requiresReply: false, jobType: "interview_request" },
        tags: [],
        summary: "Quarterly Planning",
        s3Key: "emails/quarantined-001",
      actions: [],
      },
    } as Signal;

    const arc: Thread = {
      id: "arc-001",
      accountId: "acct-test-001",
      workflow: "job",
      labels: [],
      status: "active",
      summary: "Quarterly Planning",
      lastSignalAt: "2025-03-15T09:00:00Z",
      createdAt: "2025-03-15T09:00:00Z",
      updatedAt: "2025-03-15T09:00:00Z",
      sender: { address: "sender@example.com" },
      recipientAddress: "user@example.com",
      subject: "Test email",
    };

    await handlePostApprovalCalendar(signal, arc, deps);

    // Calendar signal was saved
    expect(threadDb.saveSignal).toHaveBeenCalledOnce();
    const savedSignal = (threadDb.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedSignal.type).toBe("calendar_event");
    expect(savedSignal.source).toBe("signal");
    expect(savedSignal.data.organizer).toBe(ORGANIZER_EMAIL);
    expect(savedSignal.data.veventUid).toBe(VEVENT_UID);
    expect(savedSignal.data.linkedSignalId).toBe("sgn-email-quarantined-001");

    // Calendar invite was forwarded
    const emailSend = calendarIForwardingServiceEmailService.sendRaw as ReturnType<typeof vi.fn>;
    expect(emailSend).toHaveBeenCalledOnce();
    const sendArgs = emailSend.mock.calls[0]![0];
    expect(sendArgs.to).toEqual([FORWARDING_ADDRESS]);
  });
});

// ===========================================================================
// Scenario 9: API returns CalendarData from the calendar signal (not the
//             email signal) when listing arc signals
// ===========================================================================

describe("Scenario: CalendarData is sourced from calendar signal, not email signal", () => {
  // WHY: The calendar signal (source: "signal") is the authoritative source of
  // structured calendar data. The email signal stores raw email metadata. If the
  // UI rendered calendar cards from the email signal, it would need to re-parse
  // .ics on every render and couldn't track proxy UID or forwarding state.
  // The signalLookupId format ensures O(1) lookup by organizer + VEVENT_UID.

  it("calendar signal has source 'signal', type 'calendar_event', and CalendarData on data", () => {
    const calendarSignal = makeCalendarSignal();

    // The calendar signal is identified by source + type
    expect(calendarSignal.source).toBe("signal");
    expect(calendarSignal.type).toBe("calendar_event");

    // CalendarData is directly on the data property
    expect(calendarSignal.data.title).toBe("Quarterly Planning");
    expect(calendarSignal.data.startTime).toBe("2025-03-15T14:00:00Z");
    expect(calendarSignal.data.organizer).toBe(ORGANIZER_EMAIL);
    expect(calendarSignal.data.method).toBe("REQUEST");
    expect(calendarSignal.data.veventUid).toBe(VEVENT_UID);

    // signalLookupId enables O(1) event state lookup
    expect(calendarSignal.signalLookupId).toBe(`cal-${ORGANIZER_EMAIL}-${VEVENT_UID}`);

    // linkedSignalId traces back to the originating email signal
    expect(calendarSignal.data.linkedSignalId).toBe("sgn-email-001");
  });

  it("buildCalendarSignalLookupId produces the correct key format", () => {
    const lookupId = buildCalendarSignalLookupId(ORGANIZER_EMAIL, VEVENT_UID);
    expect(lookupId).toBe(`cal-${ORGANIZER_EMAIL}-${VEVENT_UID}`);
  });
});

// ===========================================================================
// Scenario 10: API returns most recent calendar_response decision alongside
//              the calendar signal
// ===========================================================================

describe("Scenario: most recent RSVP decision is recorded as calendar_response signal on same arc", () => {
  // WHY: The UI must show the user's current RSVP state (accepted/declined/tentative)
  // alongside the calendar card. This state is derived from the most recent
  // calendar_response signal on the arc — not stored on the calendar signal itself.
  // This design allows multiple RSVPs (change of mind) without mutating the
  // immutable calendar signal.

  it("calendar_response signal records decision, veventUid, and linkedSignalId", async () => {
    const proxyUid = await buildProxyUid({
      accountId: VALID_ACC_ID,
      threadId: VALID_ARC_ID,
      originalVeventUid: VEVENT_UID,
      serviceDomain: SERVICE_DOMAIN,
    });

    const { processor, threadStore } = makeRsvpHarness(buildReplyIcsString(proxyUid, "TENTATIVE"));

    await processor.process(makeRsvpMessage());

    // calendar_response signal was saved
    const savedSignal = (threadStore.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Signal<CalendarResponseData>;

    // Type and source identify it as a user RSVP decision
    expect(savedSignal.type).toBe("calendar_response");
    expect(savedSignal.source).toBe("user");

    // Decision matches the PARTSTAT from the native REPLY
    expect(savedSignal.data.decision).toBe("tentative");

    // veventUid is the ORIGINAL UID (not proxy) — enables joining with calendar signal
    expect(savedSignal.data.veventUid).toBe(VEVENT_UID);

    // linkedSignalId enables the API to find which calendar signal this responds to
    expect(savedSignal.data.linkedSignalId).toBeDefined();

    // Signal is on the same arc as the calendar signal
    expect(savedSignal.threadId).toBe(VALID_ARC_ID);
    expect(savedSignal.accountId).toBe(VALID_ACC_ID);

    // respondedAt is populated
    expect(savedSignal.data.respondedAt).toBeDefined();
  });
});
