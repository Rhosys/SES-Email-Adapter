import assert from "node:assert/strict";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountDatabase } from "../../src/database/account-database.js";
import { aggregateStatsRows, buildDiffSk, buildSnapshotSk } from "../../src/database/stats-writer.js";
import type { StatsRow, StatsMetric } from "../../src/database/stats-writer.js";
import { createMockLogger } from "../helpers/mock-logger.js";

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

/** trimHistory GetItem returning short history (no REMOVE needed) */
function trimHistoryGet() {
  return { Item: { history: [] } };
}

describe("stats-writer integration (row-per-day design)", () => {
  const mockSend = dynamo.send as ReturnType<typeof vi.fn>;
  let db: AccountDatabase;

  beforeEach(() => {
    mockSend.mockReset();
    db = new AccountDatabase(createMockLogger());
  });

  // ---------------------------------------------------------------------------
  // Three-level conditional write with idempotency (incrementStatMetric)
  // ---------------------------------------------------------------------------

  describe("incrementStatMetric — three-level fallback with idempotency", () => {
    it("step 1 succeeds: UpdateItem passes (row exists, key not in history)", async () => {
      mockSend
        .mockResolvedValueOnce({}) // Step 1 UpdateItem succeeds
        .mockResolvedValueOnce(trimHistoryGet()); // trimHistory GetItem

      const result = await db.incrementStatMetric("acc-test", "allowed", 1, "idem-key-1");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.ConditionExpression).toBe("attribute_exists(pk) AND NOT contains(history, :key)");
      expect(input.UpdateExpression).toContain("ADD #metrics.#metricName :delta");
      expect(input.UpdateExpression).toContain("list_append(history, :keyList)");
      expect(input.ExpressionAttributeNames["#metricName"]).toBe("allowed");
      expect(input.ExpressionAttributeValues[":delta"]).toBe(1);
      expect(input.ExpressionAttributeValues[":key"]).toBe("idem-key-1");
      expect(input.ExpressionAttributeValues[":keyList"]).toEqual(["idem-key-1"]);
    });

    it("step 1 fails, GetItem shows row exists but key NOT in history → retry UpdateItem succeeds", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails
        .mockResolvedValueOnce({ Item: { history: ["other-key"] } }) // GetItem: row exists, key not in history
        .mockResolvedValueOnce({}) // Retry UpdateItem succeeds
        .mockResolvedValueOnce(trimHistoryGet()); // trimHistory GetItem

      const result = await db.incrementStatMetric("acc-test", "blocked", 1, "idem-key-2");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(4);
      // Retry UpdateItem has same condition
      const retryInput = mockSend.mock.calls[2]![0].input;
      expect(retryInput.ConditionExpression).toBe("attribute_exists(pk) AND NOT contains(history, :key)");
      expect(retryInput.ExpressionAttributeValues[":key"]).toBe("idem-key-2");
    });

    it("step 1 fails, GetItem shows key already in history → deduplicated, returns ok", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails
        .mockResolvedValueOnce({ Item: { history: ["idem-key-dup"] } }); // GetItem: key in history

      const result = await db.incrementStatMetric("acc-test", "allowed", 1, "idem-key-dup");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2); // No further writes
    });

    it("step 1 fails, GetItem returns no Item → PutItem succeeds (row doesn't exist)", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails
        .mockResolvedValueOnce({ Item: undefined }) // GetItem: no row
        .mockResolvedValueOnce({}); // PutItem succeeds

      const result = await db.incrementStatMetric("acc-test", "quarantined", 1, "idem-key-new");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(3);
      // PutItem includes history
      const putInput = mockSend.mock.calls[2]![0].input;
      expect(putInput.ConditionExpression).toBe("attribute_not_exists(pk)");
      expect(putInput.Item.history).toEqual(["idem-key-new"]);
      expect(putInput.Item.metrics).toEqual({ quarantined: 1 });
      expect(putInput.Item.ttl).toBeTypeOf("number");
    });

    it("step 1 fails, GetItem returns no Item, PutItem fails (race) → final retry UpdateItem succeeds", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails
        .mockResolvedValueOnce({ Item: undefined }) // GetItem: no row
        .mockRejectedValueOnce(condCheckFailed()) // PutItem fails (race)
        .mockResolvedValueOnce({}) // Final retry UpdateItem succeeds
        .mockResolvedValueOnce(trimHistoryGet()); // trimHistory GetItem

      const result = await db.incrementStatMetric("acc-test", "allowed", 1, "idem-key-race");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(5);
      // Final retry is UpdateItem with idempotency condition
      const retryInput = mockSend.mock.calls[3]![0].input;
      expect(retryInput.ConditionExpression).toBe("attribute_exists(pk) AND NOT contains(history, :key)");
      expect(retryInput.ExpressionAttributeValues[":key"]).toBe("idem-key-race");
    });

    it("step 1 fails with non-ConditionalCheckFailed error → returns err immediately", async () => {
      mockSend.mockRejectedValueOnce(new Error("DDB timeout"));

      const result = await db.incrementStatMetric("acc-test", "allowed", 1, "idem-key-x");

      expect(result.isErr()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("deduplication: same key already in history → ok returned, no metric increment", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails (key already there)
        .mockResolvedValueOnce({ Item: { history: ["already-seen"] } }); // GetItem confirms dedup

      const result = await db.incrementStatMetric("acc-test", "allowed", 1, "already-seen");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(2); // No further writes after dedup
    });

    it("PutItem sets TTL to approximately 5 years from now", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails
        .mockResolvedValueOnce({ Item: undefined }) // GetItem: no row
        .mockResolvedValueOnce({}); // PutItem succeeds

      await db.incrementStatMetric("acc-test", "allowed", 1, "idem-ttl");
      const putInput = mockSend.mock.calls[2]![0].input;
      const ttl = putInput.Item.ttl as number;
      const fiveYearsFromNow = Math.floor(Date.now() / 1000) + 5 * 365 * 24 * 3600;
      // Within 2 days tolerance
      expect(Math.abs(ttl - fiveYearsFromNow)).toBeLessThan(172800);
    });
  });

  // ---------------------------------------------------------------------------
  // incrementStatMetric — verifies delta and idempotencyKey forwarding
  // ---------------------------------------------------------------------------

  describe("incrementStatMetric", () => {
    it("sends positive delta for totalAliases", async () => {
      mockSend
        .mockResolvedValueOnce({}) // UpdateItem succeeds
        .mockResolvedValueOnce(trimHistoryGet()); // trimHistory

      const result = await db.incrementStatMetric("acc-test", "totalAliases", 1, "idem-pos");
      expect(result.isOk()).toBe(true);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.ExpressionAttributeNames["#metricName"]).toBe("totalAliases");
      expect(input.ExpressionAttributeValues[":delta"]).toBe(1);
      expect(input.ExpressionAttributeValues[":key"]).toBe("idem-pos");
    });

    it("sends negative delta for totalAliases decrement", async () => {
      mockSend
        .mockResolvedValueOnce({}) // UpdateItem succeeds
        .mockResolvedValueOnce(trimHistoryGet()); // trimHistory

      const result = await db.incrementStatMetric("acc-test", "totalAliases", -1, "idem-neg");
      expect(result.isOk()).toBe(true);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.ExpressionAttributeValues[":delta"]).toBe(-1);
    });

    it("falls through to PutItem when row doesn't exist", async () => {
      mockSend
        .mockRejectedValueOnce(condCheckFailed()) // Step 1 fails
        .mockResolvedValueOnce({ Item: undefined }) // GetItem: no row
        .mockResolvedValueOnce({}); // PutItem succeeds

      const result = await db.incrementStatMetric("acc-test", "totalAliases", 3, "idem-put");
      expect(result.isOk()).toBe(true);
      const putInput = mockSend.mock.calls[2]![0].input;
      expect(putInput.Item.metrics).toEqual({ totalAliases: 3 });
      expect(putInput.Item.history).toEqual(["idem-put"]);
    });

    it("idempotencyKey is forwarded correctly", async () => {
      mockSend
        .mockResolvedValueOnce({}) // UpdateItem succeeds
        .mockResolvedValueOnce(trimHistoryGet()); // trimHistory

      await db.incrementStatMetric("acc-test", "blocked", 5, "custom-key-123");
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.ExpressionAttributeValues[":key"]).toBe("custom-key-123");
      expect(input.ExpressionAttributeValues[":keyList"]).toEqual(["custom-key-123"]);
    });
  });

  // ---------------------------------------------------------------------------
  // getStats — query direction and shape
  // ---------------------------------------------------------------------------

  describe("getStats", () => {
    it("queries with ScanIndexForward=false and reverses result to ascending (no fromSk)", async () => {
      const rows: StatsRow[] = [
        { pk: "ACCT#x", sk: "STATS#2026-06-15", metrics: { allowed: 5 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-14", metrics: { allowed: 3 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-00-SNAPSHOT", metrics: { allowed: 100, blocked: 20, quarantined: 5, reported: 1, totalAliases: 10 } },
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

    it("queries with ScanIndexForward=true when fromSk provided, no reverse", async () => {
      const rows: StatsRow[] = [
        { pk: "ACCT#x", sk: "STATS#2026-06-14", metrics: { allowed: 3 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-15", metrics: { allowed: 5 }, ttl: 99 },
      ];
      mockSend.mockResolvedValueOnce({ Items: rows });

      const result = await db.getStats("acc-test", "STATS#2026-06-14");

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Not reversed — already ascending
        expect(result.value[0]!.sk).toBe("STATS#2026-06-14");
        expect(result.value[1]!.sk).toBe("STATS#2026-06-15");
      }

      const input = mockSend.mock.calls[0]![0].input;
      expect(input.ScanIndexForward).toBe(true);
      expect(input.Limit).toBeUndefined();
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
      const metrics = { allowed: 500, blocked: 50, quarantined: 10, reported: 3, totalAliases: 25 } satisfies Record<StatsMetric, number>;

      const result = await db.writeSnapshot("acc-test", "2026-07", metrics);

      expect(result.isOk()).toBe(true);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.Item.pk).toBe("ACCT#acc-test");
      expect(input.Item.sk).toBe("STATS#2026-07-00-SNAPSHOT");
      expect(input.Item.metrics).toEqual(metrics);
    });

    it("snapshot rows have no TTL (kept indefinitely)", async () => {
      mockSend.mockResolvedValueOnce({});
      const metrics = { allowed: 0, blocked: 0, quarantined: 0, reported: 0, totalAliases: 0 } satisfies Record<StatsMetric, number>;
      await db.writeSnapshot("acc-test", "2026-07", metrics);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.Item.ttl).toBeUndefined();
    });

    it("returns err on DynamoDB failure", async () => {
      mockSend.mockRejectedValueOnce(new Error("DDB timeout"));
      const metrics = { allowed: 0, blocked: 0, quarantined: 0, reported: 0, totalAliases: 0 } satisfies Record<StatsMetric, number>;
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

      expect(response.totals).toEqual({ allowed: 6, blocked: 1, quarantined: 0, aliases: 1 });
      expect(response.daily).toHaveLength(3);
      expect(response.daily[0]!.date).toBe("2026-06-15");
      expect(response.monthly).toHaveLength(1);
      expect(response.monthly[0]!.date).toBe("2026-06");
    });

    it("mature account with snapshot + current month diffs", async () => {
      const rows: StatsRow[] = [
        { pk: "ACCT#x", sk: "STATS#2026-06-15", metrics: { allowed: 5, blocked: 1 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-01", metrics: { allowed: 10, totalAliases: 2 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-00-SNAPSHOT", metrics: { allowed: 1000, blocked: 200, quarantined: 50, reported: 5, totalAliases: 30 } },
      ];
      mockSend.mockResolvedValueOnce({ Items: rows });

      const result = await db.getStats("acc-mature");
      assert(result.isOk());
      const response = aggregateStatsRows(result.value);

      expect(response.totals).toEqual({ allowed: 1015, blocked: 201, quarantined: 50, aliases: 32 });
    });

    it("account with missing current month snapshot uses previous month snapshot", async () => {
      const rows: StatsRow[] = [
        { pk: "ACCT#x", sk: "STATS#2026-07-01", metrics: { allowed: 3 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-06-10", metrics: { allowed: 30, blocked: 5 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-05-15", metrics: { allowed: 20 }, ttl: 99 },
        { pk: "ACCT#x", sk: "STATS#2026-05-00-SNAPSHOT", metrics: { allowed: 500, blocked: 100, quarantined: 20, reported: 2, totalAliases: 15 } },
      ];
      mockSend.mockResolvedValueOnce({ Items: rows });

      const result = await db.getStats("acc-test");
      assert(result.isOk());
      const response = aggregateStatsRows(result.value);

      // totals = snapshot(500,100,20,_,15) + diffs from 2026-05 onward (20+30+3, 5, 0, _, 0)
      expect(response.totals).toEqual({ allowed: 553, blocked: 105, quarantined: 20, aliases: 15 });
      expect(response.daily).toHaveLength(3);
      expect(response.monthly).toHaveLength(3); // May, June, July
    });

    it("no rows at all → zeroed response", async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });
      const result = await db.getStats("acc-empty");
      assert(result.isOk());
      const response = aggregateStatsRows(result.value);
      expect(response.totals).toEqual({ allowed: 0, blocked: 0, quarantined: 0, aliases: 0 });
      expect(response.daily).toEqual([]);
      expect(response.monthly).toEqual([]);
    });
  });
});
