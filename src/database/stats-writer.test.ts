import { describe, it, expect } from "vitest";
import { statusToCategory, buildStatsUpdateParams } from "./stats-writer.js";
import type { StatsCategory } from "../types/index.js";

describe("statusToCategory", () => {
  it.each([
    { status: "active", expected: "allowed" },
    { status: "block_hidden", expected: "blocked" },
    { status: "block_reject", expected: "blocked" },
    { status: "violate_report", expected: "violationReport" },
    { status: "quarantine_visible", expected: "quarantined" },
    { status: "quarantine_hidden", expected: "quarantined" },
  ] as const)("maps $status → $expected", ({ status, expected }) => {
    expect(statusToCategory(status)).toBe(expected);
  });

  it("returns null for draft", () => {
    expect(statusToCategory("draft")).toBeNull();
  });
});


describe("buildStatsUpdateParams", () => {
  const now = new Date("2026-05-16T14:30:00.000Z");
  const accountId = "acc-test123";
  const tableName = "ses-accounts";

  it("returns correct Key", () => {
    const params = buildStatsUpdateParams(accountId, "allowed", now, tableName);
    expect(params.Key).toEqual({ pk: "ACCT#acc-test123", sk: "STATS" });
    expect(params.TableName).toBe(tableName);
  });

  it("ADD expression includes totalSignals and category total for allowed", () => {
    const params = buildStatsUpdateParams(accountId, "allowed", now, tableName);
    expect(params.UpdateExpression).toContain("ADD totalSignals :one");
    expect(params.UpdateExpression).toContain("#totalCat :one");
    expect(params.ExpressionAttributeNames["#totalCat"]).toBe("totalAllowed");
  });

  it("ADD expression includes date-prefixed attributes for daily/monthly/yearly", () => {
    const params = buildStatsUpdateParams(accountId, "blocked", now, tableName);
    expect(params.ExpressionAttributeNames["#day"]).toBe("d_2026-05-16_blocked");
    expect(params.ExpressionAttributeNames["#month"]).toBe("m_2026-05_blocked");
    expect(params.ExpressionAttributeNames["#year"]).toBe("y_2026_blocked");
  });

  it("ExpressionAttributeValues has :one = 1 and :now = ISO string", () => {
    const params = buildStatsUpdateParams(accountId, "quarantined", now, tableName);
    expect(params.ExpressionAttributeValues[":one"]).toBe(1);
    expect(params.ExpressionAttributeValues[":now"]).toBe("2026-05-16T14:30:00.000Z");
  });

  it("capitalizes category correctly for violationReport", () => {
    const params = buildStatsUpdateParams(accountId, "violationReport", now, tableName);
    expect(params.ExpressionAttributeNames["#totalCat"]).toBe("totalViolationReport");
    expect(params.ExpressionAttributeNames["#day"]).toBe("d_2026-05-16_violationReport");
  });

  it("SET clause includes updatedAt", () => {
    const params = buildStatsUpdateParams(accountId, "allowed", now, tableName);
    expect(params.UpdateExpression).toContain("SET updatedAt = :now");
  });
});
