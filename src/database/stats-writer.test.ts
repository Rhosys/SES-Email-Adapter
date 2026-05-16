import { describe, it, expect } from "vitest";
import { statusToCategory, buildStatsUpdateParams, buildPruneNames } from "./stats-writer.js";
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

describe("buildPruneNames", () => {
  const now = new Date("2026-05-16T14:30:00.000Z");
  const categories = ["allowed", "blocked", "quarantined", "violationReport"] as const;

  it("returns attribute names for day-8 through day-14 × 4 categories", () => {
    const result = buildPruneNames(now);
    // day-8 = 2026-05-08, day-14 = 2026-05-02
    for (let offset = 8; offset <= 14; offset++) {
      const date = new Date(now);
      date.setUTCDate(date.getUTCDate() - offset);
      const dateStr = date.toISOString().slice(0, 10);
      for (const cat of categories) {
        const attrName = `d_${dateStr}_${cat}`;
        expect(Object.values(result.names)).toContain(attrName);
      }
    }
  });

  it("returns attribute names for month-3 and month-4 × 4 categories", () => {
    const result = buildPruneNames(now);
    // month-3 from 2026-05 = 2026-02, month-4 = 2026-01
    for (const cat of categories) {
      expect(Object.values(result.names)).toContain(`m_2026-02_${cat}`);
      expect(Object.values(result.names)).toContain(`m_2026-01_${cat}`);
    }
  });

  it("all names are correctly formatted as #pruneN", () => {
    const result = buildPruneNames(now);
    const keys = Object.keys(result.names);
    for (const key of keys) {
      expect(key).toMatch(/^#prune\d+$/);
    }
  });

  it("expression is a REMOVE clause referencing all prune names", () => {
    const result = buildPruneNames(now);
    expect(result.expression).toMatch(/^REMOVE /);
    const keys = Object.keys(result.names);
    for (const key of keys) {
      expect(result.expression).toContain(key);
    }
  });

  it("total prune targets = (7 days × 4 categories) + (2 months × 4 categories) = 36", () => {
    const result = buildPruneNames(now);
    expect(Object.keys(result.names)).toHaveLength(36);
  });
});
