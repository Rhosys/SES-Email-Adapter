// Feature: aurora-reindex-strategy, Property 11: Reindex worker uses cache exclusively and never calls Bedrock
// **Validates: Requirements 4.4, 4.7**
//
// For any set of signals with cached embeddings for the target model, the reindex worker:
// 1. Reads the embedding from the DynamoDB Signal record's `embeddings[modelId]` field
// 2. Upserts it directly to Aurora via `MultiClusterAuroraWriter`
// 3. NEVER calls Bedrock (no `InvokeModelCommand` or similar)
// 4. NEVER calls S3 `GetObject`

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { propertyRunner } from "../../testing/property-runner.js";
import { createMockLogger } from "../../testing/mock-logger.js";
import { ReindexWorker } from "./reindex-worker.js";

// ---------------------------------------------------------------------------
// Mock MultiClusterAuroraWriter
// ---------------------------------------------------------------------------

const mockUpsertEmbedding = vi.fn().mockResolvedValue(undefined);

vi.mock("../../database/multi-cluster-aurora-writer.js", () => ({
  multiClusterWriter: {
    upsertEmbedding: (...args: unknown[]) => mockUpsertEmbedding(...args),
  },
}));

// ---------------------------------------------------------------------------
// Mock cluster registry
// ---------------------------------------------------------------------------

vi.mock("../../embedding/cluster-registry.js", () => ({
  getClusterById: (clusterId: string) => {
    if (clusterId === "aurora-prod-titan-v2") {
      return {
        clusterId: "aurora-prod-titan-v2",
        clusterArn: "arn:aws:rds:eu-west-1:123:cluster:aurora-prod-titan-v2",
        secretArn: "arn:aws:secretsmanager:eu-west-1:123:secret:test",
        databaseName: "signals",
        modelId: "amazon.titan-embed-text-v2:0",
        dimensions: 1024,
        active: true,
      };
    }
    return null;
  },
}));

// ---------------------------------------------------------------------------
// AWS SDK mocks — DynamoDB, Bedrock, S3
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockRuntimeClient);
const s3Mock = mockClient(S3Client);

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a valid signal ID */
const arbSignalId = fc.string({ minLength: 1, maxLength: 30 }).map((s) => `SES#${s.replace(/[^a-zA-Z0-9]/g, "x")}`);

/** Generate a valid account ID */
const arbAccountId = fc.string({ minLength: 1, maxLength: 20 }).map((s) => `acct-${s.replace(/[^a-zA-Z0-9]/g, "a")}`);

/** Generate a valid arc ID */
const arbArcId = fc.string({ minLength: 1, maxLength: 20 }).map((s) => `arc-${s.replace(/[^a-zA-Z0-9]/g, "b")}`);

/** Generate a valid email address */
const arbEmail = fc.string({ minLength: 1, maxLength: 20 }).map((s) => `${s.replace(/[^a-zA-Z0-9]/g, "c")}@example.com`);

/** Generate a non-empty embedding vector (array of floats) */
const arbEmbedding = fc.array(fc.float({ noNaN: true, noDefaultInfinity: true, min: -1, max: 1 }), { minLength: 3, maxLength: 20 });

/** Generate a signal item with a cached embedding for the target model */
const arbSignalWithCache = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  embedding: arbEmbedding,
}).map((s) => ({
  pk: `ACCT#${s.accountId}#SIG#${s.id}`,
  sk: "#",
  id: s.id,
  accountId: s.accountId,
  arcId: s.arcId,
  recipientAddress: s.recipientAddress,
  embeddings: { "amazon.titan-embed-text-v2:0": s.embedding },
}));

