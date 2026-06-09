import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ArcDatabase } from "../../src/database/arc-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("ArcDatabase.addEmbeddingToCache", () => {
  let db: ArcDatabase;

  beforeEach(() => {
    ddbMock.reset();
    db = new ArcDatabase(createMockLogger());
  });

  afterEach(() => {
    ddbMock.restore();
  });

  it("sends an UpdateCommand with the correct key, expression, and values", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const accountId = "acct-123";
    const signalId = "SES#msg-abc";
    const modelId = "amazon.titan-embed-text-v2:0";
    const vector = [0.1, -0.2, 0.3];

    const result = await db.addEmbeddingToCache(accountId, signalId, modelId, vector);

    expect(result.isOk()).toBe(true);

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);

    const input = calls[0]!.args[0].input;
    expect(input.TableName).toBe("ses-signals");
    expect(input.Key).toEqual({
      pk: `ACCT#${accountId}#SIG#${signalId}`,
      sk: "#",
    });
    expect(input.UpdateExpression).toBe("SET #data.embeddings.#mid = :v");
    expect(input.ExpressionAttributeNames).toEqual({ "#mid": modelId, "#data": "data" });
    expect(input.ExpressionAttributeValues).toEqual({ ":v": vector });
  });

  it("is idempotent — calling twice with the same args sends the same command", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const args: [string, string, string, number[]] = ["acct-1", "SES#id-1", "model-x", [1, 2, 3]];

    const result1 = await db.addEmbeddingToCache(...args);
    const result2 = await db.addEmbeddingToCache(...args);

    expect(result1.isOk()).toBe(true);
    expect(result2.isOk()).toBe(true);

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(2);
    // Both calls produce identical inputs — idempotent by construction
    expect(calls[0]!.args[0].input).toEqual(calls[1]!.args[0].input);
  });

  it("uses expression attribute names to safely handle model IDs with dots", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const modelWithDots = "amazon.titan-embed-text-v2:0";
    const result = await db.addEmbeddingToCache("acct-1", "SES#id-1", modelWithDots, [0.5]);

    expect(result.isOk()).toBe(true);

    const calls = ddbMock.commandCalls(UpdateCommand);
    const input = calls[0]!.args[0].input;
    // The model ID is passed via ExpressionAttributeNames, not inline in the expression
    expect(input.ExpressionAttributeNames!["#mid"]).toBe(modelWithDots);
  });

  it("returns a DbError when DynamoDB fails", async () => {
    ddbMock.on(UpdateCommand).rejects(new Error("ConditionalCheckFailedException"));

    const result = await db.addEmbeddingToCache("acct-1", "SES#id-1", "model-x", [1]);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("db_error");
  });
});
