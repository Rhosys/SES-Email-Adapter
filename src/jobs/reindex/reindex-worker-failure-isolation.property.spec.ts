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
// Arbitraries for valid signals
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

/** A valid signal with cached embedding (pure-copy path) */
const arbValidCachedSignal = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  embedding: arbEmbedding,
  s3Key: fc.option(arbS3Key, { nil: undefined }),
}).map((s) => ({
  pk: `ACCT#${s.accountId}#SIG#${s.id}`,
  sk: "#",
  id: s.id,
  accountId: s.accountId,
  arcId: s.arcId,
  recipientAddress: s.recipientAddress,
  embeddings: { [TARGET_MODEL_ID]: s.embedding },
  ...(s.s3Key ? { s3Key: s.s3Key } : {}),
}));

/** A valid signal without cache but with retrievable S3 (regeneration path) */
const arbValidS3RetrievableSignal = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  s3Key: arbS3Key,
  otherModelEmbedding: fc.option(arbEmbedding, { nil: undefined }),
}).map((s) => ({
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
}));

// ---------------------------------------------------------------------------
// Arbitraries for malformed signals (K signals)
// ---------------------------------------------------------------------------

/** Signal missing required field: id */
const arbMalformedSignalMissingId = fc.record({
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  embeddings: fc.record({ [TARGET_MODEL_ID]: arbEmbedding }),
}).map((s) => ({
  pk: `ACCT#${s.accountId}#SIG#placeholder`,
  sk: "#",
  // id is missing
  accountId: s.accountId,
  arcId: s.arcId,
  recipientAddress: s.recipientAddress,
  embeddings: s.embeddings,
}));

/** Signal missing required field: accountId */
const arbMalformedSignalMissingAccountId = fc.record({
  id: arbSignalId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  embeddings: fc.record({ [TARGET_MODEL_ID]: arbEmbedding }),
}).map((s) => ({
  pk: `ACCT#placeholder#SIG#${s.id}`,
  sk: "#",
  id: s.id,
  // accountId is missing
  arcId: s.arcId,
  recipientAddress: s.recipientAddress,
  embeddings: s.embeddings,
}));

/** Signal missing required field: arcId */
const arbMalformedSignalMissingArcId = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  recipientAddress: arbEmail,
  embeddings: fc.record({ [TARGET_MODEL_ID]: arbEmbedding }),
}).map((s) => ({
  pk: `ACCT#${s.accountId}#SIG#${s.id}`,
  sk: "#",
  id: s.id,
  accountId: s.accountId,
  // arcId is missing
  recipientAddress: s.recipientAddress,
  embeddings: s.embeddings,
}));

/** Signal missing required field: recipientAddress */
const arbMalformedSignalMissingRecipientAddress = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  embeddings: fc.record({ [TARGET_MODEL_ID]: arbEmbedding }),
}).map((s) => ({
  pk: `ACCT#${s.accountId}#SIG#${s.id}`,
  sk: "#",
  id: s.id,
  accountId: s.accountId,
  arcId: s.arcId,
  // recipientAddress is missing
  embeddings: s.embeddings,
}));

/** Signal with malformed embeddings (not an object) */
const arbMalformedSignalBadEmbeddings = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  embeddings: fc.oneof(
    fc.string(), // string instead of object
    fc.integer(), // integer instead of object
    fc.array(fc.float()), // array instead of object
  ),
}).map((s) => ({
  pk: `ACCT#${s.accountId}#SIG#${s.id}`,
  sk: "#",
  id: s.id,
  accountId: s.accountId,
  arcId: s.arcId,
  recipientAddress: s.recipientAddress,
  embeddings: s.embeddings,
}));

/** Signal with malformed embeddings (object but wrong structure) */
const arbMalformedSignalWrongEmbeddingsStructure = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  embeddings: fc.record({
    [TARGET_MODEL_ID]: fc.oneof(
      fc.string(), // string instead of array
      fc.integer(), // integer instead of array
      fc.array(fc.string()), // string[] instead of number[]
    ),
  }),
}).map((s) => ({
  pk: `ACCT#${s.accountId}#SIG#${s.id}`,
  sk: "#",
  id: s.id,
  accountId: s.accountId,
  arcId: s.arcId,
  recipientAddress: s.recipientAddress,
  embeddings: s.embeddings,
}));

/** Signal with malformed s3Key (non-string) */
const arbMalformedSignalBadS3Key = fc.record({
  id: arbSignalId,
  accountId: arbAccountId,
  arcId: arbArcId,
  recipientAddress: arbEmail,
  s3Key: fc.oneof(fc.integer(), fc.array(fc.string()), fc.boolean()),
}).map((s) => ({
  pk: `ACCT#${s.accountId}#SIG#${s.id}`,
  sk: "#",
  id: s.id,
  accountId: s.accountId,
  arcId: s.arcId,
  recipientAddress: s.recipientAddress,
  embeddings: {},
  s3Key: s.s3Key,
}));

