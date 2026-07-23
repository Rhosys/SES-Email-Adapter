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
import { forwardCalendarInvite } from "../../../src/processor/calendar/calendar-forwarder.js";
import type { CalendarForwarderDeps, ForwardCalendarInviteOpts } from "../../../src/processor/calendar/calendar-forwarder.js";
import { sendRsvp } from "../../../src/processor/calendar/rsvp-composer.js";
import { handleCalendarResponse } from "../../../src/processor/calendar/calendar-response-handler.js";
import type { CalendarResponseHandlerDeps } from "../../../src/processor/calendar/calendar-response-handler.js";
import { handlePostApprovalCalendar } from "../../../src/processor/calendar/post-approval-handler.js";
import type { PostApprovalCalendarHandlerDeps } from "../../../src/processor/calendar/post-approval-handler.js";
import { buildProxyUid as buildProxyUidRaw } from "../../../src/processor/calendar/proxy-uid.js";
import { buildCalendarSignalLookupId } from "../../../src/processor/calendar/signal-lookup.js";
import type { CalendarEventData, CalendarResponseData } from "../../../src/types/calendar.js";
import type { Signal, Thread, Attachment } from "../../../src/types/index.js";
import type { InboundSignalMessage } from "../../../src/processor/processor.js";
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

function makeEmailService(): EmailService {
  return {
    send: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001" })),
    sendRaw: vi.fn(),
  } as unknown as EmailService;
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

function makeForwarderDeps(emailService?: EmailService): CalendarForwarderDeps {
  return {
    emailService: emailService ?? makeEmailService(),
    serviceDomain: SERVICE_DOMAIN,
    hmac,
  };
}

function makeForwarderOpts(overrides: Partial<ForwardCalendarInviteOpts> = {}): ForwardCalendarInviteOpts {
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

function makeResponseHandlerDeps(overrides: Partial<CalendarResponseHandlerDeps> = {}): CalendarResponseHandlerDeps {
  return {
    serviceDomain: SERVICE_DOMAIN,
    threadDatabase: {
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
    } as unknown as CalendarResponseHandlerDeps["threadDatabase"],
    rsvpComposer: vi.fn().mockResolvedValue(ok({ messageId: "ses-reply-001" })),
    signalStore: {
      saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
    },
    emailService: makeEmailService(),
    hmac,
    ...overrides,
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
    const deps = makeForwarderDeps(emailService);
    const opts = makeForwarderOpts();
    const logger = createMockLogger();

    const result = await forwardCalendarInvite(opts, deps, logger);

    // Forwarding succeeds
    expect(result.isOk()).toBe(true);

    // Email was sent to the user's real calendar address
    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendCall.to).toBe(FORWARDING_ADDRESS);

    // The .ics body contains a proxy UID (not the original)
    const icsBody: string = sendCall.textBody;
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
    const deps = makeForwarderDeps(emailService);
    const cancelSignal = makeCalendarSignal({ method: "CANCEL", status: "CANCELLED" });
    const opts = makeForwarderOpts({ calendarSignal: cancelSignal });
    const logger = createMockLogger();

    const result = await forwardCalendarInvite(opts, deps, logger);

    expect(result.isOk()).toBe(true);

    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const icsBody: string = sendCall.textBody;

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
    const deps = makeForwarderDeps(emailService);
    const rescheduleSignal = makeCalendarSignal({
      method: "REQUEST",
      sequence: 3,
      startTime: "2025-03-16T14:00:00Z",
      endTime: "2025-03-16T15:00:00Z",
    });
    const opts = makeForwarderOpts({ calendarSignal: rescheduleSignal });
    const logger = createMockLogger();

    const result = await forwardCalendarInvite(opts, deps, logger);

    expect(result.isOk()).toBe(true);

    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const icsBody: string = sendCall.textBody;

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
    const calendarData = makeCalendarSignal().data;

    const result = await sendRsvp(
      {
        decision: "accepted",
        originalCalendarData: calendarData,
        aliasAddress: ALIAS_ADDRESS,
        organizerAddress: ORGANIZER_EMAIL,
        fromAddress: ALIAS_ADDRESS,
        accountId: "acct-test",
      },
      { emailService },
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().messageId).toBe("ses-msg-001");

    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];

    // Sent TO the organizer (RFC 6047)
    expect(sendCall.to).toBe(ORGANIZER_EMAIL);

    // Sent FROM the alias (privacy preserved)
    expect(sendCall.fromOverride).toBe(ALIAS_ADDRESS);

    // Parse the .ics to verify structure
    const icsBody: string = sendCall.textBody;
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
    const deps = makeResponseHandlerDeps();
    const logger = createMockLogger();

    // Build a valid proxy UID for the .ics
    const proxyUid = await buildProxyUid({
      accountId: VALID_ACC_ID,
      threadId: VALID_ARC_ID,
      originalVeventUid: VEVENT_UID,
      serviceDomain: SERVICE_DOMAIN,
    });

    const icsContent = buildReplyIcsString(proxyUid, "ACCEPTED");
    const icsBytes = new TextEncoder().encode(icsContent);

    const recipient = `${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`;
    const message: InboundSignalMessage = {
      s3Key: "emails/native-reply.eml",
      sesMessageId: "ses-native-001",
      idempotencyKey: "test-idempotency-key",
      timestamp: "2025-03-15T15:30:00Z",
      destination: [recipient],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };

    const result = await handleCalendarResponse(message, deps, logger, icsBytes);

    expect(result.isOk()).toBe(true);

    // RSVP_Composer was called with the correct decision
    expect(deps.rsvpComposer).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "accepted",
        organizerAddress: ORGANIZER_EMAIL,
      }),
      expect.anything(),
    );

    // calendar_response signal was saved
    const savedSignal = (deps.signalStore.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0];
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
    const deps = makeResponseHandlerDeps();
    const logger = createMockLogger();

    // Build a proxy UID with a WRONG secret (simulates attacker guessing)
    // Manually construct a UID with an invalid HMAC suffix
    const payload = `${VALID_ACC_ID}.${VALID_ARC_ID}.${VEVENT_UID}`;
    const tamperedProxyUid = `${payload}.AAAAAAAAAAAAAAAA@${SERVICE_DOMAIN}`;

    const icsContent = buildReplyIcsString(tamperedProxyUid, "ACCEPTED");
    const icsBytes = new TextEncoder().encode(icsContent);

    const recipient = `${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`;
    const message: InboundSignalMessage = {
      s3Key: "emails/forged-reply.eml",
      sesMessageId: "ses-forged-001",
      idempotencyKey: "test-idempotency-key",
      timestamp: "2025-03-15T16:00:00Z",
      destination: [recipient],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };

    await handleCalendarResponse(message, deps, logger, icsBytes);

    // No DB lookup occurred
    expect(deps.threadDatabase.getThread).not.toHaveBeenCalled();

    // No signal was created
    expect(deps.signalStore.saveSignal).not.toHaveBeenCalled();

    // No RSVP was sent
    expect(deps.rsvpComposer).not.toHaveBeenCalled();

    // WARN was logged with hmac_failed
    const warnCalls = logger.calls.filter(c => c.method === "warn");
    expect(warnCalls.some(c => c.context?.validationType === "hmac_failed")).toBe(true);
  });
});

