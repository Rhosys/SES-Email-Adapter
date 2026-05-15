// Feature: split-embedding-pipeline, Property 7: Reindex worker propagates Result errors
// **Validates: Requirements 4.1**
//
// For any BedrockError returned by `generateForModel` during reindex, the worker
// SHALL return an error result containing the signal ID and a reason string —
// without throwing or using non-null assertions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { createMockLogger, type MockLogger } from "../../testing/mock-logger.js";
import { ReindexWorker } from "./reindex-worker.js";
import { err } from "../../errors.js";
import type { BedrockError } from "../../errors.js";

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
// Mock ArcDatabase
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
  getRegistryById: (registryId: string) => {
    if (registryId === "aurora-prod-titan-v2") {
      return {
        registryId: "aurora-prod-titan-v2",
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
const s3Mock = mockClient(S3Client);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsRecord(body: unknown): SQSRecord {
  return {
    messageId: "msg-prop-7",
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
// Generators
// ---------------------------------------------------------------------------

/** Generates a non-empty signal ID (SES#<alphanumeric>) */
const signalIdArb = fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/).map((s) => `SES#${s}`);

/** Generates a non-empty error cause message */
const errorCauseArb = fc.stringMatching(/^[a-zA-Z0-9 _.-]{1,80}$/);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 7: Reindex worker propagates Result errors", () => {
  let worker: ReindexWorker;
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
    worker = new ReindexWorker(logger);
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

  it("returns err with signalId and reason when generateForModel returns Err — never throws", async () => {
    await fc.assert(
      fc.asyncProperty(signalIdArb, errorCauseArb, async (signalId, errorCause) => {
        ddbMock.reset();
        s3Mock.reset();
        mockUpsertEmbedding.mockClear();
        mockAddEmbeddingToCache.mockClear();
        mockGenerateForModel.mockClear();
        mockMimeParse.mockClear();
        logger.calls.length = 0;

        // Signal without cached embedding for target model → triggers regeneration path
        const signal = {
          pk: `ACCT#acct-test#SIG#${signalId}`,
          sk: "#",
          id: signalId,
          accountId: "acct-test",
          arcId: "arc-test",
          recipientAddress: "test@example.com",
          embeddings: {},
          s3Key: "inbox/2025/test.eml",
        };

        ddbMock.on(ScanCommand).resolves({ Items: [signal], LastEvaluatedKey: undefined });

        // S3 returns valid MIME content
        s3Mock.on(GetObjectCommand).resolves({
          Body: makeS3Body("From: sender@test.com\r\nSubject: Test\r\n\r\nBody"),
        });

        // MIME parser returns valid parsed result
        mockMimeParse.mockResolvedValue({
          from: { address: "sender@test.com" },
          to: [{ address: "test@example.com" }],
          cc: [],
          subject: "Test",
          textBody: "Body",
          htmlBody: null,
          attachments: [],
          headers: {},
        });

        // generateForModel returns Err with the random error cause
        const bedrockErr: BedrockError = {
          kind: "bedrock_error",
          modelId: TARGET_MODEL_ID,
          cause: new Error(errorCause),
        };
        mockGenerateForModel.mockResolvedValue(err(bedrockErr));

        const event = makeSqsEvent([
          makeSqsRecord({
            jobId: "job-prop-7",
            segment: 0,
            totalSegments: 1,
            targetRegistryId: TARGET_CLUSTER_ID,
            modelId: TARGET_MODEL_ID,
          }),
        ]);

        // The worker must NOT throw — it handles the error via Result path
        const response = await worker.process(event);

        // Worker completes without throwing (batch item failures are empty because
        // per-signal failures are logged but the segment itself succeeds)
        expect(response).toBeDefined();
        expect(response.batchItemFailures).toBeDefined();

        // The error was propagated via Result — no Aurora upsert attempted
        expect(mockUpsertEmbedding).not.toHaveBeenCalled();

        // No cache write attempted (embedding generation failed before that step)
        expect(mockAddEmbeddingToCache).not.toHaveBeenCalled();

        // generateForModel was called exactly once (regeneration path entered)
        expect(mockGenerateForModel).toHaveBeenCalledTimes(1);

        // The worker logged the partial failure containing the signal ID and reason
        const errorLogs = logger.calls.filter((c) => c.method === "error");
        const partialFailureLog = errorLogs.find(
          (c) => c.context && (c.context["code"] === "reindex.worker.segment_partial_failure"),
        );
        expect(partialFailureLog).toBeDefined();

        // The failures array in the log contains our signal ID and a reason with the error cause
        const failures = partialFailureLog!.context!["failures"] as Array<{ signalId: string; reason: string }>;
        expect(failures).toBeDefined();
        const failure = failures.find((f) => f.signalId === signalId);
        expect(failure).toBeDefined();
        expect(failure!.reason).toContain(errorCause);
        expect(failure!.reason).toContain(TARGET_MODEL_ID);
      }),
      { numRuns: 100 },
    );
  });
});