/** Generate a non-empty array of signals with cached embeddings */
const arbSignalSet = fc.array(arbSignalWithCache, { minLength: 1, maxLength: 10 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsRecord(body: unknown): SQSRecord {
  return {
    messageId: "msg-prop-test",
    receiptHandle: "handle-1",
    body: JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "0",
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: "0",
    },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:eu-west-1:123:reindex-queue",
    awsRegion: "eu-west-1",
  };
}

function makeSqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe("Property 11: Reindex worker uses cache exclusively and never calls Bedrock", () => {
  let worker: ReindexWorker;

  beforeEach(() => {
    worker = new ReindexWorker(createMockLogger());
    ddbMock.reset();
    bedrockMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();

    // Bedrock and S3 should NEVER be called — reject if they are
    bedrockMock.on(InvokeModelCommand).rejects(new Error("PROPERTY VIOLATION: Bedrock was called during pure-copy reindex"));
    s3Mock.on(GetObjectCommand).rejects(new Error("PROPERTY VIOLATION: S3 GetObject was called during pure-copy reindex"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("for any set of signals with cached embeddings, the worker upserts each to Aurora and never calls Bedrock or S3", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbSignalSet, async (signals) => {
        // Reset mocks for each iteration
        ddbMock.reset();
        mockUpsertEmbedding.mockClear();

        // Re-arm Bedrock and S3 traps after reset
        bedrockMock.on(InvokeModelCommand).rejects(new Error("PROPERTY VIOLATION: Bedrock was called during pure-copy reindex"));
        s3Mock.on(GetObjectCommand).rejects(new Error("PROPERTY VIOLATION: S3 GetObject was called during pure-copy reindex"));

        // DynamoDB scan returns the generated signals in one page
        ddbMock.on(ScanCommand).resolves({ Items: signals, LastEvaluatedKey: undefined });
        ddbMock.on(UpdateCommand).resolves({});

        const event = makeSqsEvent([
          makeSqsRecord({
            jobId: "job-prop-11",
            segment: 0,
            totalSegments: 1,
            targetClusterId: "aurora-prod-titan-v2",
            modelId: "amazon.titan-embed-text-v2:0",
          }),
        ]);

        await worker.process(event);

        // 1. Worker reads from DynamoDB (scan was called)
        const scanCalls = ddbMock.commandCalls(ScanCommand);
        expect(scanCalls.length).toBeGreaterThanOrEqual(1);

        // 2. Worker upserts each signal's cached embedding to Aurora
        expect(mockUpsertEmbedding).toHaveBeenCalledTimes(signals.length);

        for (let i = 0; i < signals.length; i++) {
          const signal = signals[i]!;
          const expectedVector = signal.embeddings["amazon.titan-embed-text-v2:0"];
          expect(mockUpsertEmbedding).toHaveBeenCalledWith({
            clusterId: "aurora-prod-titan-v2",
            arcId: signal.arcId,
            accountId: signal.accountId,
            recipientAddress: signal.recipientAddress,
            embedding: expectedVector,
          });
        }

        // 3. NEVER calls Bedrock — zero InvokeModelCommand calls
        expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0);

        // 4. NEVER calls S3 GetObject
        expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);

        return true;
      }),
    );
  });

  it("for signals with cached embeddings, the exact cached vector is passed to Aurora (no transformation)", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbSignalWithCache, async (signal) => {
        ddbMock.reset();
        mockUpsertEmbedding.mockClear();

        bedrockMock.on(InvokeModelCommand).rejects(new Error("PROPERTY VIOLATION: Bedrock was called"));
        s3Mock.on(GetObjectCommand).rejects(new Error("PROPERTY VIOLATION: S3 was called"));

        ddbMock.on(ScanCommand).resolves({ Items: [signal], LastEvaluatedKey: undefined });
        ddbMock.on(UpdateCommand).resolves({});

        const event = makeSqsEvent([
          makeSqsRecord({
            jobId: "job-prop-11-exact",
            segment: 0,
            totalSegments: 1,
            targetClusterId: "aurora-prod-titan-v2",
            modelId: "amazon.titan-embed-text-v2:0",
          }),
        ]);

        await worker.process(event);

        // The exact vector from the DynamoDB record is passed through unchanged
        const cachedVector = signal.embeddings["amazon.titan-embed-text-v2:0"];
        expect(mockUpsertEmbedding).toHaveBeenCalledTimes(1);
        expect(mockUpsertEmbedding).toHaveBeenCalledWith(
          expect.objectContaining({ embedding: cachedVector }),
        );

        return true;
      }),
    );
  });
});
