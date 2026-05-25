import { describe, it, expect } from "vitest";
import { buildForwardIcs, buildReplyIcs } from "../../../src/processor/calendar/ics-builder.js";
import type { CalendarEventData } from "../../../src/types/calendar.js";
import ICAL from "ical.js";

function makeCalendarData(overrides: Partial<CalendarEventData> = {}): CalendarEventData {
  return {
    title: "Team Standup",
    startTime: "2025-03-15T10:00:00Z",
    endTime: "2025-03-15T11:00:00Z",
    organizer: "alice@example.com",
    organizerCn: "Alice Smith",
    attendees: [],
    veventUid: "uid-original-123",
    originalVeventUid: "uid-original-123",
    method: "REQUEST",
    sequence: 3,
    location: "Room 4B",
    description: "Weekly sync",
    status: "CONFIRMED",
    linkedSignalId: "sig-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 7: Constructed .ics preserves required fields from CalendarData
// Validates: Requirements 10.5
// ---------------------------------------------------------------------------

describe("buildForwardIcs — field preservation", () => {
  const calendarData = makeCalendarData();
  const ics = buildForwardIcs({
    calendarData,
    proxyUid: "acc-abc123.arc-def456.uid-original-123.hmac1234567890ab@platform.email.rhosys.cloud",
    proxyOrganizer: "mailto:arc-def456@acc-abc123.platform.email.rhosys.cloud",
    organizerCn: "Alice Smith",
    attendeeAddress: "user@gmail.com",
  });

  it.each([
    { field: "sequence: 3", expected: "SEQUENCE:3", reason: "SEQUENCE preserved from CalendarData" },
    { field: "startTime", expected: "DTSTART:20250315T100000Z", reason: "DTSTART formatted as iCal UTC" },
    { field: "endTime", expected: "DTEND:20250315T110000Z", reason: "DTEND formatted as iCal UTC" },
    { field: "title", expected: "SUMMARY:Team Standup", reason: "SUMMARY preserved from title" },
    { field: "location", expected: "LOCATION:Room 4B", reason: "LOCATION preserved" },
    { field: "description", expected: "DESCRIPTION:Weekly sync", reason: "DESCRIPTION preserved" },
    { field: "status", expected: "STATUS:CONFIRMED", reason: "STATUS preserved" },
    { field: "method", expected: "METHOD:REQUEST", reason: "METHOD preserved at VCALENDAR level" },
  ])("$reason → contains $expected", ({ expected }) => {
    expect(ics).toContain(expected);
  });
});

// ---------------------------------------------------------------------------
// Property 14: PARTSTAT correctly maps decision to iCal value
// Validates: Requirements 15.1
// ---------------------------------------------------------------------------

describe("buildReplyIcs — PARTSTAT mapping", () => {
  it.each([
    { decision: "ACCEPTED" as const, partstat: "ACCEPTED", reason: "accepted maps to ACCEPTED" },
    { decision: "DECLINED" as const, partstat: "DECLINED", reason: "declined maps to DECLINED" },
    { decision: "TENTATIVE" as const, partstat: "TENTATIVE", reason: "tentative maps to TENTATIVE" },
  ])("$reason", ({ decision, partstat }) => {
    const ics = buildReplyIcs({
      veventUid: "uid-original-123",
      sequence: 1,
      attendeeAddress: "alias@domain.com",
      decision,
      organizerAddress: "organizer@example.com",
    });

    // Parse back through ical.js to verify PARTSTAT on ATTENDEE
    const parsed = ICAL.parse(ics);
    const comp = new ICAL.Component(parsed);
    const vevent = comp.getFirstSubcomponent("vevent")!;
    const attendee = vevent.getFirstProperty("attendee")!;
    expect(attendee.getParameter("partstat")).toBe(partstat);
  });
});

// ---------------------------------------------------------------------------
// Property 10: REPLY .ics uses original VEVENT_UID, not proxy UID
// Validates: Requirements 11.3
// ---------------------------------------------------------------------------

describe("buildReplyIcs — uses original UID not proxy UID", () => {
  it.each([
    {
      originalUid: "uid-original-123",
      proxyUid: "acc.arc.uid-original-123.hmac@platform.email.rhosys.cloud",
      reason: "standard UID preserved in REPLY",
    },
    {
      originalUid: "event-abc",
      proxyUid: "acc.arc.event-abc.hmac@platform.email.rhosys.cloud",
      reason: "short UID preserved in REPLY",
    },
  ])("$reason", ({ originalUid, proxyUid }) => {
    const ics = buildReplyIcs({
      veventUid: originalUid,
      sequence: 1,
      attendeeAddress: "alias@domain.com",
      decision: "ACCEPTED",
      organizerAddress: "organizer@example.com",
    });

    // Parse and verify UID is the original, not the proxy
    const parsed = ICAL.parse(ics);
    const comp = new ICAL.Component(parsed);
    const vevent = comp.getFirstSubcomponent("vevent")!;
    expect(vevent.getFirstPropertyValue("uid")).toBe(originalUid);
    expect(ics).not.toContain(proxyUid);
  });
});

// ---------------------------------------------------------------------------
// Property 11: Proxy ORGANIZER address format
// Validates: Requirements 11.3
// ---------------------------------------------------------------------------

describe("buildForwardIcs — proxy ORGANIZER format and CN", () => {
  it("ORGANIZER is mailto:{arcId}@{accountId}.{serviceDomain} with original CN", () => {
    const ics = buildForwardIcs({
      calendarData: makeCalendarData(),
      proxyUid: "acc-abc123.arc-def456.uid-original-123.hmac1234567890ab@platform.email.rhosys.cloud",
      proxyOrganizer: "mailto:arc-def456@acc-abc123.platform.email.rhosys.cloud",
      organizerCn: "Alice Smith",
      attendeeAddress: "user@gmail.com",
    });

    // Parse and verify ORGANIZER value and CN parameter
    const parsed = ICAL.parse(ics);
    const comp = new ICAL.Component(parsed);
    const vevent = comp.getFirstSubcomponent("vevent")!;
    const organizer = vevent.getFirstProperty("organizer")!;

    expect(organizer.getFirstValue()).toBe("mailto:arc-def456@acc-abc123.platform.email.rhosys.cloud");
    expect(organizer.getParameter("cn")).toBe("Alice Smith");
  });
});
