// Feature: split-embedding-pipeline, Property 7: Reindex worker propagates Result errors
// **Validates: Requirements 4.1**
//
// For any BedrockError returned by `generateForModel` during reindex, the worker
// SHALL return an error result containing the signal ID and a reason string —
// without throwing or using non-null assertions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { sdkStreamMixin } from "@smithy/util-stream";
import { createMockLogger, type MockLogger } from "../../helpers/mock-logger.js";
import { ReindexWorker, type ReindexSegmentMessage } from "../../../src/jobs/reindex/reindex-worker.js";
import { err, ok } from "../../../src/errors.js";
import type { BedrockError } from "../../../src/errors.js";

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

const { mockUpsertEmbedding, mockAddEmbeddingToCache, mockGenerateForModel, mockMimeParse } = vi.hoisted(() => ({
  mockUpsertEmbedding: vi.fn(),
  mockAddEmbeddingToCache: vi.fn(),
  mockGenerateForModel: vi.fn(),
  mockMimeParse: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock MultiClusterAuroraWriter
// ---------------------------------------------------------------------------

vi.mock("../../../src/database/arc-matcher.js", () => ({
  searchDatabase: {
    upsertEmbedding: (...args: unknown[]) => mockUpsertEmbedding(...args),
  },
}));

// ---------------------------------------------------------------------------
// Mock ArcDatabase
// ---------------------------------------------------------------------------

vi.mock("../../../src/database/arc-database.js", () => ({
  ArcDatabase: class {
    addEmbeddingToCache = mockAddEmbeddingToCache;
  },
}));

// ---------------------------------------------------------------------------
// Mock EmbeddingGenerator
// ---------------------------------------------------------------------------

vi.mock("../../../src/embedding/embedding-generator.js", () => ({
  BedrockEmbeddingGenerator: class {
    generateForModel = mockGenerateForModel;
  },
}));

// ---------------------------------------------------------------------------
// Mock MimeParser
// ---------------------------------------------------------------------------

vi.mock("../../../src/processor/mime.js", () => ({
  MailparserMimeParser: class {
    parse = mockMimeParse;
    parseBuffer = async (...args: unknown[]) => {
      const { ok: okFn } = await import("../../../src/errors.js");
      const result = await mockMimeParse(...args);
      return okFn(result);
    };
  },
}));

// ---------------------------------------------------------------------------
// Mock cluster registry
// ---------------------------------------------------------------------------

const TARGET_MODEL_ID = "amazon.titan-embed-text-v2:0";
const TARGET_CLUSTER_ID = "aurora-prod-titan-v2";

vi.mock("../../../src/embedding/cluster-registry.js", () => ({
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

function makeS3Body(content: string) {
  const stream = new Readable();
  stream.push(content);
  stream.push(null);
  return sdkStreamMixin(stream);
}

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
    mockUpsertEmbedding.mockClear().mockResolvedValue(ok(undefined));
    mockAddEmbeddingToCache.mockClear().mockResolvedValue(ok(undefined));
    mockGenerateForModel.mockClear();
    mockMimeParse.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cases = [
    ["short alphanumeric ID", "SES#abc123", "Bedrock throttled"],
    ["numeric-only ID", "SES#99887766", "Model not available"],
    ["long ID with mixed chars", "SES#aB3cD4eF5gH6iJ7k", "InternalServerError from Bedrock"],
  ] as const;

  it.each(cases)("%s — returns err with signalId and reason when generateForModel returns Err", async (_label, signalId, errorCause) => {
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
      data: {
        recipientAddress: "test@example.com",
        embeddings: {},
        s3Key: "inbox/2025/test.eml",
      },
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

    // generateForModel returns Err with the error cause
    const bedrockErr: BedrockError = {
      kind: "bedrock_error",
      modelId: TARGET_MODEL_ID,
      cause: new Error(errorCause),
    };
    mockGenerateForModel.mockResolvedValue(err(bedrockErr));

    const message: ReindexSegmentMessage = {
      jobId: "job-prop-7",
      segment: 0,
      totalSegments: 1,
      targetRegistryId: TARGET_CLUSTER_ID,
      modelId: TARGET_MODEL_ID,
    };

    // The worker must NOT throw — it handles the error via Result path
    const response = await worker.processSegmentMessage(message);

    // Worker returns err (partial failure triggers segment retry)
    expect(response).toBeDefined();
    expect(response.isErr()).toBe(true);

    // The error was propagated via Result — no Aurora upsert attempted
    expect(mockUpsertEmbedding).not.toHaveBeenCalled();

    // No cache write attempted (embedding generation failed before that step)
    expect(mockAddEmbeddingToCache).not.toHaveBeenCalled();

    // generateForModel was called exactly once (regeneration path entered)
    expect(mockGenerateForModel).toHaveBeenCalledTimes(1);

    // The worker logged the partial failure containing the signal ID and reason
    const warnLogs = logger.calls.filter((c) => c.method === "warn");
    const partialFailureLog = warnLogs.find(
      (c) => c.context && (c.context["code"] === "reindex.worker.segment_partial_failure"),
    );
    expect(partialFailureLog).toBeDefined();

    // The failures array in the log contains our signal ID and the cause
    const failures = partialFailureLog!.context!["failures"] as Array<{ signalId: string; cause: unknown }>;
    expect(failures).toBeDefined();
    const failure = failures.find((f) => f.signalId === signalId);
    expect(failure).toBeDefined();
    expect(failure!.cause).toBeDefined();
  });
});
