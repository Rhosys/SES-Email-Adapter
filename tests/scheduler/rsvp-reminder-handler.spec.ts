// Feature: calendar-rsvp-reminder, Property 2: Fire-time notification decision
// Validates: Requirements 2.1, 2.2, 2.3, 5.1, 5.2

import { describe, it, expect, vi } from "vitest";
import { ok, err, dbError } from "../../src/errors.js";
import { RsvpReminderHandler } from "../../src/scheduler/rsvp-reminder-handler.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { Thread, Signal } from "../../src/types/index.js";
import type { Notifier } from "../../src/notifier/types.js";
import type { RsvpReminderMessage } from "../../src/scheduler/rsvp-reminder.js";
import type { CalendarEventData } from "../../src/types/calendar.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_ID = "acc-rsvp-001";
const ARC_ID = "arc-rsvp-001";
const SIGNAL_ID = "sgn-rsvp-001";
const VEVENT_UID = "event-uid-abc@example.com";

/** A start time guaranteed to be in the future (year 2099). */
const FUTURE_START = "2099-07-15T14:00:00Z";
/** A start time guaranteed to be in the past (year 2020). */
const PAST_START = "2020-01-01T08:00:00Z";

const MESSAGE: RsvpReminderMessage = { accountId: ACCOUNT_ID, signalId: SIGNAL_ID, threadId: ARC_ID };

