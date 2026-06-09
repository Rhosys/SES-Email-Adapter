import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendRsvp } from "../../../src/processor/calendar/rsvp-composer.js";
import type { EmailService } from "../../../src/email/email-service.js";
import type { CalendarEventData } from "../../../src/types/calendar.js";
import { ok } from "../../../src/errors.js";
import ICAL from "ical.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEmailService(): EmailService {
  return {
    send: vi.fn().mockResolvedValue(ok({ messageId: "ses-msg-001" })),
    sendRaw: vi.fn(),
  } as unknown as EmailService;
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

describe("sendRsvp — RSVP targets ORGANIZER mailto: address", () => {
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
    await sendRsvp(
      {
        decision: "accepted",
        originalCalendarData: makeCalendarData({ organizer, originalVeventUid: "uid-event-1" }),
        aliasAddress: "alias@proxy.com",
        organizerAddress: organizer,
        fromAddress: "alias@proxy.com",
        accountId: "acct-test",
      },
      { emailService },
    );

    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sendCall.to).toBe(expectedTo);
  });
});

// ---------------------------------------------------------------------------
// Property 10: REPLY uses original UID not proxy
// Validates: Requirements 11.3
// ---------------------------------------------------------------------------

describe("sendRsvp — REPLY uses original UID not proxy UID", () => {
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
    await sendRsvp(
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
      { emailService },
    );

    // Extract the .ics content from the send call (textBody)
    const sendCall = (emailService.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const icsContent: string = sendCall.textBody;

    // Parse back through ical.js and verify UID
    const parsed = ICAL.parse(icsContent);
    const comp = new ICAL.Component(parsed);
    const vevent = comp.getFirstSubcomponent("vevent")!;
    expect(vevent.getFirstPropertyValue("uid")).toBe(originalUid);
    expect(icsContent).not.toContain(proxyUid);
  });
});
