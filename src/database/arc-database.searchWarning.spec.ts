import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ArcDatabase } from "./arc-database.js";
import { createMockLogger } from "../testing/mock-logger.js";

/**
 * Feature: dynamodb-storage-optimization, Property 5: Search warning threshold is bidirectional
 * Validates: Requirements 4.1, 4.3
 */
describe("Feature: dynamodb-storage-optimization, Property 5: Search warning threshold is bidirectional", () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  let db: ArcDatabase;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    ddbMock.reset();
    mockLogger = createMockLogger();
    db = new ArcDatabase(mockLogger);
  });

  afterEach(() => {
    ddbMock.restore();
  });

  // Helper: generate fake Arc items for a given count
  function makeFakeItems(count: number): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `arc-${i}`,
      accountId: "acct-1",
      status: "active",
      summary: "test summary",
      workflow: "default",
      lastSignalAt: "2024-01-01T00:00:00.000Z",
      labels: [],
      urgency: "normal",
    }));
  }

  // ---------------------------------------------------------------------------
  // Edge cases for the 200-item warning threshold
  // ---------------------------------------------------------------------------

  const cases: Array<[string, { itemCount: number; shouldWarn: boolean }]> = [
    ["0 items — no warning", { itemCount: 0, shouldWarn: false }],
    ["1 item — no warning", { itemCount: 1, shouldWarn: false }],
    ["199 items — just below threshold, no warning", { itemCount: 199, shouldWarn: false }],
    ["200 items — exactly at threshold, no warning", { itemCount: 200, shouldWarn: false }],
    ["201 items — just above threshold, emits warning", { itemCount: 201, shouldWarn: true }],
    ["300 items — well above threshold, emits warning", { itemCount: 300, shouldWarn: true }],
    ["500 items — far above threshold, emits warning", { itemCount: 500, shouldWarn: true }],
  ];

  it.each(cases)("%s", async (_label, { itemCount, shouldWarn }) => {
    ddbMock.reset();
    mockLogger.calls.length = 0;

    ddbMock.on(QueryCommand).resolves({ Items: makeFakeItems(itemCount) });

    await db.searchArcs("acct-1", "test", { limit: 20 });

    const warningEmitted = mockLogger.calls.some(c => c.method === "warn");

    expect(warningEmitted).toBe(shouldWarn);
  });
});
