// Feature: aurora-reindex-strategy, Property 12: Backfill targets exactly the signals missing the new model
// **Validates: Requirements 5.1, 5.3**
//
// For any mix of signals (some with cached embeddings, some without, some with
// valid S3 keys, some with expired S3 objects), the reindex worker:
// 1. Pure-copies signals that have `embeddings[modelId]` (never calls Bedrock for these)
// 2. Regenerates signals that lack `embeddings[modelId]` but have a retrievable S3 object (calls Bedrock, writes back to cache)
// 3. Records as unrecoverable signals that lack both the cache entry and a retrievable S3 object

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
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

// Cached signals (pure-copy path) — have embeddings[TARGET_MODEL_ID]
const cachedSignal1 = {
  pk: "ACCT#acct-1#SIG#SES#cached1",
  sk: "#",
  id: "SES#cached1",
  accountId: "acct-1",
  arcId: "arc-c1",
  recipientAddress: "cached1@example.com",
  embeddings: { [TARGET_MODEL_ID]: [0.1, 0.2, 0.3] },
  s3Key: "inbox/2025/cached1.eml",
};

const cachedSignal2 = {
  pk: "ACCT#acct-2#SIG#SES#cached2",
  sk: "#",
  id: "SES#cached2",
  accountId: "acct-2",
  arcId: "arc-c2",
  recipientAddress: "cached2@example.com",
  embeddings: { [TARGET_MODEL_ID]: [0.4, 0.5, 0.6] },
  s3Key: "inbox/2025/cached2.eml",
};

// S3-retrievable signals (regeneration path) — no target model embedding, but S3 key works
const s3Signal1 = {
  pk: "ACCT#acct-3#SIG#SES#s3regen1",
  sk: "#",
  id: "SES#s3regen1",
  accountId: "acct-3",
  arcId: "arc-s1",
  recipientAddress: "s3regen1@example.com",
  embeddings: { "amazon.titan-embed-text-v3:0": [0.9, 0.8] },
  s3Key: "inbox/2025/s3regen1.eml",
};

const s3Signal2 = {
  pk: "ACCT#acct-4#SIG#SES#s3regen2",
  sk: "#",
  id: "SES#s3regen2",
  accountId: "acct-4",
  arcId: "arc-s2",
  recipientAddress: "s3regen2@example.com",
  embeddings: { "amazon.titan-embed-text-v3:0": [0.7, 0.8] },
  s3Key: "inbox/2025/s3regen2.eml",
};

// Unrecoverable signals — no target model embedding AND no retrievable S3 object
const unrecoverableNoS3Key = {
  pk: "ACCT#acct-5#SIG#SES#unrec1",
  sk: "#",
  id: "SES#unrec1",
  accountId: "acct-5",
  arcId: "arc-u1",
  recipientAddress: "unrec1@example.com",
  embeddings: {},
  // no s3Key
};

const unrecoverableExpiredS3 = {
  pk: "ACCT#acct-6#SIG#SES#unrec2",
  sk: "#",
  id: "SES#unrec2",
  accountId: "acct-6",
  arcId: "arc-u2",
  recipientAddress: "unrec2@example.com",
  embeddings: {},
  s3Key: "inbox/2025/expired.eml", // S3 will return NoSuchKey
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsRecord(body: unknown): SQSRecord {
  return {
    messageId: "msg-prop-12",
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
// Edge cases — different mixes of signal categories
// ---------------------------------------------------------------------------

const cases: Array<[string, {
  cached: typeof cachedSignal1[];
  s3Retrievable: typeof s3Signal1[];
  unrecoverable: typeof unrecoverableNoS3Key[];
}]> = [
  ["all cached — pure copy only", {
    cached: [cachedSignal1, cachedSignal2],
    s3Retrievable: [],
    unrecoverable: [],
  }],
  ["all S3-retrievable — regeneration only", {
    cached: [],
    s3Retrievable: [s3Signal1, s3Signal2],
    unrecoverable: [],
  }],
  ["all unrecoverable — nothing to write", {
    cached: [],
    s3Retrievable: [],
    unrecoverable: [unrecoverableNoS3Key, unrecoverableExpiredS3],
  }],
  ["one of each category", {
    cached: [cachedSignal1],
    s3Retrievable: [s3Signal1],
    unrecoverable: [unrecoverableNoS3Key],
  }],
  ["mixed — 2 cached, 2 S3, 2 unrecoverable", {
    cached: [cachedSignal1, cachedSignal2],
    s3Retrievable: [s3Signal1, s3Signal2],
    unrecoverable: [unrecoverableNoS3Key, unrecoverableExpiredS3],
  }],
  ["unrecoverable with expired S3 key (NoSuchKey)", {
    cached: [cachedSignal1],
    s3Retrievable: [s3Signal1],
    unrecoverable: [unrecoverableExpiredS3],
  }],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 12: Backfill targets exactly the signals missing the new model", () => {
  let worker: ReindexWorker;

  beforeEach(() => {
    worker = new ReindexWorker(createMockLogger());
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

  it.each(cases)("%s", async (_label, { cached, s3Retrievable, unrecoverable }) => {
    ddbMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();
    mockAddEmbeddingToCache.mockClear();
    mockGenerateForModel.mockClear();
    mockMimeParse.mockClear();

    const allSignals = [
      ...cached,
      ...s3Retrievable,
      ...unrecoverable,
    ];

    const retrievableS3Keys = new Set(
      s3Retrievable.map((s) => s.s3Key),
    );

    ddbMock.on(ScanCommand).resolves({ Items: allSignals, LastEvaluatedKey: undefined });

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
        jobId: "job-prop-12",
        segment: 0,
        totalSegments: 1,
        targetClusterId: TARGET_CLUSTER_ID,
        modelId: TARGET_MODEL_ID,
      }),
    ]);

    await worker.process(event);

    // Bedrock is never called for cached signals (only for s3Retrievable)
    expect(mockGenerateForModel).toHaveBeenCalledTimes(s3Retrievable.length);

    // Aurora upsert is called for cached + regenerated (not unrecoverable)
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(cached.length + s3Retrievable.length);

    // addEmbeddingToCache is called only for regenerated signals
    expect(mockAddEmbeddingToCache).toHaveBeenCalledTimes(s3Retrievable.length);
  });
});
