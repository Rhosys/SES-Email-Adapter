// Feature: aurora-reindex-strategy, Property 22: Worker isolates per-signal failures within a segment
// **Validates: Requirements 10.5**
//
// For any segment containing N signals where some are malformed or cause errors:
// 1. The worker processes all signals in the segment (doesn't abort on first failure)
// 2. Malformed signals are logged per-signal and skipped
// 3. Successful signals still get their upserts written to Aurora
// 4. The segment-level processing continues past individual failures

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { createMockLogger } from "../../testing/mock-logger.js";
import type { MockLogger } from "../../testing/mock-logger.js";
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

const validSignal1 = {
  pk: "ACCT#acct-1#SIG#SES#valid1",
  sk: "#",
  id: "SES#valid1",
  accountId: "acct-1",
  arcId: "arc-1",
  recipientAddress: "valid1@example.com",
  embeddings: { "amazon.titan-embed-text-v2:0": [0.1, 0.2, 0.3] },
};

const validSignal2 = {
  pk: "ACCT#acct-2#SIG#SES#valid2",
  sk: "#",
  id: "SES#valid2",
  accountId: "acct-2",
  arcId: "arc-2",
  recipientAddress: "valid2@example.com",
  embeddings: { "amazon.titan-embed-text-v2:0": [0.4, 0.5, 0.6] },
};

const validSignal3 = {
  pk: "ACCT#acct-3#SIG#SES#valid3",
  sk: "#",
  id: "SES#valid3",
  accountId: "acct-3",
  arcId: "arc-3",
  recipientAddress: "valid3@example.com",
  embeddings: { "amazon.titan-embed-text-v2:0": [0.7, 0.8, 0.9] },
};

// Malformed: missing accountId
const malformedMissingAccountId = {
  pk: "BAD#1",
  sk: "#",
  id: "SES#malformed-no-acct",
  recipientAddress: "missing-acct@example.com",
};

// Malformed: missing arcId
const malformedMissingArcId = {
  pk: "ACCT#acct-x#SIG#SES#malformed-no-arc",
  sk: "#",
  id: "SES#malformed-no-arc",
  accountId: "acct-x",
  recipientAddress: "missing-arc@example.com",
};

// Malformed: missing recipientAddress
const malformedMissingRecipient = {
  pk: "ACCT#acct-y#SIG#SES#malformed-no-email",
  sk: "#",
  id: "SES#malformed-no-email",
  accountId: "acct-y",
  arcId: "arc-y",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsRecord(body: unknown): SQSRecord {
  return {
    messageId: "msg-prop-22",
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

const mixedSegmentCases: Array<[string, { items: unknown[]; validCount: number; malformedCount: number }]> = [
  ["1 valid + 1 malformed (missing accountId)", {
    items: [validSignal1, malformedMissingAccountId],
    validCount: 1,
    malformedCount: 1,
  }],
  ["1 valid + 1 malformed (missing arcId)", {
    items: [validSignal1, malformedMissingArcId],
    validCount: 1,
    malformedCount: 1,
  }],
  ["1 valid + 1 malformed (missing recipientAddress)", {
    items: [validSignal1, malformedMissingRecipient],
    validCount: 1,
    malformedCount: 1,
  }],
  ["malformed first, valid second — order doesn't matter", {
    items: [malformedMissingAccountId, validSignal1],
    validCount: 1,
    malformedCount: 1,
  }],
  ["2 valid + 2 malformed interleaved", {
    items: [validSignal1, malformedMissingAccountId, validSignal2, malformedMissingArcId],
    validCount: 2,
    malformedCount: 2,
  }],
  ["3 valid + 3 malformed — all malformation types", {
    items: [validSignal1, malformedMissingAccountId, validSignal2, malformedMissingArcId, validSignal3, malformedMissingRecipient],
    validCount: 3,
    malformedCount: 3,
  }],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 22: Worker isolates per-signal failures within a segment", () => {
  let worker: ReindexWorker;
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    worker = new ReindexWorker(mockLogger);
    ddbMock.reset();
    bedrockMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();

    bedrockMock.on(InvokeModelCommand).rejects(new Error("PROPERTY VIOLATION: Bedrock was called"));
    s3Mock.on(GetObjectCommand).rejects(new Error("PROPERTY VIOLATION: S3 was called"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(mixedSegmentCases)("%s", async (_label, { items, validCount, malformedCount }) => {
    ddbMock.reset();
    mockUpsertEmbedding.mockClear();
    mockLogger.calls.length = 0;

    bedrockMock.on(InvokeModelCommand).rejects(new Error("PROPERTY VIOLATION: Bedrock was called"));
    s3Mock.on(GetObjectCommand).rejects(new Error("PROPERTY VIOLATION: S3 was called"));

    ddbMock.on(ScanCommand).resolves({ Items: items, LastEvaluatedKey: undefined });
    ddbMock.on(UpdateCommand).resolves({});

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-prop-22",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    // The worker should NOT throw — segment processing completes
    await worker.process(event);

    // 1. Valid signals get their upserts written to Aurora
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(validCount);

    // 2. Malformed signals are logged
    const malformedLogs = mockLogger.calls.filter(
      (call) => call.context?.code === "reindex.worker.malformed_signal",
    );
    expect(malformedLogs.length).toBe(malformedCount);
  });

  it("when Aurora upsert fails for one signal, remaining signals still get processed", async () => {
    ddbMock.reset();
    mockUpsertEmbedding.mockClear();
    mockLogger.calls.length = 0;

    const signals = [validSignal1, validSignal2, validSignal3];

    // First upsert fails, rest succeed
    let callIndex = 0;
    mockUpsertEmbedding.mockImplementation(() => {
      const idx = callIndex++;
      if (idx === 0) {
        return Promise.reject(new Error("Simulated Aurora failure"));
      }
      return Promise.resolve(undefined);
    });

    ddbMock.on(ScanCommand).resolves({ Items: signals, LastEvaluatedKey: undefined });
    ddbMock.on(UpdateCommand).resolves({});

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-prop-22-aurora-fail",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    // The worker should NOT throw
    await worker.process(event);

    // All signals were attempted (upsert called for each)
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(signals.length);

    // The failure was logged per-signal
    const failureLogs = mockLogger.calls.filter(
      (call) => call.context?.code === "reindex.worker.signal_upsert_failed",
    );
    expect(failureLogs.length).toBe(1);
  });
});
