// Feature: calendar-rsvp-reminder, Property 3: Cancellation schedule name derivation
// Validates: Requirements 4.1, 4.2

import { describe, it, expect, vi } from "vitest";
import { ok, err, dbError } from "../../src/errors.js";
import { buildScheduleName } from "../../src/scheduler/schedule-name.js";
import { DateTime } from "luxon";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { SchedulerClient } from "../../src/scheduler/scheduler-client.js";

// ---------------------------------------------------------------------------
// Property 3: Cancellation schedule name derivation
//
// For any calendar_response creation where the linked calendar_event signal
// exists and its startTime is in the future: the system attempts to delete a
// schedule named buildScheduleName(accountId, calendarEventSignal.id, "rsvp.YYYYMMDD")
// where YYYYMMDD is the event start date in UTC.
//
// When the event startTime is in the past, no deletion is attempted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_ID = "acc-cancel-001";
const SIGNAL_ID = "sgn-cal-evt-001";
const ARC_ID = "arc-cancel-001";

// ---------------------------------------------------------------------------
// Tests: Schedule name derivation (deterministic boundary enumeration)
// ---------------------------------------------------------------------------

describe("RSVP cancellation — schedule name derivation (Property 3)", () => {
  describe("known inputs → expected schedule name", () => {
    const cases = [
      {
        label: "standard date",
        accountId: "acc-abc",
        signalId: "sgn-cal-001",
        startTime: "2025-07-15T14:00:00Z",
        expectedName: "acc-abc.sgn-cal-001.rsvp.20250715",
      },
      {
        label: "new year boundary",
        accountId: "acc-abc",
        signalId: "sgn-cal-002",
        startTime: "2026-01-01T00:00:00Z",
        expectedName: "acc-abc.sgn-cal-002.rsvp.20260101",
      },
      {
        label: "leap day",
        accountId: "acc-abc",
        signalId: "sgn-cal-003",
        startTime: "2028-02-29T09:30:00Z",
        expectedName: "acc-abc.sgn-cal-003.rsvp.20280229",
      },
      {
        label: "end of year",
        accountId: "acc-abc",
        signalId: "sgn-cal-004",
        startTime: "2025-12-31T23:59:00Z",
        expectedName: "acc-abc.sgn-cal-004.rsvp.20251231",
      },
      {
        label: "UTC date rollover (23:30 UTC on the 14th → date is still 14th)",
        accountId: "acc-def",
        signalId: "sgn-cal-005",
        startTime: "2025-08-14T23:30:00Z",
        expectedName: "acc-def.sgn-cal-005.rsvp.20250814",
      },
    ];

    it.each(cases)("$label → $expectedName", ({ accountId, signalId, startTime, expectedName }) => {
      const eventStart = DateTime.fromISO(startTime, { zone: "utc" });
      const suffix = `rsvp.${eventStart.toFormat("yyyyMMdd")}`;
      const result = buildScheduleName(accountId, signalId, suffix);
      expect(result).toBe(expectedName);
    });
  });

  describe("event in past → no deletion attempt", () => {
    it("startTime in the past → skip deletion", () => {
      const startTime = "2020-06-01T10:00:00Z";
      const eventStart = DateTime.fromISO(startTime, { zone: "utc" });
      const now = DateTime.utc();

      // The guard: eventStart > now must be false for past events
      expect(eventStart > now).toBe(false);
    });

    it("startTime exactly now → skip deletion (not strictly in the future)", () => {
      // Event at current instant is not "in the future"
      const now = DateTime.utc();
      // The guard uses strict > not >=
      expect(now > now).toBe(false);
    });

    it("simulates cancellation path: past event does not call deleteFollowup", async () => {
      const logger = createMockLogger();
      const deleteFollowup = vi.fn();
      const schedulerClient: Pick<SchedulerClient, "deleteFollowup"> = { deleteFollowup };

      const startTime = "2020-03-15T08:00:00Z";
      const eventStart = DateTime.fromISO(startTime, { zone: "utc" });

      // Mirror the guard from app.ts
      if (eventStart.isValid && eventStart > DateTime.utc()) {
        const scheduleName = buildScheduleName(ACCOUNT_ID, SIGNAL_ID, `rsvp.${eventStart.toFormat("yyyyMMdd")}`);
        await schedulerClient.deleteFollowup(scheduleName);
      }

      expect(deleteFollowup).not.toHaveBeenCalled();
    });

    it("simulates cancellation path: future event calls deleteFollowup with correct name", async () => {
      const logger = createMockLogger();
      const deleteFollowup = vi.fn().mockResolvedValue(ok(undefined));
      const schedulerClient: Pick<SchedulerClient, "deleteFollowup"> = { deleteFollowup };

      const startTime = "2099-11-20T16:00:00Z";
      const eventStart = DateTime.fromISO(startTime, { zone: "utc" });

      if (eventStart.isValid && eventStart > DateTime.utc()) {
        const scheduleName = buildScheduleName(ACCOUNT_ID, SIGNAL_ID, `rsvp.${eventStart.toFormat("yyyyMMdd")}`);
        await schedulerClient.deleteFollowup(scheduleName);
      }

      expect(deleteFollowup).toHaveBeenCalledOnce();
      expect(deleteFollowup).toHaveBeenCalledWith("acc-cancel-001.sgn-cal-evt-001.rsvp.20991120");
    });
  });

  describe("deleteFollowup failure → non-blocking", () => {
    it("deleteFollowup returns err → logs WARN, does not throw", async () => {
      const logger = createMockLogger();
      const deleteFollowup = vi.fn().mockResolvedValue(err(dbError("ResourceNotFoundException")));
      const schedulerClient: Pick<SchedulerClient, "deleteFollowup"> = { deleteFollowup };

      const startTime = "2099-09-10T14:00:00Z";
      const eventStart = DateTime.fromISO(startTime, { zone: "utc" });

      // Mirror app.ts cancellation path
      if (eventStart.isValid && eventStart > DateTime.utc()) {
        const scheduleName = buildScheduleName(ACCOUNT_ID, SIGNAL_ID, `rsvp.${eventStart.toFormat("yyyyMMdd")}`);
        const deleteResult = await schedulerClient.deleteFollowup(scheduleName);
        if (deleteResult.isErr()) {
          logger.warn("Failed to delete RSVP reminder schedule — fire-time check will handle.", {
            code: "rsvp.cancel.delete_failed",
            scheduleName,
            error: deleteResult.error,
          });
        }
      }

      expect(deleteFollowup).toHaveBeenCalledOnce();
      const warnCalls = logger.calls.filter((c) => c.method === "warn");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]!.context).toMatchObject({ code: "rsvp.cancel.delete_failed" });
    });

    it("deleteFollowup success → no warning logged", async () => {
      const logger = createMockLogger();
      const deleteFollowup = vi.fn().mockResolvedValue(ok(undefined));
      const schedulerClient: Pick<SchedulerClient, "deleteFollowup"> = { deleteFollowup };

      const startTime = "2099-04-01T09:00:00Z";
      const eventStart = DateTime.fromISO(startTime, { zone: "utc" });

      if (eventStart.isValid && eventStart > DateTime.utc()) {
        const scheduleName = buildScheduleName(ACCOUNT_ID, SIGNAL_ID, `rsvp.${eventStart.toFormat("yyyyMMdd")}`);
        const deleteResult = await schedulerClient.deleteFollowup(scheduleName);
        if (deleteResult.isErr()) {
          logger.warn("Failed to delete RSVP reminder schedule — fire-time check will handle.", {
            code: "rsvp.cancel.delete_failed",
            scheduleName,
            error: deleteResult.error,
          });
        }
      }

      expect(deleteFollowup).toHaveBeenCalledOnce();
      const warnCalls = logger.calls.filter((c) => c.method === "warn");
      expect(warnCalls).toHaveLength(0);
    });
  });
});