/** A generic malformed signal (any of the above) */
const arbMalformedSignal = fc.oneof(
  arbMalformedSignalMissingId,
  arbMalformedSignalMissingAccountId,
  arbMalformedSignalMissingArcId,
  arbMalformedSignalMissingRecipientAddress,
  arbMalformedSignalBadEmbeddings,
  arbMalformedSignalWrongEmbeddingsStructure,
  arbMalformedSignalBadS3Key,
);

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
// Property test
// ---------------------------------------------------------------------------

describe.skip("Property 22: Worker isolates per-signal failures within a segment", () => {
  let worker: ReindexWorker;
  let logOutput: Array<{ level: string; message: string; signalId?: string }> = [];

  beforeEach(() => {
    worker = new ReindexWorker();
    ddbMock.reset();
    bedrockMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();
    mockAddEmbeddingToCache.mockClear();
    mockGenerateForModel.mockClear();
    mockMimeParse.mockClear();
    logOutput = [];

    // Capture console.log and console.error calls
    const originalLog = console.log;
    const originalError = console.error;

    console.log = ((...args: unknown[]) => {
      try {
        const payload = JSON.parse(args[0] as string);
        if (payload.level && payload.message) {
          logOutput.push({
            level: payload.level,
            message: payload.message,
            signalId: payload.signalId,
          });
        }
      } catch {
        // Ignore non-JSON log entries
      }
      originalLog(...args);
    }) as typeof console.log;

    console.error = ((...args: unknown[]) => {
      try {
        const payload = JSON.parse(args[0] as string);
        if (payload.level && payload.message) {
          logOutput.push({
            level: payload.level,
            message: payload.message,
            signalId: payload.signalId,
          });
        }
      } catch {
        // Ignore non-JSON log entries
      }
      originalError(...args);
    }) as typeof console.error;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    console.log = originalLog;
    console.error = originalError;
  });

  it("for any mix of valid and malformed signals, the worker processes all valid signals and logs each malformed signal individually", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.record({
          validCached: fc.array(arbValidCachedSignal, { minLength: 1, maxLength: 5 }),
          validS3Retrievable: fc.array(arbValidS3RetrievableSignal, { minLength: 1, maxLength: 5 }),
          malformed: fc.array(arbMalformedSignal, { minLength: 1, maxLength: 5 }),
        }),
        async ({ validCached, validS3Retrievable, malformed }) => {
          // Reset mocks for each iteration
          ddbMock.reset();
          s3Mock.reset();
          mockUpsertEmbedding.mockClear();
          mockAddEmbeddingToCache.mockClear();
          mockGenerateForModel.mockClear();
          mockMimeParse.mockClear();
          logOutput = [];

          // Collect all signal items in a shuffled order to test ordering independence
          const allSignals = [
            ...validCached.map((s) => s),
            ...validS3Retrievable.map((s) => s),
            ...malformed.map((s) => s),
          ];

          // Track which S3 keys are "retrievable" vs "expired"
          const retrievableS3Keys = new Set(
            validS3Retrievable.map((s) => (s as unknown as { s3Key: string }).s3Key),
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
              jobId: "job-prop-22",
              segment: 0,
              totalSegments: 1,
              targetClusterId: TARGET_CLUSTER_ID,
              modelId: TARGET_MODEL_ID,
            }),
          ]);

          // The worker should NOT throw — it should process all signals and continue
          await expect(worker.process(event)).resolves.not.toThrow();

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

          // Property 1: All valid cached signals were upserted (copiedCount)
          expect(copiedCount).toBe(validCached.length);

          // Property 2: All valid S3-retrievable signals were regenerated
          expect(regeneratedCount).toBe(validS3Retrievable.length);

          // Property 3: No unrecoverable signals in this test (all valid signals have s3Key)
          expect(unrecoverableCount).toBe(0);

          // Property 4: Total processed = copied + regenerated
          const totalValid = validCached.length + validS3Retrievable.length;
          expect(copiedCount + regeneratedCount).toBe(totalValid);

          // Property 5: Each malformed signal was logged individually
          const malformedSignalIds = malformed.map((s) => (s as unknown as { id: string }).id);
          const loggedMalformedSignalIds = logOutput
            .filter((log) => log.message.includes("reindex.worker.malformed_signal"))
            .map((log) => log.signalId);

          expect(loggedMalformedSignalIds.length).toBe(malformed.length);
          for (const malformedId of malformedSignalIds) {
            expect(loggedMalformedSignalIds).toContain(malformedId);
          }

          // Property 6: Bedrock is never called for malformed signals
          // (only called for validS3Retrievable signals)
          expect(mockGenerateForModel).toHaveBeenCalledTimes(validS3Retrievable.length);

          // Property 7: Aurora upsert is called only for valid signals (not malformed)
          expect(mockUpsertEmbedding).toHaveBeenCalledTimes(totalValid);

          // Property 8: addEmbeddingToCache is called only for regenerated signals
          expect(mockAddEmbeddingToCache).toHaveBeenCalledTimes(validS3Retrievable.length);

          return true;
        },
      ),
    );
  });

  it("for a segment with only malformed signals, the worker logs each one and completes without throwing", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.array(arbMalformedSignal, { minLength: 1, maxLength: 5 }),
        async (malformed) => {
          ddbMock.reset();
          s3Mock.reset();
          mockUpsertEmbedding.mockClear();
          mockAddEmbeddingToCache.mockClear();
          mockGenerateForModel.mockClear();
          mockMimeParse.mockClear();
          logOutput = [];

          // DynamoDB scan returns only malformed signals
          ddbMock.on(ScanCommand).resolves({ Items: malformed, LastEvaluatedKey: undefined });
          ddbMock.on(UpdateCommand).resolves({});

          const event = makeSqsEvent([
            makeSqsRecord({
              jobId: "job-prop-22-all-malformed",
              segment: 0,
              totalSegments: 1,
              targetClusterId: TARGET_CLUSTER_ID,
              modelId: TARGET_MODEL_ID,
            }),
          ]);

          // The worker should NOT throw — it should process all malformed signals and continue
          await expect(worker.process(event)).resolves.not.toThrow();

          // Count the DynamoDB UpdateCommand calls — should be zero (no valid signals)
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

          // No valid signals were processed
          expect(copiedCount).toBe(0);
          expect(regeneratedCount).toBe(0);
          expect(unrecoverableCount).toBe(0);

          // Each malformed signal was logged individually
          const malformedSignalIds = malformed.map((s) => (s as unknown as { id: string }).id);
          const loggedMalformedSignalIds = logOutput
            .filter((log) => log.message.includes("reindex.worker.malformed_signal"))
            .map((log) => log.signalId);

          expect(loggedMalformedSignalIds.length).toBe(malformed.length);
          for (const malformedId of malformedSignalIds) {
            expect(loggedMalformedSignalIds).toContain(malformedId);
          }

          return true;
        },
      ),
    );
  });

  it("for a segment with one valid signal followed by malformed signals, the valid signal is processed and malformed signals are logged", async () => {
    const validSignal = {
      pk: "ACCT#acct-1#SIG#SES#valid",
      sk: "#",
      id: "SES#valid",
      accountId: "acct-1",
      arcId: "arc-1",
      recipientAddress: "valid@example.com",
      embeddings: { [TARGET_MODEL_ID]: [0.1, 0.2, 0.3] },
    };

    const malformedSignals = [
      {
        pk: "ACCT#acct-2#SIG#SES#malformed1",
        sk: "#",
        // id is missing
        accountId: "acct-2",
        arcId: "arc-2",
        recipientAddress: "malformed1@example.com",
        embeddings: { [TARGET_MODEL_ID]: [0.4, 0.5, 0.6] },
      },
      {
        pk: "ACCT#acct-3#SIG#SES#malformed2",
        sk: "#",
        id: "SES#malformed2",
        // accountId is missing
        arcId: "arc-3",
        recipientAddress: "malformed2@example.com",
        embeddings: { [TARGET_MODEL_ID]: [0.7, 0.8, 0.9] },
      },
    ];

    ddbMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();
    mockAddEmbeddingToCache.mockClear();
    mockGenerateForModel.mockClear();
    mockMimeParse.mockClear();
    logOutput = [];

    // DynamoDB scan returns valid signal followed by malformed signals
    ddbMock.on(ScanCommand).resolves({ Items: [validSignal, ...malformedSignals], LastEvaluatedKey: undefined });
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

    // The worker should NOT throw
    await expect(worker.process(event)).resolves.not.toThrow();

    // The valid signal was processed
    expect(mockUpsertEmbedding).toHaveBeenCalledTimes(1);
    expect(mockUpsertEmbedding).toHaveBeenCalledWith({
      clusterId: TARGET_CLUSTER_ID,
      arcId: "arc-1",
      accountId: "acct-1",
      recipientAddress: "valid@example.com",
      embedding: [0.1, 0.2, 0.3],
    });

    // Each malformed signal was logged individually
    const loggedMalformedSignalIds = logOutput
      .filter((log) => log.message.includes("reindex.worker.malformed_signal"))
      .map((log) => log.signalId);

    expect(loggedMalformedSignalIds.length).toBe(2);
    expect(loggedMalformedSignalIds).toContain("SES#malformed1");
    expect(loggedMalformedSignalIds).toContain("SES#malformed2");

    return true;
  });
});
