import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ThreadDatabase } from "../../src/database/thread-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { Signal } from "../../src/types/index.js";
import type { CalendarEventData } from "../../src/types/calendar.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// The RSVP lives on the calendar_event row. Every invite/update/cancel for an event shares that
// row, so saving a new snapshot must keep the RSVP rather than erase it.
// ---------------------------------------------------------------------------

const RSVP = { decision: "accepted" as const, respondedAt: "2025-03-15T11:00:00Z" };

function calendarEvent(overrides: Partial<CalendarEventData> = {}): Signal<CalendarEventData> {
  return {
    id: "sgn-cal-2",
    signalLookupId: "cal-alice@example.com-uid-1",
    threadId: "thr-1",
    accountId: "acct-1",
    source: "signal",
    type: "calendar_event",
    status: "active",
    labels: [],
    createdAt: "2025-03-16T09:00:00Z",
    data: {
      title: "Standup (moved)",
      startTime: "2025-03-20T10:00:00Z",
      organizer: "alice@example.com",
      attendees: [],
      veventUid: "uid-1",
      originalVeventUid: "uid-1",
      method: "REQUEST",
      sequence: 1,
      linkedSignalId: "sgn-email-2",
      ...overrides,
    },
  };
}

function conditionalCheckFailed(): Error {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  return e;
}

describe("ThreadDatabase calendar RSVP", () => {
  let db: ThreadDatabase;

  beforeEach(() => {
    ddbMock.reset();
    db = new ThreadDatabase(createMockLogger());
  });

  afterEach(() => {
    ddbMock.restore();
  });

  it("saveCalendarEventSignal keeps the RSVP already on the event's row", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { data: { title: "Standup", rsvpResponse: RSVP } } });
    ddbMock.on(PutCommand).resolves({});

    const result = await db.saveCalendarEventSignal(calendarEvent());

    expect(result.isOk()).toBe(true);
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.Item?.["data"]).toMatchObject({ title: "Standup (moved)", rsvpResponse: RSVP });
    expect(put.ConditionExpression).toBe("#data.rsvpResponse.respondedAt = :at");
  });

  it("saveCalendarEventSignal writes no RSVP for a first invite", async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const result = await db.saveCalendarEventSignal(calendarEvent());

    expect(result.isOk()).toBe(true);
    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0].input;
    expect((put.Item?.["data"] as { rsvpResponse?: unknown }).rsvpResponse).toBeUndefined();
    expect(put.ConditionExpression).toBe("attribute_not_exists(#data.rsvpResponse)");
  });

  it("saveCalendarEventSignal re-reads and keeps an RSVP recorded between its read and write", async () => {
    ddbMock.on(GetCommand)
      .resolvesOnce({})
      .resolvesOnce({ Item: { data: { rsvpResponse: RSVP } } });
    ddbMock.on(PutCommand)
      .rejectsOnce(conditionalCheckFailed())
      .resolves({});

    const result = await db.saveCalendarEventSignal(calendarEvent());

    expect(result.isOk()).toBe(true);
    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(2);
    expect(puts[1]!.args[0].input.Item?.["data"]).toMatchObject({ rsvpResponse: RSVP });
  });

  it("setCalendarEventRsvp sets the RSVP on the existing row", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const result = await db.setCalendarEventRsvp("acct-1", "cal-alice@example.com-uid-1", RSVP);

    expect(result._unsafeUnwrap()).toBe(true);
    const update = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.Key).toEqual({ pk: "ACCT#acct-1#SIG#cal-alice@example.com-uid-1", sk: "#" });
    expect(update.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it("setCalendarEventRsvp returns false when the event row no longer exists", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());

    const result = await db.setCalendarEventRsvp("acct-1", "cal-alice@example.com-uid-1", RSVP);

    expect(result._unsafeUnwrap()).toBe(false);
  });
});
