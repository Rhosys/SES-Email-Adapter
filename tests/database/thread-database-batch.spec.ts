import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ThreadDatabase } from "../../src/database/thread-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("ThreadDatabase.batchGetThreads", () => {
  let db: ThreadDatabase;

  beforeEach(() => {
    ddbMock.reset();
    db = new ThreadDatabase(createMockLogger());
  });

  afterEach(() => {
    ddbMock.restore();
  });

  it("returns ok([]) immediately for empty threadIds without calling DynamoDB", async () => {
    const result = await db.batchGetThreads("acct-123", []);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it("builds keys from threadPk(accountId, id) + ITEM_SK", async () => {
    ddbMock.on(BatchGetCommand).resolves({ Responses: { "ses-signals": [] } });

    await db.batchGetThreads("acct-42", ["thr-aaa", "thr-bbb"]);

    const calls = ddbMock.commandCalls(BatchGetCommand);
    expect(calls).toHaveLength(1);

    const input = calls[0]!.args[0].input;
    expect(input.RequestItems!["ses-signals"]!.Keys).toEqual([
      { pk: "ACCT#acct-42#ARC#thr-aaa", sk: "#" },
      { pk: "ACCT#acct-42#ARC#thr-bbb", sk: "#" },
    ]);
  });

  it("applies hydrateThreadObject to each returned item", async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        "ses-signals": [
          { arcId: "thr-001", accountId: "acct-1", subject: "Hello", lastSignalAt: "2024-01-01T00:00:00.000Z" },
          { threadId: "thr-002", accountId: "acct-1", subject: "World", lastSignalAt: "2024-01-01T00:00:00.000Z" },
        ],
      },
    });

    const result = await db.batchGetThreads("acct-1", ["thr-001", "thr-002"]);

    expect(result.isOk()).toBe(true);
    const threads = result._unsafeUnwrap();
    // hydrateThreadObject resolves arcId → threadId for legacy items
    expect(threads[0]).toMatchObject({ threadId: "thr-001", subject: "Hello" });
    // Already has threadId — kept as-is
    expect(threads[1]).toMatchObject({ threadId: "thr-002", subject: "World" });
  });

  it("filters out missing items naturally (BatchGet returns only found keys)", async () => {
    // Request 3 threads but DynamoDB only returns 2 (one is missing/orphaned)
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        "ses-signals": [
          { threadId: "thr-aaa", accountId: "acct-1", subject: "First", lastSignalAt: "2024-01-01T00:00:00.000Z" },
          { threadId: "thr-ccc", accountId: "acct-1", subject: "Third", lastSignalAt: "2024-01-01T00:00:00.000Z" },
        ],
      },
    });

    const result = await db.batchGetThreads("acct-1", ["thr-aaa", "thr-bbb", "thr-ccc"]);

    expect(result.isOk()).toBe(true);
    const threads = result._unsafeUnwrap();
    expect(threads).toHaveLength(2);
    expect(threads.map(t => (t as any).threadId)).toEqual(["thr-aaa", "thr-ccc"]);
  });

  it("excludes threads whose last signal predates the Jan 1 2000 cutoff", async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        "ses-signals": [
          { threadId: "thr-stale", accountId: "acct-1", subject: "Stale", lastSignalAt: "1999-12-31T23:59:59.000Z" },
          { threadId: "thr-fresh", accountId: "acct-1", subject: "Fresh", lastSignalAt: "2024-01-01T00:00:00.000Z" },
        ],
      },
    });

    const result = await db.batchGetThreads("acct-1", ["thr-stale", "thr-fresh"]);

    expect(result.isOk()).toBe(true);
    const threads = result._unsafeUnwrap();
    expect(threads.map(t => (t as any).threadId)).toEqual(["thr-fresh"]);
  });

  it("handles undefined Responses gracefully (returns empty array)", async () => {
    ddbMock.on(BatchGetCommand).resolves({ Responses: undefined });

    const result = await db.batchGetThreads("acct-1", ["thr-xyz"]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("returns err with kind db_error when DynamoDB throws", async () => {
    ddbMock.on(BatchGetCommand).rejects(new Error("ServiceUnavailable"));

    const result = await db.batchGetThreads("acct-1", ["thr-001"]);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    expect(result._unsafeUnwrapErr().cause).toBeInstanceOf(Error);
    expect((result._unsafeUnwrapErr().cause as Error).message).toBe("ServiceUnavailable");
  });
});
