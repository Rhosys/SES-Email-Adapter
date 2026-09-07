import { describe, it, expect } from "vitest";
import { collapseCalendarSignals } from "../../src/api/calendar-collapse.js";
import type { Signal } from "../../src/types/index.js";
import type { CalendarEventData } from "../../src/types/calendar.js";

function cal(overrides: {
  id: string;
  veventUid?: string;
  method?: string;
  sequence?: number;
  createdAt?: string;
  data?: Partial<CalendarEventData>;
}): Signal<CalendarEventData> {
  const veventUid = overrides.veventUid ?? "uid-1";
  return {
    id: overrides.id,
    signalLookupId: `lookup-${overrides.id}`,
    threadId: "thr-1",
    accountId: "acct-1",
    source: "signal",
    type: "calendar_event",
    status: "active",
    labels: [],
    createdAt: overrides.createdAt ?? "2025-03-15T09:00:00Z",
    data: {
      title: "Standup",
      startTime: "2025-03-15T10:00:00Z",
      endTime: "2025-03-15T10:30:00Z",
      location: "Room A",
      organizer: "alice@example.com",
      attendees: [],
      veventUid,
      originalVeventUid: veventUid,
      method: overrides.method ?? "REQUEST",
      sequence: overrides.sequence ?? 0,
      linkedSignalId: "sgn-email-1",
      ...overrides.data,
    },
  };
}

describe("collapseCalendarSignals", () => {
  it("single invite: winner with no enrichment, nothing superseded, no orphans", () => {
    const result = collapseCalendarSignals([cal({ id: "s1" })]);
    expect(result.winners.get("s1")).toEqual({});
    expect(result.superseded.size).toBe(0);
    expect(result.orphans).toEqual([]);
  });

  it("update with prior: latest wins, prior superseded, previousValues holds only changed fields", () => {
    const invite = cal({ id: "s1", sequence: 0, createdAt: "2025-03-15T09:00:00Z" });
    const update = cal({
      id: "s2", sequence: 1, createdAt: "2025-03-16T09:00:00Z",
      data: { startTime: "2025-03-15T11:00:00Z", location: "Room A" }, // startTime changed, location same
    });

    const result = collapseCalendarSignals([invite, update]);

    expect(result.superseded.has("s1")).toBe(true);
    expect(result.winners.has("s2")).toBe(true);
    expect(result.winners.get("s2")).toEqual({
      previousValues: { changedAt: "2025-03-16T09:00:00Z", startTime: "2025-03-15T10:00:00Z" },
    });
    expect(result.orphans).toEqual([]);
  });

  it("update with prior but no field actually changed: winner has no previousValues", () => {
    const invite = cal({ id: "s1", sequence: 0 });
    const update = cal({ id: "s2", sequence: 1, createdAt: "2025-03-16T09:00:00Z" }); // identical display fields

    const result = collapseCalendarSignals([invite, update]);
    expect(result.winners.get("s2")).toEqual({});
    expect(result.orphans).toEqual([]);
  });

  it("update without prior in loaded set: orphan reported, best-effort winner with no diff", () => {
    const update = cal({ id: "s2", sequence: 3, createdAt: "2025-03-16T09:00:00Z" });

    const result = collapseCalendarSignals([update]);

    expect(result.winners.get("s2")).toEqual({});
    expect(result.orphans).toEqual([
      { veventUid: "uid-1", signalId: "s2", method: "REQUEST", sequence: 3, reason: "update_without_prior" },
    ]);
  });

  it("cancellation with prior: cancelledAt set from CANCEL, prior superseded, no orphan", () => {
    const invite = cal({ id: "s1", sequence: 0, createdAt: "2025-03-15T09:00:00Z" });
    const cancel = cal({ id: "s2", method: "CANCEL", sequence: 1, createdAt: "2025-03-16T09:00:00Z", data: { status: "CANCELLED" } });

    const result = collapseCalendarSignals([invite, cancel]);

    expect(result.superseded.has("s1")).toBe(true);
    expect(result.winners.get("s2")).toEqual({ cancelledAt: "2025-03-16T09:00:00Z" });
    expect(result.orphans).toEqual([]);
  });

  it("cancellation without prior: cancelledAt still set, orphan reported", () => {
    const cancel = cal({ id: "s2", method: "CANCEL", sequence: 0, createdAt: "2025-03-16T09:00:00Z" });

    const result = collapseCalendarSignals([cancel]);

    expect(result.winners.get("s2")).toEqual({ cancelledAt: "2025-03-16T09:00:00Z" });
    expect(result.orphans).toEqual([
      { veventUid: "uid-1", signalId: "s2", method: "CANCEL", sequence: 0, reason: "cancellation_without_prior" },
    ]);
  });

  it("cancellation supersedes an update: cancelled wins, no previousValues diff computed", () => {
    const invite = cal({ id: "s1", sequence: 0, createdAt: "2025-03-15T09:00:00Z" });
    const update = cal({ id: "s2", sequence: 1, createdAt: "2025-03-16T09:00:00Z", data: { startTime: "2025-03-15T11:00:00Z" } });
    const cancel = cal({ id: "s3", method: "CANCEL", sequence: 2, createdAt: "2025-03-17T09:00:00Z" });

    const result = collapseCalendarSignals([invite, update, cancel]);

    expect(result.superseded.has("s1")).toBe(true);
    expect(result.superseded.has("s2")).toBe(true);
    expect(result.winners.get("s3")).toEqual({ cancelledAt: "2025-03-17T09:00:00Z" });
  });

  it("groups independent events by veventUid, each collapsed separately", () => {
    const a1 = cal({ id: "a1", veventUid: "uid-A", sequence: 0 });
    const a2 = cal({ id: "a2", veventUid: "uid-A", sequence: 1, createdAt: "2025-03-16T09:00:00Z", data: { location: "Room B" } });
    const b1 = cal({ id: "b1", veventUid: "uid-B", sequence: 0 });

    const result = collapseCalendarSignals([a1, a2, b1]);

    expect(result.superseded.has("a1")).toBe(true);
    expect(result.winners.has("a2")).toBe(true);
    expect(result.winners.has("b1")).toBe(true);
    expect(result.winners.get("a2")).toEqual({
      previousValues: { changedAt: "2025-03-16T09:00:00Z", location: "Room A" },
    });
    expect(result.orphans).toEqual([]);
  });

  it("orders by sequence, not array position: out-of-order input still picks highest sequence", () => {
    const update = cal({ id: "s2", sequence: 2, createdAt: "2025-03-17T09:00:00Z", data: { title: "Renamed" } });
    const invite = cal({ id: "s1", sequence: 0, createdAt: "2025-03-15T09:00:00Z" });

    const result = collapseCalendarSignals([update, invite]); // winner listed first

    expect(result.winners.has("s2")).toBe(true);
    expect(result.superseded.has("s1")).toBe(true);
    expect(result.winners.get("s2")).toEqual({
      previousValues: { changedAt: "2025-03-17T09:00:00Z", title: "Standup" },
    });
  });
});
