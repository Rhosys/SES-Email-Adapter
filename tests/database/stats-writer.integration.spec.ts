import assert from "node:assert/strict";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountDatabase } from "../../src/database/account-database.js";
import { aggregateStatsRows, buildDiffSk, buildSnapshotSk } from "../../src/database/stats-writer.js";
import type { StatsRow, StatsMetric } from "../../src/database/stats-writer.js";

// Mock the DynamoDB shared module
vi.mock("../../src/database/shared.js", () => ({
  ACCOUNTS_TABLE: "test-accounts",
  dynamo: {
    send: vi.fn(),
  },
}));

import { dynamo } from "../../src/database/shared.js";

function condCheckFailed(): Error {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  return e;
}

describe("stats-writer integration (row-per-day design)", () => {
  const mockSend = dynamo.send as ReturnType<typeof vi.fn>;
  let db: AccountDatabase;

  beforeEach(() => {
    mockSend.mockReset();
    db = new AccountDatabase();
  });

  // ---------------------------------------------------------------------------
  // Three-level conditional write (incrementStats / incrementStatMetric)
  // ---------------------------------------------------------------------------

  describe("incrementStats — three-level fallback", () => {
    it("step 1 succeeds: UpdateItem with attribute_exists passes (row already exists)", async () => {
      mockSend.mockResolvedValueOnce({}); // Step 1 succeeds

      const result = await db.incrementStats("acc-test", "allowed");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.ConditionExpression).toBe("attribute_exists(pk)");
      expect(input.UpdateExpression).toContain("ADD #metric :delta");
      expect(input.ExpressionAttributeNames["#metric"]).toBe("metrics.allowed");
      expect(input.ExpressionAttributeValues[":delta"]).toBe(1);
    });

    it("step 1 fails, step 2 succeeds: PutItem creates the row (first signal of day)", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails
        .mockResolvedValueOnce({}); // Step 2 succeeds

      const result = await db.incrementStats("acc-test", "blocked");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2);

      // Step 2 is a PutCommand
      const putInput = mockSend.mock.calls[1]![0].input;
      expect(putInput.ConditionExpression).toBe("attribute_not_exists(pk)");
      expect(putInput.Item.metrics).toEqual({ blocked: 1 });
      expect(putInput.Item.ttl).toBeTypeOf("number");
      expect(putInput.Item.sk).toMatch(/^STATS#\d{4}-\d{2}-\d{2}$/);
    });

    it("steps 1+2 fail, step 3 succeeds: race condition resolved by retry", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails
        .mockRejectedValueOnce(condCheckFailed()) // Step 2 fails (race)
        .mockResolvedValueOnce({}); // Step 3 succeeds

      const result = await db.incrementStats("acc-test", "quarantined");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(3);

      // Step 3 is the same UpdateCommand as step 1
      const retryInput = mockSend.mock.calls[2]![0].input;
      expect(retryInput.ConditionExpression).toBe("attribute_exists(pk)");
      expect(retryInput.ExpressionAttributeNames["#metric"]).toBe("metrics.quarantined");
    });

    it("step 1 fails with non-conditional error → returns err immediately", async () => {
      mockSend.mockRejectedValueOnce(new Error("DDB timeout"));

      const result = await db.incrementStats("acc-test", "allowed");

      expect(result.isErr()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1); // No fallback
    });

    it("step 2 fails with non-conditional error → returns err immediately", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails
        .mockRejectedValueOnce(new Error("DDB throttle")); // Step 2 non-conditional

      const result = await db.incrementStats("acc-test", "allowed");

      expect(result.isErr()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2); // Stops at step 2
    });

    it("step 3 fails → returns err", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed())
        .mockRejectedValueOnce(condCheckFailed())
        .mockRejectedValueOnce(new Error("DDB timeout"));

      const result = await db.incrementStats("acc-test", "allowed");

      expect(result.isErr()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it("PutItem sets TTL to approximately 5 years from now", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed())
        .mockResolvedValueOnce({});

      await db.incrementStats("acc-test", "allowed");
      const putInput = mockSend.mock.calls[1]![0].input;
      const ttl = putInput.Item.ttl as number;
      const fiveYearsFromNow = Math.floor(Date.now() / 1000) + 5 * 365 * 24 * 3600;
      // Within 2 days tolerance (accounts for leap years and timing)
      expect(Math.abs(ttl - fiveYearsFromNow)).toBeLessThan(172800);
    });
  });

  // ---------------------------------------------------------------------------
  // incrementStatMetric — verifies delta and metric forwarding
  // ---------------------------------------------------------------------------

  describe("incrementStatMetric", () => {
    it("sends positive delta for totalAliases", async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await db.incrementStatMetric("acc-test", "totalAliases", 1);
      expect(result.isOk()).toBe(true);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.ExpressionAttributeNames["#metric"]).toBe("metrics.totalAliases");
      expect(input.ExpressionAttributeValues[":delta"]).toBe(1);
    });

    it("sends negative delta for totalAliases decrement", async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await db.incrementStatMetric("acc-test", "totalAliases", -1);
      expect(result.isOk()).toBe(true);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.ExpressionAttributeValues[":delta"]).toBe(-1);
    });

    it("falls through to PutItem when row doesn't exist", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed())
        .mockResolvedValueOnce({});
      const result = await db.incrementStatMetric("acc-test", "totalAliases", 3);
      expect(result.isOk()).toBe(true);
      const putInput = mockSend.mock.calls[1]![0].input;
      expect(putInput.Item.metrics).toEqual({ totalAliases: 3 });
    });
  });

  // ---------------------------------------------------------------------------
  // getStats — query direction and shape
  // ---------------------------------------------------------------------------

  describe("getStats", () => {
    it("queries with ScanIndexForward=false and reverses result to ascending", async () => {
      const rows: StatsRow[] = [
        { pk: "ACCT#x", sk: "STATS#2026-06-15", metrics: { allowed: 5 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-14", metrics: { allowed: 3 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-00-SNAPSHOT", metrics: { allowed: 100, blocked: 20, quarantined: 5, violationReport: 1, totalAliases: 10 } },
      ];
      mockSend.mockResolvedValueOnce({ Items: rows });

      const result = await db.getStats("acc-test");

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Should be reversed to ascending
        expect(result.value[0]!.sk).toBe("STATS#2026-06-00-SNAPSHOT");
        expect(result.value[1]!.sk).toBe("STATS#2026-06-14");
        expect(result.value[2]!.sk).toBe("STATS#2026-06-15");
      }

      const input = mockSend.mock.calls[0]![0].input;
      expect(input.ScanIndexForward).toBe(false);
      expect(input.Limit).toBe(400);
    });

    it("returns empty array when no stats rows exist", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });
      const result = await db.getStats("acc-test");
      expect(result.isOk()).toBe(true);
      if (result.isOk()) expect(result.value).toEqual([]);
    });

    it("returns err on DynamoDB failure", async () => {
      mockSend.mockRejectedValueOnce(new Error("DDB timeout"));
      const result = await db.getStats("acc-test");
      expect(result.isErr()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // writeSnapshot
  // ---------------------------------------------------------------------------

  describe("writeSnapshot", () => {
    it("writes a snapshot with correct SK format and all metrics", async () => {
      mockSend.mockResolvedValueOnce({});
      const metrics = { allowed: 500, blocked: 50, quarantined: 10, violationReport: 3, totalAliases: 25 } satisfies Record<StatsMetric, number>;

      const result = await db.writeSnapshot("acc-test", "2026-07", metrics);

      expect(result.isOk()).toBe(true);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.Item.pk).toBe("ACCT#acc-test");
      expect(input.Item.sk).toBe("STATS#2026-07-00-SNAPSHOT");
      expect(input.Item.metrics).toEqual(metrics);
    });

    it("snapshot rows have no TTL (kept indefinitely)", async () => {
      mockSend.mockResolvedValueOnce({});
      const metrics = { allowed: 0, blocked: 0, quarantined: 0, violationReport: 0, totalAliases: 0 } satisfies Record<StatsMetric, number>;
      await db.writeSnapshot("acc-test", "2026-07", metrics);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.Item.ttl).toBeUndefined();
    });

    it("returns err on DynamoDB failure", async () => {
      mockSend.mockRejectedValueOnce(new Error("DDB timeout"));
      const metrics = { allowed: 0, blocked: 0, quarantined: 0, violationReport: 0, totalAliases: 0 } satisfies Record<StatsMetric, number>;
      const result = await db.writeSnapshot("acc-test", "2026-07", metrics);
      expect(result.isErr()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end: getStats → aggregateStatsRows → API response
  // ---------------------------------------------------------------------------

  describe("end-to-end aggregation scenarios", () => {
    it("new account with only a few recent diffs (no snapshots)", async () => {
      const rows: StatsRow[] = [
        { pk: "ACCT#x", sk: "STATS#2026-06-15", metrics: { allowed: 2, totalAliases: 1 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-14", metrics: { allowed: 3 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-13", metrics: { allowed: 1, blocked: 1 }, ttl: 99 },
      ];
      // DDB returns descending
      mockSend.mockResolvedValueOnce({ Items: rows });

      const result = await db.getStats("acc-new");
      assert(result.isOk());
      const response = aggregateStatsRows(result.value);

      expect(response.totals).toEqual({ allowed: 6, blocked: 1, quarantined: 0, totalAliases: 1 });
      expect(response.daily).toHaveLength(3);
      expect(response.daily[0]!.date).toBe("2026-06-15");
      expect(response.monthly).toHaveLength(1);
      expect(response.monthly[0]!.date).toBe("2026-06");
    });

    it("mature account with snapshot + current month diffs", async () => {
      const rows: StatsRow[] = [
        { pk: "ACCT#x", sk: "STATS#2026-06-15", metrics: { allowed: 5, blocked: 1 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-01", metrics: { allowed: 10, totalAliases: 2 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-00-SNAPSHOT", metrics: { allowed: 1000, blocked: 200, quarantined: 50, violationReport: 5, totalAliases: 30 } },
      ];
      mockSend.mockResolvedValueOnce({ Items: rows });

      const result = await db.getStats("acc-mature");
      assert(result.isOk());
      const response = aggregateStatsRows(result.value);

      expect(response.totals).toEqual({ allowed: 1015, blocked: 201, quarantined: 50, totalAliases: 32 });
    });

    it("account with missing current month snapshot uses previous month snapshot", async () => {
      // It's July, but only May snapshot exists + June & July diffs
      const rows: StatsRow[] = [
        { pk: "ACCT#x", sk: "STATS#2026-07-01", metrics: { allowed: 3 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-10", metrics: { allowed: 30, blocked: 5 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-05-15", metrics: { allowed: 20 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-05-00-SNAPSHOT", metrics: { allowed: 500, blocked: 100, quarantined: 20, violationReport: 2, totalAliases: 15 } },
      ];
      mockSend.mockResolvedValueOnce({ Items: rows });

      const result = await db.getStats("acc-test");
      assert(result.isOk());
      const response = aggregateStatsRows(result.value);

      // totals = snapshot(500,100,20,_,15) + diffs from 2026-05 onward (20+30+3, 5, 0, _, 0)
      expect(response.totals).toEqual({ allowed: 553, blocked: 105, quarantined: 20, totalAliases: 15 });
      expect(response.daily).toHaveLength(3);
      expect(response.monthly).toHaveLength(3); // May, June, July
    });

    it("no rows at all → zeroed response", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });
      const result = await db.getStats("acc-empty");
      assert(result.isOk());
      const response = aggregateStatsRows(result.value);
      expect(response.totals).toEqual({ allowed: 0, blocked: 0, quarantined: 0, totalAliases: 0 });
      expect(response.daily).toEqual([]);
      expect(response.monthly).toEqual([]);
    });
  });
});
