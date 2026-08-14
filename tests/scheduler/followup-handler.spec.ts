import { describe, it, expect, beforeEach, vi } from "vitest";
import { ok, err, dbError } from "../../src/errors.js";
import { FollowupHandler } from "../../src/scheduler/followup-handler.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { Thread, Signal, ThreadStatus } from "../../src/types/index.js";
import type { Notifier } from "../../src/notifier/types.js";
import type { FollowupMessage } from "../../src/scheduler/followup-handler.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_ID = "acc-test-001";
const ARC_ID = "arc-test-001";
const SIGNAL_ID = "sgn-test-001";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ARC_ID,
    accountId: ACCOUNT_ID,
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "Test arc",
    lastSignalAt: "2024-06-01T12:00:00Z",
    createdAt: "2024-06-01T12:00:00Z",
    updatedAt: "2024-06-01T12:00:00Z",
    followupAt: "2024-06-02T09:00:00Z",
    sender: { address: "sender@example.com" },
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: SIGNAL_ID,
    signalLookupId: SIGNAL_ID,
    threadId: ARC_ID,
    accountId: ACCOUNT_ID,
    source: "email",
    type: "email",
    status: "active",
    createdAt: "2024-06-01T12:00:00Z",
    data: {
      receivedAt: "2024-06-01T12:00:00Z",
      summary: "Test signal",
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "me@example.com" }],
      cc: [],
      subject: "Test subject",
      textBody: "Hello",
      attachments: [],
      headers: {},
      recipientAddress: "me@example.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
      tags: [],
      s3Key: "emails/test.eml",
    },
    ...overrides,
  } as Signal;
}

const MESSAGE: FollowupMessage = { accountId: ACCOUNT_ID, signalId: SIGNAL_ID, threadId: ARC_ID };

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setup() {
  const threadDb = { getThread: vi.fn(), updateThread: vi.fn(), getSignalById: vi.fn() };
  const notifier: Notifier = { notify: vi.fn(), notifyBlocked: vi.fn() };
  const logger = createMockLogger();

  const handler = new FollowupHandler({ threadDb: threadDb, notifier, logger });

  return { handler, threadDb, notifier, logger };
}

// ---------------------------------------------------------------------------
// Unit Tests: Arc State Handling
// ---------------------------------------------------------------------------

