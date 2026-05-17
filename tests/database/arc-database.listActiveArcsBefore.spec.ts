import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ArcDatabase } from "../../src/database/arc-database.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("ArcDatabase.listActiveArcsBefore", () => {
  let db: ArcDatabase;

  beforeEach(() => {
    ddbMock.reset();
    db = new ArcDatabase();
  });

  afterEach(() => {
    ddbMock.restore();
  });

  it("queries gsi1 with correct key condition expression and attribute values", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const accountId = "acct-123";
    const beforeDate = "2025-05-04T00:00:00.000Z";

    await db.listActiveArcsBefore(accountId, beforeDate);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);

    const input = calls[0]!.args[0].input;
    expect(input.TableName).toBe("ses-signals");
    expect(input.IndexName).toBe("gsi1");
    expect(input.KeyConditionExpression).toBe("gsi1pk = :pk AND gsi1sk BETWEEN :start AND :end");
    expect(input.ExpressionAttributeValues).toEqual({
      ":pk": `ACCT#${accountId}`,
      ":start": "LASTACT#active#",
      ":end": `LASTACT#active#${beforeDate}#`,
    });
  });

  it("uses ScanIndexForward: true for ascending sort order", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await db.listActiveArcsBefore("acct-1", "2025-01-01T00:00:00.000Z");

    const calls = ddbMock.commandCalls(QueryCommand);
    const input = calls[0]!.args[0].input;
    expect(input.ScanIndexForward).toBe(true);
  });

  it("returns items cast as Arc[]", async () => {
    const fakeArcs = [
      { id: "arc-1", accountId: "acct-1", status: "active", lastSignalAt: "2025-04-01T00:00:00.000Z" },
      { id: "arc-2", accountId: "acct-1", status: "active", lastSignalAt: "2025-04-02T00:00:00.000Z" },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: fakeArcs });

    const result = await db.listActiveArcsBefore("acct-1", "2025-05-01T00:00:00.000Z");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(fakeArcs);
    expect(result._unsafeUnwrap()).toHaveLength(2);
  });

  it("returns empty array when no items match", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: undefined });

    const result = await db.listActiveArcsBefore("acct-1", "2025-01-01T00:00:00.000Z");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("returns a DbError when DynamoDB fails", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("ProvisionedThroughputExceededException"));

    const result = await db.listActiveArcsBefore("acct-1", "2025-01-01T00:00:00.000Z");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });
});
