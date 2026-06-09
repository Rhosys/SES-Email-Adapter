import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ArcDatabase } from "../../src/database/arc-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("ArcDatabase.updateArc expression builder", () => {
  let db: ArcDatabase;

  beforeEach(() => {
    ddbMock.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T10:30:00.000Z"));
    db = new ArcDatabase(createMockLogger());
  });

  afterEach(() => {
    vi.useRealTimers();
    ddbMock.restore();
  });

  it("status + lastSignalAt only → gsi1sk recomputed, updatedAt set, no optional fields", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await db.updateArc("acct-1", "arc-001", "active", "2024-06-15T10:00:00Z", {});

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);

    const input = calls[0]!.args[0].input;
    expect(input.Key).toEqual({ pk: "ACCT#acct-1#ARC#arc-001", sk: "#" });
    expect(input.UpdateExpression).toBe(
      "SET updatedAt = :now, #status = :status, lastSignalAt = :lastSignalAt, gsi1sk = :gsi1sk",
    );
    expect(input.ExpressionAttributeValues).toEqual({
      ":now": "2024-06-15T10:30:00.000Z",
      ":status": "active",
      ":lastSignalAt": "2024-06-15T10:00:00Z",
      ":gsi1sk": "LASTACT#active#2024-06-15T10:00:00Z#arc-001",
    });
    expect(input.ExpressionAttributeNames).toEqual({ "#status": "status" });
    expect(input.ReturnValues).toBe("ALL_NEW");
  });

  it("status + lastSignalAt + labels → labels set alongside required fields", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await db.updateArc("acct-2", "arc-002", "archived", "2024-06-14T08:00:00Z", {
      labels: ["billing", "urgent"],
    });

    const calls = ddbMock.commandCalls(UpdateCommand);
    const input = calls[0]!.args[0].input;

    expect(input.UpdateExpression).toBe(
      "SET updatedAt = :now, #status = :status, lastSignalAt = :lastSignalAt, gsi1sk = :gsi1sk, labels = :labels",
    );
    expect(input.ExpressionAttributeValues).toEqual({
      ":now": "2024-06-15T10:30:00.000Z",
      ":status": "archived",
      ":lastSignalAt": "2024-06-14T08:00:00Z",
      ":gsi1sk": "LASTACT#archived#2024-06-14T08:00:00Z#arc-002",
      ":labels": ["billing", "urgent"],
    });
  });

  it("summary + workflow in optional fields → both set", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await db.updateArc("acct-3", "arc-003", "active", "2024-06-15T09:00:00Z", {
      summary: "Password reset request",
      workflow: "auth",
    });

    const calls = ddbMock.commandCalls(UpdateCommand);
    const input = calls[0]!.args[0].input;

    expect(input.UpdateExpression).toBe(
      "SET updatedAt = :now, #status = :status, lastSignalAt = :lastSignalAt, gsi1sk = :gsi1sk, summary = :summary, workflow = :workflow",
    );
    expect(input.ExpressionAttributeValues).toEqual(expect.objectContaining({
      ":summary": "Password reset request",
      ":workflow": "auth",
    }));
  });

  it("updatedAt always present regardless of which optional fields provided", async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: {} });

    await db.updateArc("acct-4", "arc-004", "active", "2024-06-15T07:00:00Z", {
      urgency: "high",
      retentionDuration: "P30D",
      sentMessageIds: ["msg-1", "msg-2"],
    });

    const calls = ddbMock.commandCalls(UpdateCommand);
    const input = calls[0]!.args[0].input;

    // updatedAt is always the first SET clause and always present
    expect(input.UpdateExpression).toContain("updatedAt = :now");
    expect(input.ExpressionAttributeValues![":now"]).toBe("2024-06-15T10:30:00.000Z");
    // Also verify the optional fields are present
    expect(input.ExpressionAttributeValues![":urgency"]).toBe("high");
    expect(input.ExpressionAttributeValues![":rd"]).toBe("P30D");
    expect(input.ExpressionAttributeValues![":smids"]).toEqual(["msg-1", "msg-2"]);
  });
});
