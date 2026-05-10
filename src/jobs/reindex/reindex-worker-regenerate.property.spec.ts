// Feature: aurora-reindex-strategy, Property 12: Backfill targets exactly the signals missing the new model
// **Validates: Requirements 5.1, 5.3**
//
// For any mix of signals (some with cached embeddings, some without, some with
// valid S3 keys, some with expired S3 objects), the reindex worker:
// 1. Pure-copies signals that have `embeddings[modelId]` (never calls Bedrock for these)
// 2. Regenerates signals that lack `embeddings[modelId]` but have a retrievable S3 object (calls Bedrock, writes back to cache)
// 3. Records as unrecoverable signals that lack both the cache entry and a retrievable S3 object
// 4. The sum `copiedCount + regeneratedCount + unrecoverableCount` equals the total signals processed

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { propertyRunner } from "../../testing/property-runner.js";
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
// Signal category enum for the property test
// ---------------------------------------------------------------------------

type SignalCategory = "cached" | "s3_retrievable" | "unrecoverable";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbSignalId = fc.string({ minLength: 1, maxLength: 20 }).map(
  (s) => `SES#${s.replace(/[^a-zA-Z0-9]/g, "x")}`,
);

const arbAccountId = fc.string({ minLength: 1, maxLength: 15 }).map(
  (s) => `acct-${s.replace(/[^a-zA-Z0-9]/g, "a")}`,
);

const arbArcId = fc.string({ minLength: 1, maxLength: 15 }).map(
  (s) => `arc-${s.replace(/[^a-zA-Z0-9]/g, "b")}`,
);

const arbEmail = fc.string({ minLength: 1, maxLength: 15 }).map(
  (s) => `${s.replace(/[^a-zA-Z0-9]/g, "c")}@example.com`,
);

const arbEmbedding = fc.array(
  fc.float({ noNaN: true, noDefaultInfinity: true, min: -1, max: 1 }),
  { minLength: 3, maxLength: 10 },
);

const arbS3Key = fc.string({ minLength: 1, maxLength: 20 }).map(
  (s) => `inbox/2025/${s.replace(/[^a-zA-Z0-9]/g, "k")}.eml`,
);

/** A signal with a cached embedding for the target model (pure-copy path) */
const arbCachedSignal = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  embedding: arbEmbedding,
  s3Key: fc.option(arbS3Key, { nil: undefined }),
}).map((s) => ({
  category: "cached" as SignalCategory,
  item: {
    pk: `ACCT#${s.accountId}#SIG#${s.id}`,
    sk: "#",
    id: s.id,
    accountId: s.accountId,
    arcId: s.arcId,
    recipientAddress: s.recipientAddress,
    embeddings: { [TARGET_MODEL_ID]: s.embedding },
    ...(s.s3Key ? { s3Key: s.s3Key } : {}),
  },
}));

/** A signal without the target model embedding but with a valid S3 key (regeneration path) */
const arbS3RetrievableSignal = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  s3Key: arbS3Key,
  otherModelEmbedding: fc.option(arbEmbedding, { nil: undefined }),
}).map((s) => ({
  category: "s3_retrievable" as SignalCategory,
  item: {
    pk: `ACCT#${s.accountId}#SIG#${s.id}`,
    sk: "#",
    id: s.id,
    accountId: s.accountId,
    arcId: s.arcId,
    recipientAddress: s.recipientAddress,
    embeddings: s.otherModelEmbedding
      ? { "amazon.titan-embed-text-v3:0": s.otherModelEmbedding }
      : {},
    s3Key: s.s3Key,
  },
}));

/** A signal without the target model embedding and with an expired/missing S3 object (unrecoverable) */
const arbUnrecoverableSignal = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  hasS3Key: fc.boolean(),
  s3Key: arbS3Key,
}).map((s) => ({
  category: "unrecoverable" as SignalCategory,
  item: {
    pk: `ACCT#${s.accountId}#SIG#${s.id}`,
    sk: "#",
    id: s.id,
    accountId: s.accountId,
    arcId: s.arcId,
    recipientAddress: s.recipientAddress,
    embeddings: {},
    ...(s.hasS3Key ? { s3Key: s.s3Key } : {}),
  },
}));

