// Feature: aurora-reindex-strategy, Property 22: Worker isolates per-signal failures within a segment
// **Validates: Requirements 10.5**
//
// For any segment containing K malformed signals (missing required fields, undecodable embeddings)
// and M valid signals, the worker:
// 1. Upserts all M valid signals to Aurora
// 2. Logs each of the K malformed signals individually with its signal ID
// 3. Continues processing remaining signals (does NOT throw, does NOT retry the whole segment)
// 4. Segment-level counters (copiedCount, regeneratedCount, unrecoverableCount) are only
//    incremented for successful signals

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { createMockLogger } from "../../testing/mock-logger.js";
import { ReindexWorker } from "./reindex-worker.js";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

const { mockUpsertEmbedding, mockAddEmbeddingToCache, mockGenerateForModel, mockMimeParse } = vi.hoisted(() => ({
  mockUpsertEmbedding: vi.fn().mockResolvedValue(undefined),
  mockAddEmbeddingToCache: vi.fn().mockResolvedValue(undefined),
  mockGenerateForModel: vi.fn(),
  mockMimeParse: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock MultiClusterAuroraWriter
// ---------------------------------------------------------------------------

vi.mock("../../database/multi-cluster-aurora-writer.js", () => ({
  multiClusterWriter: {
    upsertEmbedding: (...args: unknown[]) => mockUpsertEmbedding(...args),
  },
}));

// ---------------------------------------------------------------------------
// Mock ArcDatabase (addEmbeddingToCache)
// ---------------------------------------------------------------------------

vi.mock("../../database/arc-database.js", () => ({
  ArcDatabase: class {
    addEmbeddingToCache = mockAddEmbeddingToCache;
  },
}));

// ---------------------------------------------------------------------------
// Mock EmbeddingGenerator
// ---------------------------------------------------------------------------

vi.mock("../../embedding/embedding-generator.js", () => ({
  BedrockEmbeddingGenerator: class {
    generateForModel = mockGenerateForModel;
  },
}));

// ---------------------------------------------------------------------------
// Mock MimeParser
// ---------------------------------------------------------------------------

vi.mock("../../processor/mime.js", () => ({
  MailparserMimeParser: class {
    parse = mockMimeParse;
  },
}));

// ---------------------------------------------------------------------------
// Mock cluster registry
// ---------------------------------------------------------------------------

const TARGET_MODEL_ID = "amazon.titan-embed-text-v2:0";
const TARGET_CLUSTER_ID = "aurora-prod-titan-v2";

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
// AWS SDK mocks
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockRuntimeClient);
const s3Mock = mockClient(S3Client);

// ---------------------------------------------------------------------------
// Static test signals
// ---------------------------------------------------------------------------

// Valid cached signals (pure-copy path)
const validCached1 = {
  pk: "ACCT#acct-1#SIG#SES#cached1",
  sk: "#",
  id: "SES#cached1",
  accountId: "acct-1",
  arcId: "arc-1",
  recipientAddress: "cached1@example.com",
  embeddings: { [TARGET_MODEL_ID]: [0.1, 0.2, 0.3] },
};

const validCached2 = {
  pk: "ACCT#acct-2#SIG#SES#cached2",
  sk: "#",
  id: "SES#cached2",
  accountId: "acct-2",
  arcId: "arc-2",
  recipientAddress: "cached2@example.com",
  embeddings: { [TARGET_MODEL_ID]: [0.4, 0.5, 0.6] },
};

// Valid S3-retrievable signals (regeneration path)
const validS3Signal1 = {
  pk: "ACCT#acct-3#SIG#SES#s3sig1",
  sk: "#",
  id: "SES#s3sig1",
  accountId: "acct-3",
  arcId: "arc-3",
  recipientAddress: "s3sig1@example.com",
  embeddings: {},
  s3Key: "inbox/2025/s3sig1.eml",
};

const validS3Signal2 = {
  pk: "ACCT#acct-4#SIG#SES#s3sig2",
  sk: "#",
  id: "SES#s3sig2",
  accountId: "acct-4",
  arcId: "arc-4",
  recipientAddress: "s3sig2@example.com",
  embeddings: { "amazon.titan-embed-text-v3:0": [0.9, 0.8] },
  s3Key: "inbox/2025/s3sig2.eml",
};

// Malformed signals — each missing a different required field
const malformedMissingAccountId = {
  pk: "ACCT#placeholder#SIG#SES#mal1",
  sk: "#",
  id: "SES#mal1",
  arcId: "arc-m1",
  recipientAddress: "mal1@example.com",
  embeddings: {},
};

const malformedMissingArcId = {
  pk: "ACCT#acct-m2#SIG#SES#mal2",
  sk: "#",
  id: "SES#mal2",
  accountId: "acct-m2",
  recipientAddress: "mal2@example.com",
  embeddings: {},
};

const malformedMissingRecipient = {
  pk: "ACCT#acct-m3#SIG#SES#mal3",
  sk: "#",
  id: "SES#mal3",
  accountId: "acct-m3",
  arcId: "arc-m3",
  embeddings: {},
};

const malformedNonStringAccountId = {
  pk: "ACCT#placeholder#SIG#SES#mal4",
  sk: "#",
  id: "SES#mal4",
  accountId: 12345,
  arcId: "arc-m4",
  recipientAddress: "mal4@example.com",
  embeddings: {},
};

const malformedNullRecipient = {
  pk: "ACCT#acct-m5#SIG#SES#mal5",
  sk: "#",
  id: "SES#mal5",
  accountId: "acct-m5",
  arcId: "arc-m5",
  recipientAddress: null,
  embeddings: {},
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

function makeS3Body(content: string) {
  const stream = new Readable();
  stream.push(content);
  stream.push(null);
  return sdkStreamMixin(stream);
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

const mixedCases: Array<[string, {
  validCached: typeof validCached1[];
  validS3: typeof validS3Signal1[];
  malformed: unknown[];
}]> = [
  ["1 cached + 1 S3 + 1 malformed (missing accountId)", {
    validCached: [validCached1],
    validS3: [validS3Signal1],
    malformed: [malformedMissingAccountId],
  }],
  ["2 cached + 2 S3 + 3 malformed (all types)", {
    validCached: [validCached1, validCached2],
    validS3: [validS3Signal1, validS3Signal2],
    malformed: [malformedMissingAccountId, malformedMissingArcId, malformedMissingRecipient],
  }],
  ["only malformed signals — no valid signals", {
    validCached: [],
    validS3: [],
    malformed: [malformedMissingAccountId, malformedNonStringAccountId, malformedNullRecipient],
  }],
  ["non-string types in required fields", {
    validCached: [validCached1],
    validS3: [],
    malformed: [malformedNonStringAccountId, malformedNullRecipient],
  }],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 22: Worker isolates per-signal failures within a segment", () => {
  let worker: ReindexWorker;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    worker = new ReindexWorker(mockLogger);
    ddbMock.reset();
    bedrockMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();
    mockAddEmbeddingToCache.mockClear();
    mockGenerateForModel.mockClear();
    mockMimeParse.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(mixedCases)("%s", async (_label, { validCached, validS3, malformed }) => {
    ddbMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();
    mockAddEmbeddingToCache.mockClear();
    mockGenerateForModel.mockClear();
    mockMimeParse.mockClear();
    mockLogger.calls.length = 0;

    const allSignals = [...validCached, ...validS3, ...malformed];

    const retrievableS3Keys = new Set(
      validS3.map((s) => (s as unknown as { s3Key: string }).s3Key),
    );

    ddbMock.on(ScanCommand).resolves({ Items: allSignals, LastEvaluatedKey: undefined });
    ddbMock.on(UpdateCommand).resolves({});

    s3Mock.on(GetObjectCommand).callsFake((input) => {
      const key = input.Key as string;
      if (retrievableS3Keys.has(key)) {
        return { Body: makeS3Body("From: test@test.com\r\nSubject: Test\r\n\r\nBody content") };
      }
      const err = new Error("NoSuchKey");
      (err as unknown as { name: string }).name = "NoSuchKey";
      throw err;
    });

    mockMimeParse.mockResolvedValue({
      from: { address: "test@test.com" },
      to: [{ address: "recipient@example.com" }],
      cc: [],
      subject: "Test",
      textBody: "Body content",
      htmlBody: null,
      attachments: [],
      headers: {},
    });

    mockGenerateForModel.mockResolvedValue({
      modelId: TARGET_MODEL_ID,
      vector: [0.1, 0.2, 0.3],
      dimensions: 1024,
    });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-prop-22",
        segment: 0,
        totalSegments: 1,
        targetClusterId: TARGET_CLUSTER_ID,
        modelId: TARGET_MODEL_ID,
      }),
    ]);

    await expect(worker.process(event)).resolves.not.toThrow();

    // Count DynamoDB UpdateCommand calls to track counter increments
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const copiedCount = updateCalls.filter(
      (c) => c.args[0].input.UpdateExpression === "ADD copiedCount :one",
    ).length;
    const regeneratedCount = updateCalls.filter(
      (c) => c.args[0].input.UpdateExpression === "ADD regeneratedCount :one",
    ).length;

    expect(copiedCount).toBe(validCached.length);
    expect(regeneratedCount).toBe(validS3.length);

    const totalValid = validCached.length + validS3.length;
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(totalValid);
    expect(mockAddEmbeddingToCache).toHaveBeenCalledTimes(validS3.length);
    expect(mockGenerateForModel).toHaveBeenCalledTimes(validS3.length);

    // Each malformed signal was logged individually
    const malformedSignalIds = malformed.map((s) => (s as unknown as { id: string }).id);
    const loggedMalformedSignalIds = mockLogger.calls
      .filter((call) => call.context?.code === "reindex.worker.malformed_signal")
      .map((call) => call.context?.signalId);

    expect(loggedMalformedSignalIds.length).toBe(malformed.length);
    for (const malformedId of malformedSignalIds) {
      expect(loggedMalformedSignalIds).toContain(malformedId);
    }
  });

  it("valid signal followed by malformed signals — valid signal is processed", async () => {
    ddbMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();
    mockAddEmbeddingToCache.mockClear();
    mockGenerateForModel.mockClear();
    mockMimeParse.mockClear();
    mockLogger.calls.length = 0;

    ddbMock.on(ScanCommand).resolves({
      Items: [validCached1, malformedMissingAccountId, malformedMissingArcId],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(UpdateCommand).resolves({});

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-prop-22-mixed-order",
        segment: 0,
        totalSegments: 1,
        targetClusterId: TARGET_CLUSTER_ID,
        modelId: TARGET_MODEL_ID,
      }),
    ]);

    await expect(worker.process(event)).resolves.not.toThrow();

    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(1);
    expect(mockUpsertEmbedding).toHaveBeenCalledWith({
      clusterId: TARGET_CLUSTER_ID,
      arcId: "arc-1",
      accountId: "acct-1",
      recipientAddress: "cached1@example.com",
      embedding: [0.1, 0.2, 0.3],
    });

    const loggedMalformedSignalIds = mockLogger.calls
      .filter((call) => call.context?.code === "reindex.worker.malformed_signal")
      .map((call) => call.context?.signalId);

    expect(loggedMalformedSignalIds.length).toBe(2);
    expect(loggedMalformedSignalIds).toContain("SES#mal1");
    expect(loggedMalformedSignalIds).toContain("SES#mal2");
  });
});
