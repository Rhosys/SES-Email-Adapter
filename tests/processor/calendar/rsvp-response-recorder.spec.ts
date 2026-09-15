import { describe, it, expect, beforeEach } from "vitest";
import { recordRsvpResponse } from "../../../src/processor/calendar/rsvp-response-recorder.js";
import type { RsvpResponseStore } from "../../../src/processor/calendar/rsvp-response-recorder.js";
import { ok, err, dbError } from "../../../src/errors.js";
import type { Signal, CalendarResponseData } from "../../../src/types/index.js";

// ---------------------------------------------------------------------------
// recordRsvpResponse — the single writer of a calendar_response, shared by the
// API path (dashboard RSVP) and the relay path (inbound REPLY). Both callers
// converge here so the persisted record is IDENTICAL in shape regardless of
// entry point. The record is append-only history keyed for read by veventUid +
// respondedAt; linkedSignalId is the collapsed WINNER calendar_event id (the
// event's current state — what we actually responded to).
// ---------------------------------------------------------------------------

function makeStore(): RsvpResponseStore & { saved: Signal<CalendarResponseData>[] } {
  const saved: Signal<CalendarResponseData>[] = [];
  return {
    saved,
    saveSignal: async (signal: Signal<CalendarResponseData>) => { saved.push(signal); return ok(undefined); },
  };
}

const FIXED_NOW = "2025-03-15T12:00:00.000Z";
let idCounter = 0;
const fakeGenerateId = () => `sgn-fixed-${++idCounter}`;

describe("recordRsvpResponse — shared calendar_response writer", () => {
  beforeEach(() => { idCounter = 0; });

  it("persists a calendar_response with veventUid, decision, respondedAt, and winner id as linkedSignalId", async () => {
    const store = makeStore();

    const result = await recordRsvpResponse({
      store,
      accountId: "acct-1",
      threadId: "thr-1",
      veventUid: "uid-event-1",
      decision: "accepted",
      winnerSignalId: "sgn-cal-winner",
      now: FIXED_NOW,
      generateId: fakeGenerateId,
    });

    expect(result.isOk()).toBe(true);
    expect(store.saved).toHaveLength(1);
    const signal = store.saved[0]!;
    expect(signal.type).toBe("calendar_response");
    expect(signal.source).toBe("user");
    expect(signal.threadId).toBe("thr-1");
    expect(signal.accountId).toBe("acct-1");
    expect(signal.data.decision).toBe("accepted");
    expect(signal.data.veventUid).toBe("uid-event-1");
    expect(signal.data.respondedAt).toBe(FIXED_NOW);
    // linkedSignalId is the collapsed winner's real calendar_event id — NOT a
    // fabricated cal-{organizer}-{uid} string, NOT the caller-referenced signal.
    expect(signal.data.linkedSignalId).toBe("sgn-cal-winner");
    expect(signal.data.sendStatus).toBe("sent");
  });

  it("produces an IDENTICAL data shape whichever caller invokes it (cross-path convergence)", async () => {
    // Same event, same decision, same winner — the two entry points must yield the
    // same persisted data payload. Only the fresh signal id differs (append-only).
    const apiStore = makeStore();
    const relayStore = makeStore();
    const args = {
      accountId: "acct-1",
      threadId: "thr-1",
      veventUid: "uid-event-1",
      decision: "declined" as const,
      winnerSignalId: "sgn-cal-winner",
      now: FIXED_NOW,
      generateId: fakeGenerateId,
    };

    await recordRsvpResponse({ store: apiStore, ...args });
    await recordRsvpResponse({ store: relayStore, ...args });

    expect(apiStore.saved[0]!.data).toEqual(relayStore.saved[0]!.data);
  });

  it("appends a new signal each call (history), never reusing the id", async () => {
    const store = makeStore();
    const args = {
      store,
      accountId: "acct-1",
      threadId: "thr-1",
      veventUid: "uid-event-1",
      decision: "accepted" as const,
      winnerSignalId: "sgn-cal-winner",
      now: FIXED_NOW,
      generateId: fakeGenerateId,
    };

    await recordRsvpResponse(args);
    await recordRsvpResponse({ ...args, decision: "declined", now: "2025-03-15T13:00:00.000Z" });

    expect(store.saved).toHaveLength(2);
    expect(store.saved[0]!.id).not.toBe(store.saved[1]!.id);
    expect(store.saved[0]!.data.decision).toBe("accepted");
    expect(store.saved[1]!.data.decision).toBe("declined");
  });

  it("propagates a store save failure as err", async () => {
    const store: RsvpResponseStore = {
      saveSignal: async () => err(dbError("throttled")),
    };

    const result = await recordRsvpResponse({
      store,
      accountId: "acct-1",
      threadId: "thr-1",
      veventUid: "uid-event-1",
      decision: "accepted",
      winnerSignalId: "sgn-cal-winner",
      now: FIXED_NOW,
      generateId: fakeGenerateId,
    });

    expect(result.isErr()).toBe(true);
  });
});