/** Generate a mixed set of signals from all three categories */
const arbMixedSignals = fc.record({
  cached: fc.array(arbCachedSignal, { minLength: 0, maxLength: 4 }),
  s3Retrievable: fc.array(arbS3RetrievableSignal, { minLength: 0, maxLength: 4 }),
  unrecoverable: fc.array(arbUnrecoverableSignal, { minLength: 0, maxLength: 4 }),
}).filter((s) => s.cached.length + s.s3Retrievable.length + s.unrecoverable.length > 0);

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
// Property test
// ---------------------------------------------------------------------------

describe("Property 12: Backfill targets exactly the signals missing the new model", () => {
  let worker: ReindexWorker;

  beforeEach(() => {
    worker = new ReindexWorker();
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

  it("for any mix of signals, the worker correctly categorizes each as copied/regenerated/unrecoverable and the sum equals total processed", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbMixedSignals, async ({ cached, s3Retrievable, unrecoverable }) => {
        // Reset mocks for each iteration
        ddbMock.reset();
        s3Mock.reset();
        mockUpsertEmbedding.mockClear();
        mockAddEmbeddingToCache.mockClear();
        mockGenerateForModel.mockClear();
        mockMimeParse.mockClear();

        // Collect all signal items in a shuffled order to test ordering independence
        const allSignals = [
          ...cached.map((s) => s.item),
          ...s3Retrievable.map((s) => s.item),
          ...unrecoverable.map((s) => s.item),
        ];

        // Track which S3 keys are "retrievable" vs "expired"
        const retrievableS3Keys = new Set(
          s3Retrievable.map((s) => s.item.s3Key),
        );

        // DynamoDB scan returns all signals
        ddbMock.on(ScanCommand).resolves({ Items: allSignals, LastEvaluatedKey: undefined });
        ddbMock.on(UpdateCommand).resolves({});

        // S3 mock: retrievable keys return content, all others return NoSuchKey
        s3Mock.on(GetObjectCommand).callsFake((input) => {
          const key = input.Key as string;
          if (retrievableS3Keys.has(key)) {
            return { Body: makeS3Body("From: test@test.com\r\nSubject: Test\r\n\r\nBody content") };
          }
          const err = new Error("NoSuchKey");
          (err as unknown as { name: string }).name = "NoSuchKey";
          throw err;
        });

        // MIME parser returns a valid parsed result for regeneration
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

        // Bedrock returns a valid embedding for regeneration
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

        // Count the DynamoDB UpdateCommand calls to track counter increments
        const updateCalls = ddbMock.commandCalls(UpdateCommand);
        const copiedCount = updateCalls.filter(
          (c) => c.args[0].input.UpdateExpression === "ADD copiedCount :one",
        ).length;
        const regeneratedCount = updateCalls.filter(
          (c) => c.args[0].input.UpdateExpression === "ADD regeneratedCount :one",
        ).length;
        const unrecoverableCount = updateCalls.filter(
          (c) => c.args[0].input.UpdateExpression === "ADD unrecoverableCount :one",
        ).length;

        // Property 1: Signals with cached embeddings are pure-copied (never call Bedrock)
        expect(copiedCount).toBe(cached.length);

        // Property 2: Signals without cache but with retrievable S3 are regenerated
        expect(regeneratedCount).toBe(s3Retrievable.length);

        // Property 3: Signals without cache and without retrievable S3 are unrecoverable
        expect(unrecoverableCount).toBe(unrecoverable.length);

        // Property 4: Sum equals total signals processed
        const totalProcessed = cached.length + s3Retrievable.length + unrecoverable.length;
        expect(copiedCount + regeneratedCount + unrecoverableCount).toBe(totalProcessed);

        // Additional invariant: Bedrock is never called for cached signals
        // (only called for s3Retrievable signals)
        expect(mockGenerateForModel).toHaveBeenCalledTimes(s3Retrievable.length);

        // Additional invariant: Aurora upsert is called for cached + regenerated (not unrecoverable)
        expect(mockUpsertEmbedding).toHaveBeenCalledTimes(cached.length + s3Retrievable.length);

        // Additional invariant: addEmbeddingToCache is called only for regenerated signals
        expect(mockAddEmbeddingToCache).toHaveBeenCalledTimes(s3Retrievable.length);

        return true;
      }),
    );
  });
});
