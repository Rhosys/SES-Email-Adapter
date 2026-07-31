import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ThreadDatabase } from "../../src/database/thread-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => { ddbMock.reset(); });
afterEach(() => { ddbMock.restore(); });

// =============================================================================
// Invariant 9: findSignalByEmailMessageId queries gsi3 and resolves threadId
// **Validates: Requirements 12.9, 14.2**
// =============================================================================

describe("Invariant 9: findSignalByEmailMessageId uses gsi3", () => {
  let db: ThreadDatabase;
  beforeEach(() => { db = new ThreadDatabase(createMockLogger()); });

  it.each([
    {
      scenario: "post-migration item (threadId present) — resolves threadId",
      gsi3pk: "ACCT#acct-1#MSGID#<abc@example.com>",
      returnedItem: { id: "sgn-1", signalLookupId: "sgn-1", threadId: "thr-99", accountId: "acct-1", status: "active", source: "email", type: "email" },
      expectedThreadId: "thr-99",
    },
    {
      scenario: "pre-migration item (arcId only) — resolves threadId via fallback",
      gsi3pk: "ACCT#acct-2#MSGID#<old@legacy.com>",
      returnedItem: { id: "sgn-old", signalLookupId: "sgn-old", arcId: "thr-legacy", accountId: "acct-2", status: "active", source: "email", type: "email" },
      expectedThreadId: "thr-legacy",
    },
  ])("hit: $scenario", async ({ gsi3pk, returnedItem, expectedThreadId }) => {
    ddbMock.on(QueryCommand).resolves({ Items: [returnedItem] });

    const result = await db.findSignalByEmailMessageId(gsi3pk);

    expect(result.isOk()).toBe(true);
    const signal = result._unsafeUnwrap();
    expect(signal).not.toBeNull();
    expect(signal!.threadId).toBe(expectedThreadId);

    // Verify the query used IndexName "gsi3" and gsi3pk key condition
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const input = queryCalls[0]!.args[0]!.input;
    expect(input.IndexName).toBe("gsi3");
    expect(input.KeyConditionExpression).toContain("gsi3pk");
    expect(input.ExpressionAttributeValues).toMatchObject({ ":val": gsi3pk });
  });

  it("miss: returns null when gsi3 query yields no items", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await db.findSignalByEmailMessageId("ACCT#acct-1#MSGID#<nonexistent@x.com>");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();

    // Still verify IndexName is gsi3
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.args[0]!.input.IndexName).toBe("gsi3");
  });
});

// =============================================================================
// Invariant 10: findThreadByGroupingKey queries gsi3 with GKEY prefix
// **Validates: Requirements 12.10, 14.2**
// =============================================================================

describe("Invariant 10: findThreadByGroupingKey uses gsi3 with GKEY prefix", () => {
  let db: ThreadDatabase;
  beforeEach(() => { db = new ThreadDatabase(createMockLogger()); });

  it.each([
    {
      scenario: "post-migration thread (threadId present) — returns full thread",
      accountId: "acct-1",
      groupingKey: "order-12345",
      returnedItem: {
        id: "thr-9", accountId: "acct-1", threadId: "thr-9", groupingKey: "order-12345",
        workflow: "email", labels: [], status: "active", summary: "Order thread",
        lastSignalAt: "2024-06-01T00:00:00Z", createdAt: "2024-05-01T00:00:00Z", updatedAt: "2024-06-01T00:00:00Z",
        sender: { address: "shop@example.com" }, recipientAddress: "me@example.com", subject: "Your order",
      },
      expectedThreadId: "thr-9",
    },
    {
      scenario: "pre-migration thread (arcId only) — resolves threadId via fallback",
      accountId: "acct-2",
      groupingKey: "invoice-99",
      returnedItem: {
        id: "thr-legacy", accountId: "acct-2", arcId: "thr-legacy", groupingKey: "invoice-99",
        workflow: "email", labels: [], status: "active", summary: "Legacy thread",
        lastSignalAt: "2023-01-01T00:00:00Z", createdAt: "2022-12-01T00:00:00Z", updatedAt: "2023-01-01T00:00:00Z",
        sender: { address: "billing@corp.com" }, recipientAddress: "user@example.com", subject: "Invoice",
      },
      expectedThreadId: "thr-legacy",
    },
  ])("hit: $scenario", async ({ accountId, groupingKey, returnedItem, expectedThreadId }) => {
    ddbMock.on(QueryCommand).resolves({ Items: [returnedItem] });

    const result = await db.findThreadByGroupingKey(accountId, groupingKey);

    expect(result.isOk()).toBe(true);
    const thread = result._unsafeUnwrap();
    expect(thread).not.toBeNull();
    expect(thread!.id).toBe(returnedItem.id);
    expect((thread as any).threadId).toBe(expectedThreadId);

    // Verify the query used IndexName "gsi3" and gsi3pk = ACCT#...#GKEY#...
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const input = queryCalls[0]!.args[0]!.input;
    expect(input.IndexName).toBe("gsi3");
    expect(input.KeyConditionExpression).toContain("gsi3pk");
    expect(input.ExpressionAttributeValues).toMatchObject({ ":val": `ACCT#${accountId}#GKEY#${groupingKey}` });
  });

  it("miss: returns null when gsi3 query yields no items", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await db.findThreadByGroupingKey("acct-1", "nonexistent-key");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();

    // Still verify IndexName is gsi3 with correct GKEY prefix
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const input = queryCalls[0]!.args[0]!.input;
    expect(input.IndexName).toBe("gsi3");
    expect(input.ExpressionAttributeValues).toMatchObject({ ":val": "ACCT#acct-1#GKEY#nonexistent-key" });
  });
});