// ===========================================================================
// Scenario 7: Inbound REPLY with invalid accountId checksum → silently dropped
// ===========================================================================

describe("Scenario: invalid accountId checksum REPLY is dropped before HMAC check", () => {
  // WHY: The checksum on accountId is the FIRST validation gate — it runs before
  // HMAC computation. This prevents attackers from using the proxy endpoint to
  // probe which account IDs exist (timing attacks). If the checksum fails, no
  // further processing occurs — not even HMAC validation.

  it("does not create signal, call DB, or check HMAC when accountId checksum fails", async () => {
    const deps = makeResponseHandlerDeps();
    const logger = createMockLogger();

    // Use a valid proxy UID (would pass HMAC if it got that far)
    const proxyUid = await buildProxyUid({
      accountId: VALID_ACC_ID,
      threadId: VALID_ARC_ID,
      originalVeventUid: VEVENT_UID,
      serviceDomain: SERVICE_DOMAIN,
    });

    const icsContent = buildReplyIcsString(proxyUid, "DECLINED");
    const icsBytes = new TextEncoder().encode(icsContent);

    // Invalid accountId — checksum will fail
    const badAccountId = "acc-xxxxxxxxxx000";
    const recipient = `${VALID_ARC_ID}@${badAccountId}.${SERVICE_DOMAIN}`;
    const message: InboundSignalMessage = {
      s3Key: "emails/bad-checksum.eml",
      sesMessageId: "ses-bad-001",
      idempotencyKey: "test-idempotency-key",
      timestamp: "2025-03-15T16:30:00Z",
      destination: [recipient],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };

    await handleCalendarResponse(message, deps, logger, icsBytes);

    // No DB lookup
    expect(deps.threadDatabase.getThread).not.toHaveBeenCalled();

    // No signal created
    expect(deps.signalStore.saveSignal).not.toHaveBeenCalled();

    // No RSVP sent
    expect(deps.rsvpComposer).not.toHaveBeenCalled();

    // WARN logged with checksum failure
    const warnCalls = logger.calls.filter(c => c.method === "warn");
    expect(warnCalls.some(c =>
      c.context?.validationType === "accountId_checksum" ||
      c.context?.validationType === "domain_mismatch",
    )).toBe(true);
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
    const calendarForwarderDeps: CalendarForwarderDeps = {
      emailService: calendarIForwardingServiceEmailService,
      serviceDomain: SERVICE_DOMAIN,
      hmac,
    };

    const s3Client = {
      send: vi.fn().mockResolvedValue({
        Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode(VALID_ICS)) },
      }),
    } as unknown as PostApprovalCalendarHandlerDeps["s3Client"];

    const deps: PostApprovalCalendarHandlerDeps = {
      threadDb,
      accountDb,
      s3Client,
      contentBucket: "test-bucket",
      calendarForwarderDeps,
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
      senderAddress: "sender@example.com",
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
    const emailSend = calendarIForwardingServiceEmailService.send as ReturnType<typeof vi.fn>;
    expect(emailSend).toHaveBeenCalledOnce();
    const sendArgs = emailSend.mock.calls[0]![0];
    expect(sendArgs.to).toBe(FORWARDING_ADDRESS);
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
    const deps = makeResponseHandlerDeps();
    const logger = createMockLogger();

    const proxyUid = await buildProxyUid({
      accountId: VALID_ACC_ID,
      threadId: VALID_ARC_ID,
      originalVeventUid: VEVENT_UID,
      serviceDomain: SERVICE_DOMAIN,
    });

    const icsContent = buildReplyIcsString(proxyUid, "TENTATIVE");
    const icsBytes = new TextEncoder().encode(icsContent);

    const recipient = `${VALID_ARC_ID}@${VALID_ACC_ID}.${SERVICE_DOMAIN}`;
    const message: InboundSignalMessage = {
      s3Key: "emails/tentative-reply.eml",
      sesMessageId: "ses-tentative-001",
      idempotencyKey: "test-idempotency-key",
      timestamp: "2025-03-15T17:00:00Z",
      destination: [recipient],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };

    await handleCalendarResponse(message, deps, logger, icsBytes);

    // calendar_response signal was saved
    const savedSignal = (deps.signalStore.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Signal<CalendarResponseData>;

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
