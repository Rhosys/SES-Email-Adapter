// Feature: aurora-reindex-strategy, Property 11: Reindex worker uses cache exclusively and never calls Bedrock
// **Validates: Requirements 4.4, 4.7**
//
// For any set of signals with cached embeddings for the target model, the reindex worker:
// 1. Reads the embedding from the DynamoDB Signal record's `embeddings[modelId]` field
// 2. Upserts it directly to Aurora via `MultiClusterAuroraWriter`
// 3. NEVER calls Bedrock (no `InvokeModelCommand` or similar)
// 4. NEVER calls S3 `GetObject`

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { SQSEvent, SQSRecord } from "aws-lambda";
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
// Static test signals
// ---------------------------------------------------------------------------

function makeSignal(id: string, accountId: string, arcId: string, email: string, embedding: number[]) {
  return {
    pk: `ACCT#${accountId}#SIG#${id}`,
    sk: "#",
    id,
    accountId,
    arcId,
    recipientAddress: email,
    embeddings: { "amazon.titan-embed-text-v2:0": embedding },
  };
}

const signal1 = makeSignal("SES#sig1", "acct-1", "arc-1", "alice@example.com", [0.1, 0.2, 0.3]);
const signal2 = makeSignal("SES#sig2", "acct-2", "arc-2", "bob@example.com", [-0.5, 0.0, 0.5]);
const signal3 = makeSignal("SES#sig3", "acct-1", "arc-3", "carol@example.com", [1.0, -1.0, 0.0, 0.5, 0.25]);

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
// Edge cases
// ---------------------------------------------------------------------------

const cases: Array<[string, { signals: typeof signal1[] }]> = [
  ["single signal — minimum batch", { signals: [signal1] }],
  ["two signals from different accounts", { signals: [signal1, signal2] }],
  ["three signals — one account has two arcs", { signals: [signal1, signal2, signal3] }],
];

// ---------------------------------------------------------------------------
// Tests
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

  it.each(cases)("%s", async (_label, { signals }) => {
    ddbMock.reset();
    mockUpsertEmbedding.mockClear();

    bedrockMock.on(InvokeModelCommand).rejects(new Error("PROPERTY VIOLATION: Bedrock was called during pure-copy reindex"));
    s3Mock.on(GetObjectCommand).rejects(new Error("PROPERTY VIOLATION: S3 GetObject was called during pure-copy reindex"));

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

    for (const signal of signals) {
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
  });

  it("the exact cached vector is passed to Aurora unchanged (no transformation)", async () => {
    ddbMock.reset();
    mockUpsertEmbedding.mockClear();

    bedrockMock.on(InvokeModelCommand).rejects(new Error("PROPERTY VIOLATION: Bedrock was called"));
    s3Mock.on(GetObjectCommand).rejects(new Error("PROPERTY VIOLATION: S3 was called"));

    // Use a signal with a distinctive vector to verify no transformation
    const distinctiveVector = [0.123456, -0.789012, 0.0, 1.0, -1.0];
    const signal = makeSignal("SES#exact-vec", "acct-exact", "arc-exact", "exact@example.com", distinctiveVector);

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

    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(1);
    expect(mockUpsertEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: distinctiveVector }),
    );
  });
});
