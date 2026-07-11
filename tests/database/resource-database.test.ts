import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ResourceDatabase } from "../../src/database/resource-database.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("ResourceDatabase.saveResource", () => {
  let db: ResourceDatabase;

  beforeEach(() => {
    ddbMock.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T10:30:00.000Z"));
    db = new ResourceDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
    ddbMock.restore();
  });

  it("writes to a deterministic key (THREAD#threadId / workflow#resourceKey) — no read-before-write", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await db.saveResource({
      accountId: "acct-1", threadId: "thr-001", workflow: "package",
      resourceKey: "123-456", expectedResolutionDate: "2024-07-01T00:00:00Z", terminal: false,
    });

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.Key).toEqual({ pk: "ACCT#acct-1#THREAD#thr-001", sk: "package#123-456" });
  });

  it("active resource: sets status=active, gsi1pk includes STATUS#active, removes resolvedAt", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await db.saveResource({
      accountId: "acct-1", threadId: "thr-001", workflow: "package",
      resourceKey: "123-456", expectedResolutionDate: "2024-07-01T00:00:00Z", terminal: false,
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues![":status"]).toBe("active");
    expect(input.ExpressionAttributeValues![":gsi1pk"]).toBe("ACCT#acct-1#STATUS#active#WORKFLOW#package");
    expect(input.ExpressionAttributeValues![":erd"]).toBe("2024-07-01T00:00:00Z");
    expect(input.UpdateExpression).toContain("REMOVE resolvedAt");
    expect(input.UpdateExpression).not.toContain("resolvedAt = :now");
  });

  it("terminal resource: sets status=complete, gsi1pk includes STATUS#complete, sets resolvedAt", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await db.saveResource({
      accountId: "acct-1", threadId: "thr-001", workflow: "package",
      resourceKey: "123-456", expectedResolutionDate: "2024-07-01T00:00:00Z", terminal: true,
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues![":status"]).toBe("complete");
    expect(input.ExpressionAttributeValues![":gsi1pk"]).toBe("ACCT#acct-1#STATUS#complete#WORKFLOW#package");
    expect(input.UpdateExpression).toContain("resolvedAt = :now");
    expect(input.UpdateExpression).not.toContain("REMOVE resolvedAt");
  });

  it("gsi1sk is the expectedResolutionDate, enabling a native date-range query", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await db.saveResource({
      accountId: "acct-1", threadId: "thr-001", workflow: "events",
      resourceKey: "TIX-1", expectedResolutionDate: "2024-08-01T20:00:00Z", terminal: false,
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues![":erd"]).toBe("2024-08-01T20:00:00Z");
    expect(input.UpdateExpression).toContain("gsi1sk = :erd");
  });

  it("sets ttl when provided, omits it when undefined", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await db.saveResource({
      accountId: "acct-1", threadId: "thr-001", workflow: "package",
      resourceKey: "123-456", expectedResolutionDate: "2024-07-01T00:00:00Z", terminal: false, ttl: 1735689600,
    });
    let input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues![":ttl"]).toBe(1735689600);
    expect(input.UpdateExpression).toContain("#ttl = :ttl");

    ddbMock.resetHistory();
    await db.saveResource({
      accountId: "acct-1", threadId: "thr-001", workflow: "package",
      resourceKey: "123-456", expectedResolutionDate: "2024-07-01T00:00:00Z", terminal: false,
    });
    input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues![":ttl"]).toBeUndefined();
    expect(input.UpdateExpression).not.toContain("#ttl");
  });
});

describe("ResourceDatabase.getResource", () => {
  let db: ResourceDatabase;

  beforeEach(() => {
    ddbMock.reset();
    db = new ResourceDatabase();
  });

  it("does a direct GetItem keyed by accountId/threadId/sk — no query", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { accountId: "acct-1", threadId: "thr-001" } });

    const result = await db.getResource("acct-1", "thr-001", "package#123-456");

    expect(result.isOk()).toBe(true);
    const calls = ddbMock.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Key).toEqual({ pk: "ACCT#acct-1#THREAD#thr-001", sk: "package#123-456" });
  });

  it("returns null when the item does not exist", async () => {
    ddbMock.on(GetCommand).resolves({});
    const result = await db.getResource("acct-1", "thr-001", "package#123-456");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBeNull();
  });
});

describe("ResourceDatabase.listResources", () => {
  let db: ResourceDatabase;

  beforeEach(() => {
    ddbMock.reset();
    db = new ResourceDatabase();
  });

  it("queries gsi1 scoped to accountId+status+workflow, no date range by default", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await db.listResources("acct-1", "package", "active", {});

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.IndexName).toBe("gsi1");
    expect(input.KeyConditionExpression).toBe("gsi1pk = :pk");
    expect(input.ExpressionAttributeValues).toEqual({ ":pk": "ACCT#acct-1#STATUS#active#WORKFLOW#package" });
  });

  it("adds a native gsi1sk BETWEEN range condition when dateFrom/dateTo are given", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await db.listResources("acct-1", "package", "active", { dateFrom: "2024-07-01", dateTo: "2024-07-04" });

    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.KeyConditionExpression).toBe("gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to");
    expect(input.ExpressionAttributeValues).toEqual({
      ":pk": "ACCT#acct-1#STATUS#active#WORKFLOW#package",
      ":from": "2024-07-01",
      ":to": "2024-07-04",
    });
  });
});