describe("FollowupHandler", () => {
  describe("arc state: null → discard", () => {
    it("discards message when arc is not found", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(null));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(threadDb.getSignalById).not.toHaveBeenCalled();
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("logs TRACK when arc is null", async () => {
      const { handler, threadDb, logger } = setup();
      threadDb.getThread.mockResolvedValue(ok(null));

      await handler.process(MESSAGE);

      const trackCalls = logger.calls.filter((c) => c.method === "track");
      expect(trackCalls).toHaveLength(1);
      expect(trackCalls[0]!.context).toMatchObject({ code: "followup.stale_fire", reason: "missing" });
    });
  });

  describe("arc state: deleted → discard", () => {
    it("discards message when thread status is deleted", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "deleted" })));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(threadDb.getSignalById).not.toHaveBeenCalled();
      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("logs TRACK with reason deleted", async () => {
      const { handler, threadDb, logger } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "deleted" })));

      await handler.process(MESSAGE);

      const trackCalls = logger.calls.filter((c) => c.method === "track");
      expect(trackCalls).toHaveLength(1);
      expect(trackCalls[0]!.context).toMatchObject({ code: "followup.stale_fire", reason: "deleted" });
    });
  });

  describe("arc state: active → notify only", () => {
    it("sends notification without changing thread status", async () => {
      const { handler, threadDb, notifier } = setup();
      const arc = makeThread({ status: "active", urgency: "high" });
      threadDb.getThread.mockResolvedValue(ok(arc));
      threadDb.getSignalById.mockResolvedValue(ok(makeSignal()));
      vi.mocked(notifier.notify).mockResolvedValue(ok(undefined));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(threadDb.updateThread).not.toHaveBeenCalled();
      expect(notifier.notify).toHaveBeenCalledOnce();
    });

    it("passes reason: followup to notifier", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "active" })));
      threadDb.getSignalById.mockResolvedValue(ok(makeSignal()));
      vi.mocked(notifier.notify).mockResolvedValue(ok(undefined));

      await handler.process(MESSAGE);

      expect(notifier.notify).toHaveBeenCalledWith(
        ACCOUNT_ID,
        expect.objectContaining({ status: "active" }),
        expect.objectContaining({ id: SIGNAL_ID }),
        expect.any(String),
        "followup",
      );
    });
  });

  describe("arc state: archived → reactivate + notify", () => {
    it("updates thread status to active and sends notification", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "archived" })));
      threadDb.getSignalById.mockResolvedValue(ok(makeSignal()));
      threadDb.updateThread.mockResolvedValue(ok(makeThread({ status: "active" })));
      vi.mocked(notifier.notify).mockResolvedValue(ok(undefined));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(threadDb.updateThread).toHaveBeenCalledWith(
        ACCOUNT_ID, ARC_ID, "active", expect.any(String), {},
      );
      expect(notifier.notify).toHaveBeenCalledOnce();
    });

    it("passes reason: followup to notifier after reactivation", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "archived" })));
      threadDb.getSignalById.mockResolvedValue(ok(makeSignal()));
      threadDb.updateThread.mockResolvedValue(ok(makeThread({ status: "active" })));
      vi.mocked(notifier.notify).mockResolvedValue(ok(undefined));

      await handler.process(MESSAGE);

      expect(notifier.notify).toHaveBeenCalledWith(
        ACCOUNT_ID,
        expect.objectContaining({ status: "active" }),
        expect.objectContaining({ id: SIGNAL_ID }),
        expect.any(String),
        "followup",
      );
    });

    it("returns error if updateArc fails", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "archived" })));
      threadDb.getSignalById.mockResolvedValue(ok(makeSignal()));
      threadDb.updateThread.mockResolvedValue(err(dbError("DynamoDB timeout")));

      const result = await handler.process(MESSAGE);

      expect(result.isErr()).toBe(true);
      expect(notifier.notify).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Error propagation
  // ---------------------------------------------------------------------------

  describe("error propagation", () => {
    it("returns error when getArc fails (triggers SQS retry)", async () => {
      const { handler, threadDb } = setup();
      threadDb.getThread.mockResolvedValue(err(dbError("Connection refused")));

      const result = await handler.process(MESSAGE);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    });

    it("returns error when getSignalById fails", async () => {
      const { handler, threadDb } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "active" })));
      threadDb.getSignalById.mockResolvedValue(err(dbError("timeout")));

      const result = await handler.process(MESSAGE);

      expect(result.isErr()).toBe(true);
    });

    it("discards when signal is not found (stale reference)", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "active" })));
      threadDb.getSignalById.mockResolvedValue(ok(null));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(notifier.notify).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Reason: "followup" in all notification cases
  // ---------------------------------------------------------------------------

  describe("reason: followup in all notification paths", () => {
    it("active arc → reason is followup", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "active" })));
      threadDb.getSignalById.mockResolvedValue(ok(makeSignal()));
      vi.mocked(notifier.notify).mockResolvedValue(ok(undefined));

      await handler.process(MESSAGE);

      const reason = vi.mocked(notifier.notify).mock.calls[0]![4];
      expect(reason).toBe("followup");
    });

    it("archived arc → reason is followup", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "archived" })));
      threadDb.getSignalById.mockResolvedValue(ok(makeSignal()));
      threadDb.updateThread.mockResolvedValue(ok(makeThread({ status: "active" })));
      vi.mocked(notifier.notify).mockResolvedValue(ok(undefined));

      await handler.process(MESSAGE);

      const reason = vi.mocked(notifier.notify).mock.calls[0]![4];
      expect(reason).toBe("followup");
    });
  });

  // ---------------------------------------------------------------------------
  // Property 3: Stale-fire only reactivates archived arcs
  // (Deterministic boundary enumeration — all arc states)
  // ---------------------------------------------------------------------------

  describe("Property 3: Stale-fire only reactivates archived arcs", () => {
    /**
     * Validates: Requirements 3.2, 3.3
     *
     * For any signal_followup message referencing an arc, the handler SHALL set
     * the arc to active if and only if the arc exists and its current status is
     * archived. For all other states (null, deleted, active), the handler SHALL
     * discard the message without modification.
     */

    const arcStates: Array<{ label: string; arc: Thread | null; shouldReactivate: boolean; shouldNotify: boolean }> = [
      { label: "null (missing)", arc: null, shouldReactivate: false, shouldNotify: false },
      { label: "deleted", arc: makeThread({ status: "deleted" }), shouldReactivate: false, shouldNotify: false },
      { label: "active", arc: makeThread({ status: "active" }), shouldReactivate: false, shouldNotify: true },
      { label: "archived", arc: makeThread({ status: "archived" }), shouldReactivate: true, shouldNotify: true },
    ];

    it.each(arcStates)(
      "arc state=$label → reactivate=$shouldReactivate, notify=$shouldNotify",
      async ({ arc, shouldReactivate, shouldNotify }) => {
        const { handler, threadDb, notifier } = setup();
        threadDb.getThread.mockResolvedValue(ok(arc));
        threadDb.getSignalById.mockResolvedValue(ok(makeSignal()));
        threadDb.updateThread.mockResolvedValue(ok(makeThread({ status: "active" })));
        vi.mocked(notifier.notify).mockResolvedValue(ok(undefined));

        const result = await handler.process(MESSAGE);

        expect(result.isOk()).toBe(true);

        if (shouldReactivate) {
          expect(threadDb.updateThread).toHaveBeenCalledWith(
            ACCOUNT_ID, ARC_ID, "active", expect.any(String), {},
          );
        } else {
          expect(threadDb.updateThread).not.toHaveBeenCalled();
        }

        if (shouldNotify) {
          expect(notifier.notify).toHaveBeenCalledOnce();
          // Verify reason is always "followup" when notification is sent
          const reason = vi.mocked(notifier.notify).mock.calls[0]![4];
          expect(reason).toBe("followup");
        } else {
          expect(notifier.notify).not.toHaveBeenCalled();
        }
      },
    );

    it("report_violation status → discard without modification", async () => {
      const { handler, threadDb, notifier } = setup();
      threadDb.getThread.mockResolvedValue(ok(makeThread({ status: "report_violation" as ThreadStatus })));
      threadDb.getSignalById.mockResolvedValue(ok(makeSignal()));

      const result = await handler.process(MESSAGE);

      expect(result.isOk()).toBe(true);
      expect(threadDb.updateThread).not.toHaveBeenCalled();
      expect(notifier.notify).not.toHaveBeenCalled();
    });
  });
});
