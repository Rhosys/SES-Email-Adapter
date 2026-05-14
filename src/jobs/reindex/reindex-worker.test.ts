// ---------------------------------------------------------------------------
// ReindexWorker — pure-copy mode unit tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream";
import { ReindexWorker } from "./reindex-worker.js";
import { createMockLogger } from "../../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mock functions (available before vi.mock factories run)
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

vi.mock("../../embedding/cluster-registry.js", () => ({
  getClusterById: (clusterId: string) => {
    if (clusterId === "aurora-prod-titan-v2") {
      return {
        clusterId: "aurora-prod-titan-v2",
        clusterArn: "arn:aws:rds:eu-central-1:123:cluster:aurora-prod-titan-v2",
        secretArn: "arn:aws:secretsmanager:eu-central-1:123:secret:test",
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
// DynamoDB mock
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// S3 mock
// ---------------------------------------------------------------------------

const s3Mock = mockClient(S3Client);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsRecord(body: unknown, overrides?: Partial<SQSRecord>): SQSRecord {
  return {
    messageId: "msg-1",
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
    eventSourceARN: "arn:aws:sqs:eu-central-1:123:reindex-queue",
    awsRegion: "eu-central-1",
    ...overrides,
  };
}

function makeSqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

function makeSignalItem(opts: {
  id: string;
  accountId: string;
  arcId: string;
  recipientAddress: string;
  embeddings?: Record<string, number[]>;
  s3Key?: string;
}): Record<string, unknown> {
  return {
    pk: `ACCT#${opts.accountId}#SIG#${opts.id}`,
    sk: "#",
    id: opts.id,
    accountId: opts.accountId,
    arcId: opts.arcId,
    recipientAddress: opts.recipientAddress,
    embeddings: opts.embeddings,
    ...(opts.s3Key ? { s3Key: opts.s3Key } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReindexWorker — pure-copy mode", () => {
  let worker: ReindexWorker;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    worker = new ReindexWorker(mockLogger);
    ddbMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();
    mockAddEmbeddingToCache.mockClear();
    mockGenerateForModel.mockClear();
    mockMimeParse.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("upserts cached embedding to Aurora for cache-hit signals", async () => {
    const signal = makeSignalItem({
      id: "SES#abc123",
      accountId: "acct-1",
      arcId: "arc-xyz",
      recipientAddress: "me@example.com",
      embeddings: { "amazon.titan-embed-text-v2:0": [0.1, 0.2, 0.3] },
    });

    ddbMock.on(ScanCommand).resolves({ Items: [signal], LastEvaluatedKey: undefined });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-1",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);
    expect(mockUpsertEmbedding).toHaveBeenCalledWith({
      clusterId: "aurora-prod-titan-v2",
      arcId: "arc-xyz",
      accountId: "acct-1",
      recipientAddress: "me@example.com",
      embedding: [0.1, 0.2, 0.3],
    });
  });

  it("skips signals without the target model embedding (cache miss)", async () => {
    const signal = makeSignalItem({
      id: "SES#abc123",
      accountId: "acct-1",
      arcId: "arc-xyz",
      recipientAddress: "me@example.com",
      embeddings: { "amazon.titan-embed-text-v3:0": [0.4, 0.5, 0.6] },
    });

    ddbMock.on(ScanCommand).resolves({ Items: [signal], LastEvaluatedKey: undefined });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-1",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);
    expect(mockUpsertEmbedding).not.toHaveBeenCalled();
  });

  it("skips malformed signals and continues processing", async () => {
    const malformed = { pk: "ACCT#a1#SIG#bad", sk: "#", id: "SES#bad" };
    const valid = makeSignalItem({
      id: "SES#good",
      accountId: "acct-1",
      arcId: "arc-good",
      recipientAddress: "good@example.com",
      embeddings: { "amazon.titan-embed-text-v2:0": [1.0, 2.0] },
    });

    ddbMock.on(ScanCommand).resolves({ Items: [malformed, valid], LastEvaluatedKey: undefined });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-1",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);
    // Only the valid signal should be upserted
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(1);
    expect(mockUpsertEmbedding).toHaveBeenCalledWith(expect.objectContaining({ arcId: "arc-good" }));
  });

  it("isolates per-signal Aurora failures without failing the segment", async () => {
    const signal1 = makeSignalItem({
      id: "SES#fail",
      accountId: "acct-1",
      arcId: "arc-fail",
      recipientAddress: "fail@example.com",
      embeddings: { "amazon.titan-embed-text-v2:0": [0.1] },
    });
    const signal2 = makeSignalItem({
      id: "SES#ok",
      accountId: "acct-1",
      arcId: "arc-ok",
      recipientAddress: "ok@example.com",
      embeddings: { "amazon.titan-embed-text-v2:0": [0.2] },
    });

    ddbMock.on(ScanCommand).resolves({ Items: [signal1, signal2], LastEvaluatedKey: undefined });

    // First call fails, second succeeds
    mockUpsertEmbedding
      .mockRejectedValueOnce(new Error("Aurora timeout"))
      .mockResolvedValueOnce(undefined);

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-1",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    // Should not fail the segment — per-signal failures are isolated
    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(2);
  });

  it("paginates through all scan pages", async () => {
    const signal1 = makeSignalItem({
      id: "SES#page1",
      accountId: "acct-1",
      arcId: "arc-1",
      recipientAddress: "a@example.com",
      embeddings: { "amazon.titan-embed-text-v2:0": [0.1] },
    });
    const signal2 = makeSignalItem({
      id: "SES#page2",
      accountId: "acct-1",
      arcId: "arc-2",
      recipientAddress: "b@example.com",
      embeddings: { "amazon.titan-embed-text-v2:0": [0.2] },
    });

    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [signal1], LastEvaluatedKey: { pk: "cursor" } })
      .resolvesOnce({ Items: [signal2], LastEvaluatedKey: undefined });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-1",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(2);
  });

  it("returns batchItemFailure for messages with unknown cluster", async () => {
    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-1",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "nonexistent-cluster",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(mockUpsertEmbedding).not.toHaveBeenCalled();
  });

  it("returns batchItemFailure for unparseable message body", async () => {
    const event = makeSqsEvent([
      {
        ...makeSqsRecord({}),
        body: "not valid json {{{",
      },
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(mockUpsertEmbedding).not.toHaveBeenCalled();
  });

  it("uses error log level when receiveCount exceeds threshold", async () => {
    const event = makeSqsEvent([
      makeSqsRecord(
        {
          jobId: "job-1",
          segment: 0,
          totalSegments: 1,
          targetClusterId: "nonexistent-cluster",
          modelId: "amazon.titan-embed-text-v2:0",
        },
        {
          attributes: {
            ApproximateReceiveCount: "31",
            SentTimestamp: "0",
            SenderId: "sender",
            ApproximateFirstReceiveTimestamp: "0",
          },
        },
      ),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    const errorCalls = mockLogger.calls.filter((c) => c.method === "error");
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("skips non-signal items (arcs, grouping keys) without error", async () => {
    const arcItem = { pk: "ACCT#a1#ARC#arc-1", sk: "#", id: "arc-1", accountId: "a1", workflow: "auth" };
    const gkeyItem = { pk: "GKEY#a1#somekey", sk: "GKEY", arcId: "arc-1" };
    const signal = makeSignalItem({
      id: "SES#real",
      accountId: "acct-1",
      arcId: "arc-real",
      recipientAddress: "real@example.com",
      embeddings: { "amazon.titan-embed-text-v2:0": [0.5] },
    });

    ddbMock.on(ScanCommand).resolves({ Items: [arcItem, gkeyItem, signal], LastEvaluatedKey: undefined });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-1",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);
    // Only the real signal should be processed
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(1);
  });

  it("passes correct Segment and TotalSegments to DynamoDB scan", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-1",
        segment: 7,
        totalSegments: 32,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);
    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls.length).toBe(1);
    expect(scanCalls[0]!.args[0].input.Segment).toBe(7);
    expect(scanCalls[0]!.args[0].input.TotalSegments).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// ReindexWorker — regenerate-from-S3 mode
// ---------------------------------------------------------------------------

describe("ReindexWorker — regenerate-from-S3 mode", () => {
  let worker: ReindexWorker;

  beforeEach(() => {
    worker = new ReindexWorker(createMockLogger());
    ddbMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();
    mockAddEmbeddingToCache.mockClear();
    mockGenerateForModel.mockClear();
    mockMimeParse.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeS3Body(content: string) {
    const stream = new Readable();
    stream.push(content);
    stream.push(null);
    return sdkStreamMixin(stream);
  }

  it("regenerates embedding from S3 when cache miss and s3Key is present", async () => {
    const signal = makeSignalItem({
      id: "SES#regen1",
      accountId: "acct-1",
      arcId: "arc-regen",
      recipientAddress: "regen@example.com",
      embeddings: { "amazon.titan-embed-text-v3:0": [0.9] }, // different model, not the target
      s3Key: "inbox/2025/01/regen1.eml",
    });

    ddbMock.on(ScanCommand).resolves({ Items: [signal], LastEvaluatedKey: undefined });

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeS3Body("From: sender@test.com\r\nTo: regen@example.com\r\nSubject: Test\r\n\r\nHello world"),
    });

    mockMimeParse.mockResolvedValue({
      from: { address: "sender@test.com" },
      to: [{ address: "regen@example.com" }],
      cc: [],
      subject: "Test",
      textBody: "Hello world",
      htmlBody: null,
      attachments: [],
      headers: {},
    });

    mockGenerateForModel.mockResolvedValue({
      modelId: "amazon.titan-embed-text-v2:0",
      vector: [0.1, 0.2, 0.3],
      dimensions: 1024,
    });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-regen",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);

    // Should call S3 to fetch the raw email
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);

    // Should call MIME parser
    expect(mockMimeParse).toHaveBeenCalledTimes(1);

    // Should call Bedrock via embedding generator
    expect(mockGenerateForModel).toHaveBeenCalledTimes(1);
    expect(mockGenerateForModel).toHaveBeenCalledWith(
      expect.any(String),
      "amazon.titan-embed-text-v2:0",
    );

    // Should write back to DynamoDB cache
    expect(mockAddEmbeddingToCache).toHaveBeenCalledWith(
      "acct-1",
      "SES#regen1",
      "amazon.titan-embed-text-v2:0",
      [0.1, 0.2, 0.3],
    );

    // Should upsert to Aurora
    expect(mockUpsertEmbedding).toHaveBeenCalledWith({
      clusterId: "aurora-prod-titan-v2",
      arcId: "arc-regen",
      accountId: "acct-1",
      recipientAddress: "regen@example.com",
      embedding: [0.1, 0.2, 0.3],
    });
  });

  it("skips Bedrock entirely when cache entry already exists (cache-hit guard)", async () => {
    const signal = makeSignalItem({
      id: "SES#cached",
      accountId: "acct-1",
      arcId: "arc-cached",
      recipientAddress: "cached@example.com",
      embeddings: { "amazon.titan-embed-text-v2:0": [0.5, 0.6, 0.7] },
      s3Key: "inbox/2025/01/cached.eml",
    });

    ddbMock.on(ScanCommand).resolves({ Items: [signal], LastEvaluatedKey: undefined });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-cached",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);

    // Should NOT call S3 or Bedrock — cache hit takes the pure-copy path
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(mockGenerateForModel).not.toHaveBeenCalled();

    // Should upsert the cached vector directly
    expect(mockUpsertEmbedding).toHaveBeenCalledWith({
      clusterId: "aurora-prod-titan-v2",
      arcId: "arc-cached",
      accountId: "acct-1",
      recipientAddress: "cached@example.com",
      embedding: [0.5, 0.6, 0.7],
    });
  });

  it("handles mixed signals: cache hit + cache miss + unrecoverable in one segment", async () => {
    const cachedSignal = makeSignalItem({
      id: "SES#hit",
      accountId: "acct-1",
      arcId: "arc-hit",
      recipientAddress: "hit@example.com",
      embeddings: { "amazon.titan-embed-text-v2:0": [1.0] },
      s3Key: "inbox/hit.eml",
    });
    const regenSignal = makeSignalItem({
      id: "SES#miss",
      accountId: "acct-1",
      arcId: "arc-miss",
      recipientAddress: "miss@example.com",
      embeddings: {},
      s3Key: "inbox/miss.eml",
    });
    const expiredSignal = makeSignalItem({
      id: "SES#gone",
      accountId: "acct-1",
      arcId: "arc-gone",
      recipientAddress: "gone@example.com",
      embeddings: {},
      s3Key: "inbox/gone.eml",
    });

    ddbMock.on(ScanCommand).resolves({
      Items: [cachedSignal, regenSignal, expiredSignal],
      LastEvaluatedKey: undefined,
    });

    // S3: first call (for regenSignal) succeeds, second (for expiredSignal) returns NoSuchKey
    s3Mock
      .on(GetObjectCommand, { Key: "inbox/miss.eml" })
      .resolves({ Body: makeS3Body("From: a@b.com\r\nSubject: Hi\r\n\r\nBody") });

    const noSuchKeyError = new Error("NoSuchKey");
    (noSuchKeyError as unknown as { name: string }).name = "NoSuchKey";
    s3Mock
      .on(GetObjectCommand, { Key: "inbox/gone.eml" })
      .rejects(noSuchKeyError);

    mockMimeParse.mockResolvedValue({
      from: { address: "a@b.com" },
      to: [{ address: "miss@example.com" }],
      cc: [],
      subject: "Hi",
      textBody: "Body",
      htmlBody: null,
      attachments: [],
      headers: {},
    });

    mockGenerateForModel.mockResolvedValue({
      modelId: "amazon.titan-embed-text-v2:0",
      vector: [0.2, 0.3],
      dimensions: 1024,
    });

    const event = makeSqsEvent([
      makeSqsRecord({
        jobId: "job-mixed",
        segment: 0,
        totalSegments: 1,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
      }),
    ]);

    const result = await worker.process(event);

    expect(result.batchItemFailures).toEqual([]);

    // Aurora upsert called twice: once for cache hit, once for regenerated
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(2);

    // Bedrock called once (only for the regenerated signal)
    expect(mockGenerateForModel).toHaveBeenCalledTimes(1);

    // Cache write called once (only for the regenerated signal)
    expect(mockAddEmbeddingToCache).toHaveBeenCalledTimes(1);
  });
});
