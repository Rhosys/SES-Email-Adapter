import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ThreadDatabase } from "../../src/database/thread-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// getLatestCalendarResponse must pick the response with the greatest respondedAt
// for a veventUid — NOT the first one encountered in the gsi1sk (signal-id) scan.
// RSVPs are append-only history; "latest" is a wall-clock fact (respondedAt),
// which is independent of signal-id ordering. A user who accepts then declines
// must see "declined" regardless of which response got the larger sgn- id.
// ---------------------------------------------------------------------------

function calendarResponseItem(opts: { id: string; veventUid: string; decision: string; respondedAt: string }) {
  return {
    // gsi1sk = signal.id, so DynamoDB's ScanIndexForward:false orders by this.
    id: opts.id,
    signalLookupId: opts.id,
    type: "calendar_response",
    threadId: "thr-1",
    accountId: "acct-1",
    source: "user",
    status: "active",
    createdAt: opts.respondedAt,
    data: {
      decision: opts.decision,
      respondedAt: opts.respondedAt,
      veventUid: opts.veventUid,
      linkedSignalId: "sgn-cal-invite",
      sendStatus: "sent",
    },
  };
}

describe("ThreadDatabase.getLatestCalendarResponse — latest by respondedAt", () => {
  let db: ThreadDatabase;

  beforeEach(() => {
    ddbMock.reset();
    db = new ThreadDatabase(createMockLogger());
  });

  afterEach(() => {
    ddbMock.restore();
  });

  it("returns the response with the greatest respondedAt, not the first in id-desc scan order", async () => {
    // Two RSVPs for the same event. The LATER decision ("declined") has the LOWER signal id,
    // so under ScanIndexForward:false (id-descending) it appears SECOND. The earlier "accepted"
    // has the higher id and appears FIRST. A first-match pick would wrongly return "accepted".
    ddbMock.on(QueryCommand).resolves({
      Items: [
        calendarResponseItem({ id: "sgn-zzz", veventUid: "uid-1", decision: "accepted", respondedAt: "2025-03-15T10:00:00Z" }),
        calendarResponseItem({ id: "sgn-aaa", veventUid: "uid-1", decision: "declined", respondedAt: "2025-03-15T12:00:00Z" }),
      ],
    });

    const result = await db.getLatestCalendarResponse("acct-1", "thr-1", "uid-1");

    expect(result.isOk()).toBe(true);
    const signal = result._unsafeUnwrap();
    expect(signal?.data.decision).toBe("declined");
    expect(signal?.data.respondedAt).toBe("2025-03-15T12:00:00Z");
  });

  it("filters by veventUid — a response for a different event is ignored", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        calendarResponseItem({ id: "sgn-zzz", veventUid: "uid-OTHER", decision: "accepted", respondedAt: "2025-03-15T18:00:00Z" }),
        calendarResponseItem({ id: "sgn-aaa", veventUid: "uid-1", decision: "tentative", respondedAt: "2025-03-15T09:00:00Z" }),
      ],
    });

    const result = await db.getLatestCalendarResponse("acct-1", "thr-1", "uid-1");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()?.data.decision).toBe("tentative");
  });

  it("returns null when no response exists for the veventUid", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await db.getLatestCalendarResponse("acct-1", "thr-1", "uid-1");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });
});