function makeCalendarSignal(overrides: Partial<{ startTime: string; veventUid: string }> = {}): Signal {
  const data: CalendarEventData = {
    title: "Team standup",
    startTime: overrides.startTime ?? FUTURE_START,
    organizer: "organizer@example.com",
    attendees: [{ address: "me@example.com" }],
    veventUid: overrides.veventUid ?? VEVENT_UID,
    method: "REQUEST",
    sequence: 0,
    originalVeventUid: overrides.veventUid ?? VEVENT_UID,
    linkedSignalId: "sgn-email-001",
  };

  return {
    id: SIGNAL_ID,
    signalLookupId: SIGNAL_ID,
    threadId: ARC_ID,
    accountId: ACCOUNT_ID,
    source: "email",
    type: "calendar_event",
    status: "active",
    createdAt: "2024-06-01T12:00:00Z",
    data,
  } as unknown as Signal;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ARC_ID,
    accountId: ACCOUNT_ID,
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "Calendar arc",
    lastSignalAt: "2024-06-01T12:00:00Z",
    createdAt: "2024-06-01T12:00:00Z",
    updatedAt: "2024-06-01T12:00:00Z",
    urgency: "normal",
    sender: { address: "sender@example.com" },
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

function makeResponseSignal(): Signal {
  return {
    id: "sgn-resp-001",
    signalLookupId: "sgn-resp-001",
    threadId: ARC_ID,
    accountId: ACCOUNT_ID,
    source: "user",
    type: "calendar_response",
    status: "active",
    createdAt: "2024-06-02T10:00:00Z",
    data: { decision: "accepted", respondedAt: "2024-06-02T10:00:00Z", veventUid: VEVENT_UID, linkedSignalId: SIGNAL_ID },
  } as unknown as Signal;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setup() {
  const threadDb = { getSignalById: vi.fn(), getLatestCalendarResponse: vi.fn(), getThread: vi.fn() };
  const notifier: Notifier = { notify: vi.fn(), notifyBlocked: vi.fn() };
  const logger = createMockLogger();

  const handler = new RsvpReminderHandler({ threadDb, notifier, logger });

  return { handler, threadDb, notifier, logger };
}

// ---------------------------------------------------------------------------
// Property 2: Fire-time notification decision
// Decision table: all 4 rows
// ---------------------------------------------------------------------------

describe("RsvpReminderHandler", () => {
  describe("Property 2: Fire-time notification decision", () => {
    it("Row 1: signal missing → discard (TRACK signal_missing)", async () => {
      const { handler, threadDb, notifier, logger } = setup();
      threadDb.getSignalById.mockResolvedValue(ok(null));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(threadDb.getLatestCalendarResponse).not.toHaveBeenCalled();
      expect(notifier.notify).not.toHaveBeenCalled();

      const trackCalls = logger.calls.filter((c) => c.method === "track");
      expect(trackCalls).toHaveLength(1);
      expect(trackCalls[0]!.context).toMatchObject({ code: "rsvp_reminder.signal_missing" });
    });

    it("Row 2: event passed → discard (TRACK event_passed)", async () => {
      const { handler, threadDb, notifier, logger } = setup();
      threadDb.getSignalById.mockResolvedValue(ok(makeCalendarSignal({ startTime: PAST_START })));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(threadDb.getLatestCalendarResponse).not.toHaveBeenCalled();
      expect(notifier.notify).not.toHaveBeenCalled();

      const trackCalls = logger.calls.filter((c) => c.method === "track");
      expect(trackCalls).toHaveLength(1);
      expect(trackCalls[0]!.context).toMatchObject({ code: "rsvp_reminder.event_passed" });
    });

    it("Row 3: response exists → discard (TRACK already_responded)", async () => {
      const { handler, threadDb, notifier, logger } = setup();
      threadDb.getSignalById.mockResolvedValue(ok(makeCalendarSignal()));
      threadDb.getLatestCalendarResponse.mockResolvedValue(ok(makeResponseSignal()));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(notifier.notify).not.toHaveBeenCalled();

      const trackCalls = logger.calls.filter((c) => c.method === "track");
      expect(trackCalls).toHaveLength(1);
      expect(trackCalls[0]!.context).toMatchObject({ code: "rsvp_reminder.already_responded" });
    });

    it("Row 4: no response → notify with reason rsvp_reminder", async () => {
      const { handler, threadDb, notifier } = setup();
      const signal = makeCalendarSignal();
      const arc = makeThread();
      threadDb.getSignalById.mockResolvedValue(ok(signal));
      threadDb.getLatestCalendarResponse.mockResolvedValue(ok(null));
      threadDb.getThread.mockResolvedValue(ok(arc));
      vi.mocked(notifier.notify).mockResolvedValue(ok(undefined));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(notifier.notify).toHaveBeenCalledOnce();
      expect(notifier.notify).toHaveBeenCalledWith(
        ACCOUNT_ID,
        expect.objectContaining({ id: ARC_ID }),
        expect.objectContaining({ id: SIGNAL_ID }),
        "normal",
        "rsvp_reminder",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // DB error propagation (triggers SQS retry)
  // ---------------------------------------------------------------------------

  describe("error propagation", () => {
    it("DB error on getSignalById → returns err (SQS retry)", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getSignalById.mockResolvedValue(err(dbError("DynamoDB timeout")));

      const result = await handler.process(MESSAGE);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("DB error on getLatestCalendarResponse → returns err (SQS retry)", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getSignalById.mockResolvedValue(ok(makeCalendarSignal()));
      threadDb.getLatestCalendarResponse.mockResolvedValue(err(dbError("Connection refused")));

      const result = await handler.process(MESSAGE);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("DB error on getArc → returns err (SQS retry)", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getSignalById.mockResolvedValue(ok(makeCalendarSignal()));
      threadDb.getLatestCalendarResponse.mockResolvedValue(ok(null));
      threadDb.getThread.mockResolvedValue(err(dbError("throttled")));

      const result = await handler.process(MESSAGE);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("arc not found → discard (TRACK arc_missing)", async () => {
      const { handler, threadDb, notifier, logger } = setup();
      threadDb.getSignalById.mockResolvedValue(ok(makeCalendarSignal()));
      threadDb.getLatestCalendarResponse.mockResolvedValue(ok(null));
      threadDb.getThread.mockResolvedValue(ok(null));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(notifier.notify).not.toHaveBeenCalled();

      const trackCalls = logger.calls.filter((c) => c.method === "track");
      expect(trackCalls).toHaveLength(1);
      expect(trackCalls[0]!.context).toMatchObject({ code: "rsvp_reminder.thread_missing" });
    });
  });
});
