import { describe, it, expect, vi, beforeEach } from "vitest";
import { CalendarForwarder } from "../../../src/processor/calendar/calendar-forwarder.js";
import type { EmailService } from "../../../src/email/email-service.js";
import type { CalendarEventData } from "../../../src/types/calendar.js";
import { ok, err } from "../../../src/errors.js";
import { createMockLogger } from "../../helpers/mock-logger.js";
import { makeHmacGeneratorFake } from "../../helpers/hmac-generator-fake.js";
import ICAL from "ical.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEmailService(): EmailService {
  return {
    send: vi.fn(),
    sendRaw: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001" })),
    platformTenant: "platform-tenant",
    platformFrom: "invites@platform.email.rhosys.cloud",
  } as unknown as EmailService;
}

function makeForwarder(emailService: EmailService): CalendarForwarder {
  return new CalendarForwarder({
    emailService,
    serviceDomain: "platform.email.rhosys.cloud",
    hmac: makeHmacGeneratorFake(),
  });
}

/** Decode the raw MIME .ics body from a sendRaw call. */
function rawIcsOf(emailService: EmailService): string {
  const rawData: Uint8Array = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0].rawData;
  const message = Buffer.from(rawData).toString("utf8");
  const body = message.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
  return Buffer.from(body, "base64").toString("utf8");
}

function makeCalendarData(overrides: Partial<CalendarEventData> = {}): CalendarEventData {
  return {
    title: "Team Standup",
    startTime: "2025-03-15T10:00:00Z",
    endTime: "2025-03-15T11:00:00Z",
    organizer: "alice@company.com",
    organizerCn: "Alice Smith",
    attendees: [],
    veventUid: "uid-original-123",
    originalVeventUid: "uid-original-123",
    method: "REQUEST",
    sequence: 2,
    linkedSignalId: "sig-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 6: RSVP always targets ORGANIZER mailto: address
// Validates: Requirements 7.1, 14.3
// ---------------------------------------------------------------------------

describe("CalendarForwarder.sendReply — RSVP targets ORGANIZER mailto: address", () => {
  let emailService: EmailService;

  beforeEach(() => {
    emailService = makeEmailService();
  });

  it.each([
    {
      emailFrom: "alice@company.com",
      organizer: "alice@company.com",
      expectedTo: "alice@company.com",
      reason: "organizer matches email From — RSVP sent to organizer",
    },
    {
      emailFrom: "noreply@calendar.google.com",
      organizer: "alice@company.com",
      expectedTo: "alice@company.com",
      reason: "Google noreply envelope — RSVP sent to iCal ORGANIZER, not envelope From",
    },
    {
      emailFrom: "notifications@calendly.com",
      organizer: "host@company.com",
      expectedTo: "host@company.com",
      reason: "Calendly notification — RSVP sent to iCal ORGANIZER",
    },
    {
      emailFrom: "info@meetup.com",
      organizer: "organizer@meetup.com",
      expectedTo: "organizer@meetup.com",
      reason: "Meetup info address — RSVP sent to iCal ORGANIZER",
    },
  ])("$reason", async ({ organizer, expectedTo }) => {
    const forwarder = makeForwarder(emailService);
    await forwarder.sendReply(
      {
        decision: "accepted",
        originalCalendarData: makeCalendarData({ organizer, originalVeventUid: "uid-event-1" }),
        aliasAddress: "alias@proxy.com",
        organizerAddress: organizer,
        fromAddress: "alias@proxy.com",
        accountId: "acct-test",
      },
      createMockLogger(),
    );

    const sendCall = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendCall.to).toEqual([expectedTo]);
  });
});

// ---------------------------------------------------------------------------
// Property 10: REPLY uses original UID not proxy
// Validates: Requirements 11.3
// ---------------------------------------------------------------------------

describe("CalendarForwarder.sendReply — REPLY uses original UID not proxy UID", () => {
  let emailService: EmailService;

  beforeEach(() => {
    emailService = makeEmailService();
  });

  it.each([
    {
      originalUid: "uid-original-123",
      proxyUid: "acc.arc.uid-original-123.hmac1234567890ab@platform.email.rhosys.cloud",
      reason: "standard UID — REPLY contains original, not proxy",
    },
    {
      originalUid: "event-abc",
      proxyUid: "acc.arc.event-abc.hmac1234567890ab@platform.email.rhosys.cloud",
      reason: "short UID — REPLY contains original, not proxy",
    },
  ])("$reason", async ({ originalUid, proxyUid }) => {
    const forwarder = makeForwarder(emailService);
    await forwarder.sendReply(
      {
        decision: "accepted",
        originalCalendarData: makeCalendarData({
          originalVeventUid: originalUid,
          proxyUid,
        }),
        aliasAddress: "alias@proxy.com",
        organizerAddress: "organizer@example.com",
        fromAddress: "alias@proxy.com",
        accountId: "acct-test",
      },
      createMockLogger(),
    );

    // Extract the .ics content from the raw MIME body
    const icsContent: string = rawIcsOf(emailService);

    // Parse back through ical.js and verify UID
    const parsed = ICAL.parse(icsContent);
    const comp = new ICAL.Component(parsed);
    const vevent = comp.getFirstSubcomponent("vevent")!;
    expect(vevent.getFirstPropertyValue("uid")).toBe(originalUid);
    expect(icsContent).not.toContain(proxyUid);
  });
});

// ---------------------------------------------------------------------------
// Reply is sent as a text/calendar part under the customer tenant from the alias
// ---------------------------------------------------------------------------

describe("CalendarForwarder.sendReply — identity and MIME shape", () => {
  it("sends METHOD:REPLY as text/calendar, from the alias, under the customer tenant", async () => {
    const emailService = makeEmailService();
    const forwarder = makeForwarder(emailService);

    await forwarder.sendReply(
      {
        decision: "declined",
        originalCalendarData: makeCalendarData(),
        aliasAddress: "alias@proxy.com",
        organizerAddress: "organizer@example.com",
        fromAddress: "alias@proxy.com",
        accountId: "acct-test",
      },
      createMockLogger(),
    );

    const sendCall = (emailService.sendRaw as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Customer tenant, alias From — never the platform identity.
    expect(sendCall.accountId).toBe("acct-test");
    expect(sendCall.fromSender).toBe("alias@proxy.com");

    const rawData: Uint8Array = sendCall.rawData;
    const headerBlock = Buffer.from(rawData).toString("utf8").split("\r\n\r\n")[0]!;
    expect(headerBlock).toContain("Content-Type: text/calendar; method=REPLY; charset=UTF-8");
    expect(headerBlock).toContain("From: alias@proxy.com");
  });
});

// ---------------------------------------------------------------------------
// Permanent SES error handling
// ---------------------------------------------------------------------------

describe("CalendarForwarder.sendReply — permanent SES error", () => {
  it("returns ok and logs WARN on permanent SES error — no retry", async () => {
    const emailService = makeEmailService();
    const logger = createMockLogger();
    vi.mocked(emailService.sendRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce(err({ kind: "permanent_ses_error", errorName: "MessageRejected", httpStatus: 400, message: "Email address is not verified", cause: new Error("test") }));

    const forwarder = makeForwarder(emailService);
    const result = await forwarder.sendReply(
      {
        decision: "accepted",
        originalCalendarData: makeCalendarData(),
        aliasAddress: "alias@proxy.com",
        organizerAddress: "organizer@example.com",
        fromAddress: "alias@proxy.com",
        accountId: "acct-test",
      },
      logger,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: "" });
    expect(logger.calls.some(c => c.method === "warn" && c.context?.code === "rsvp.send_permanent")).toBe(true);
  });
});
