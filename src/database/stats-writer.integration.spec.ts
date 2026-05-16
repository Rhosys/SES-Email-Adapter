import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "../errors.js";
import { AccountDatabase } from "./account-database.js";
import { parseStatsRow } from "./stats-writer.js";

// Mock the DynamoDB shared module
vi.mock("./shared.js", () => ({
  ACCOUNTS_TABLE: "test-accounts",
  dynamo: {
    send: vi.fn(),
  },
}));

import { dynamo } from "./shared.js";

describe("stats-writer integration", () => {
  const mockSend = dynamo.send as ReturnType<typeof vi.fn>;
  let db: AccountDatabase;

  beforeEach(() => {
    mockSend.mockReset();
    db = new AccountDatabase();
  });

  describe("incrementStats", () => {
    it("sends UpdateCommand with correct params for allowed category", async () => {
      mockSend.mockResolvedValue({});

      const result = await db.incrementStats("acc-test123", "allowed");

      expect(result.isOk()).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);

      const command = mockSend.mock.calls[0]![0];
      const input = command.input;

      expect(input.TableName).toBe("test-accounts");
      expect(input.Key).toEqual({ pk: "ACCT#acc-test123", sk: "STATS" });
      expect(input.UpdateExpression).toContain("ADD totalSignals :one");
      expect(input.UpdateExpression).toContain("#totalCat :one");
      expect(input.UpdateExpression).toContain("SET updatedAt = :now");
      expect(input.UpdateExpression).toContain("REMOVE");
      expect(input.ExpressionAttributeNames["#totalCat"]).toBe("totalAllowed");
      expect(input.ExpressionAttributeValues[":one"]).toBe(1);
    });

    it("sends UpdateCommand with correct params for blocked category", async () => {
      mockSend.mockResolvedValue({});

      const result = await db.incrementStats("acc-test123", "blocked");

      expect(result.isOk()).toBe(true);
      const command = mockSend.mock.calls[0]![0];
      const input = command.input;
      expect(input.ExpressionAttributeNames["#totalCat"]).toBe("totalBlocked");
    });

    it("sends UpdateCommand with correct params for quarantined category", async () => {
      mockSend.mockResolvedValue({});

      const result = await db.incrementStats("acc-test123", "quarantined");

      expect(result.isOk()).toBe(true);
      const command = mockSend.mock.calls[0]![0];
      const input = command.input;
      expect(input.ExpressionAttributeNames["#totalCat"]).toBe("totalQuarantined");
    });

    it("sends UpdateCommand with correct params for violationReport category", async () => {
      mockSend.mockResolvedValue({});

      const result = await db.incrementStats("acc-test123", "violationReport");

      expect(result.isOk()).toBe(true);
      const command = mockSend.mock.calls[0]![0];
      const input = command.input;
      expect(input.ExpressionAttributeNames["#totalCat"]).toBe("totalViolationReport");
    });

    it("returns err on DynamoDB failure", async () => {
      mockSend.mockRejectedValue(new Error("DDB timeout"));

      const result = await db.incrementStats("acc-test123", "allowed");

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe("db_error");
      }
    });
  });

  describe("getStats", () => {
    it("returns null when no stats row exists", async () => {
      mockSend.mockResolvedValue({ Item: undefined });

      const result = await db.getStats("acc-test123");

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toBeNull();
      }

      const command = mockSend.mock.calls[0]![0];
      const input = command.input;
      expect(input.TableName).toBe("test-accounts");
      expect(input.Key).toEqual({ pk: "ACCT#acc-test123", sk: "STATS" });
    });

    it("returns raw item when stats row exists", async () => {
      const item = {
        pk: "ACCT#acc-test123",
        sk: "STATS",
        totalSignals: 42,
        totalAllowed: 30,
        totalBlocked: 10,
        totalQuarantined: 2,
        totalViolationReport: 0,
        "d_2026-05-16_allowed": 5,
        "m_2026-05_allowed": 20,
        "y_2026_allowed": 30,
        updatedAt: "2026-05-16T14:00:00.000Z",
      };
      mockSend.mockResolvedValue({ Item: item });

      const result = await db.getStats("acc-test123");

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual(item);

        // Verify parseStatsRow produces correct output from the raw item
        const parsed = parseStatsRow(result.value);
        expect(parsed.lifetime.totalSignals).toBe(42);
        expect(parsed.lifetime.totalAllowed).toBe(30);
        expect(parsed.lifetime.totalBlocked).toBe(10);
        expect(parsed.daily).toHaveLength(1);
        expect(parsed.daily[0]!.date).toBe("2026-05-16");
        expect(parsed.daily[0]!.allowed).toBe(5);
        expect(parsed.monthly).toHaveLength(1);
        expect(parsed.monthly[0]!.month).toBe("2026-05");
        expect(parsed.yearly).toHaveLength(1);
        expect(parsed.yearly[0]!.year).toBe("2026");
      }
    });

    it("returns err on DynamoDB failure", async () => {
      mockSend.mockRejectedValue(new Error("DDB timeout"));

      const result = await db.getStats("acc-test123");

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe("db_error");
      }
    });
  });
});
