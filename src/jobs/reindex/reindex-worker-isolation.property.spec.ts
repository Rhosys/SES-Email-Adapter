// Feature: aurora-reindex-strategy, Property 22: Worker isolates per-signal failures within a segment
// **Validates: Requirements 10.5**
//
// For any segment containing N signals where some are malformed or cause errors:
// 1. The worker processes all signals in the segment (doesn't abort on first failure)
// 2. Malformed signals are logged per-signal and skipped
// 3. Successful signals still get their upserts written to Aurora
// 4. The segment-level processing continues past individual failures

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { propertyRunner } from "../../testing/property-runner.js";
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

/** Generate a non-empty embedding vector */
const arbEmbedding = fc.array(fc.float({ noNaN: true, noDefaultInfinity: true, min: -1, max: 1 }), { minLength: 3, maxLength: 20 });

/** Generate a valid signal with a cached embedding for the target model */
const arbValidSignal = fc.record({
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

/** Generate a malformed signal — missing required fields (accountId, arcId, or recipientAddress) */
const arbMalformedSignal = fc.oneof(
  // Has id but missing accountId
  arbSignalId.map((id) => ({ pk: "BAD#1", sk: "#", id })),
  // Has id and accountId but missing arcId
  fc.record({ id: arbSignalId, accountId: arbAccountId }).map((s) => ({
    pk: `ACCT#${s.accountId}#SIG#${s.id}`,
    sk: "#",
    id: s.id,
    accountId: s.accountId,
    recipientAddress: "missing-arc@example.com",
  })),
  // Has id, accountId, arcId but missing recipientAddress
  fc.record({ id: arbSignalId, accountId: arbAccountId, arcId: arbArcId }).map((s) => ({
    pk: `ACCT#${s.accountId}#SIG#${s.id}`,
    sk: "#",
    id: s.id,
    accountId: s.accountId,
    arcId: s.arcId,
  })),
);

/**
 * Generate a mixed segment: at least 1 valid signal and at least 1 malformed signal,
 * interleaved in arbitrary order.
 */
const arbMixedSegment = fc.record({
  validSignals: fc.array(arbValidSignal, { minLength: 1, maxLength: 5 }),
  malformedSignals: fc.array(arbMalformedSignal, { minLength: 1, maxLength: 5 }),
}).chain(({ validSignals, malformedSignals }) => {
  // Shuffle the combined array to ensure ordering doesn't matter
  const combined = [...validSignals, ...malformedSignals];
  return fc.shuffledSubarray(combined, { minLength: combined.length, maxLength: combined.length })
    .map((shuffled) => ({ items: shuffled, validCount: validSignals.length, malformedCount: malformedSignals.length }));
});

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
// Property test
// ---------------------------------------------------------------------------

describe("Property 22: Worker isolates per-signal failures within a segment", () => {
  let worker: ReindexWorker;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    worker = new ReindexWorker();
    ddbMock.reset();
    bedrockMock.reset();
    s3Mock.reset();
    mockUpsertEmbedding.mockClear();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Bedrock and S3 should not be called for pure-copy signals
    bedrockMock.on(InvokeModelCommand).rejects(new Error("PROPERTY VIOLATION: Bedrock was called"));
    s3Mock.on(GetObjectCommand).rejects(new Error("PROPERTY VIOLATION: S3 was called"));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("for any segment with a mix of valid and malformed signals, valid signals are upserted and malformed signals are skipped without aborting", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbMixedSegment, async ({ items, validCount }) => {
        // Reset mocks for each iteration
        ddbMock.reset();
        mockUpsertEmbedding.mockClear();
        consoleLogSpy.mockClear();
        consoleErrorSpy.mockClear();

        // Re-arm Bedrock and S3 traps
        bedrockMock.on(InvokeModelCommand).rejects(new Error("PROPERTY VIOLATION: Bedrock was called"));
        s3Mock.on(GetObjectCommand).rejects(new Error("PROPERTY VIOLATION: S3 was called"));

        // DynamoDB scan returns the mixed set of signals in one page
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

        // 2. Malformed signals are logged (console.log or console.error called with malformed_signal)
        const allLogCalls = [
          ...consoleLogSpy.mock.calls.map((c) => c[0]),
          ...consoleErrorSpy.mock.calls.map((c) => c[0]),
        ];
        const malformedLogs = allLogCalls.filter(
          (msg) => typeof msg === "string" && msg.includes("malformed_signal"),
        );
        // Each malformed signal with an `id` field should produce a log entry
        const malformedWithId = items.filter(
          (item) => typeof item.id === "string" && !("embeddings" in item && "arcId" in item && "recipientAddress" in item && "accountId" in item),
        );
        expect(malformedLogs.length).toBe(malformedWithId.length);

        // 3. The segment-level processing did NOT throw (we reached this point)
        // 4. All valid signals were processed regardless of malformed signal positions
        for (const item of items) {
          if ("embeddings" in item && "arcId" in item && "recipientAddress" in item && "accountId" in item) {
            const embedding = (item as Record<string, unknown>)["embeddings"] as Record<string, number[]>;
            expect(mockUpsertEmbedding).toHaveBeenCalledWith(
              expect.objectContaining({
                clusterId: "aurora-prod-titan-v2",
                arcId: (item as Record<string, unknown>)["arcId"],
                accountId: (item as Record<string, unknown>)["accountId"],
                recipientAddress: (item as Record<string, unknown>)["recipientAddress"],
                embedding: embedding["amazon.titan-embed-text-v2:0"],
              }),
            );
          }
        }

        return true;
      }),
    );
  });

  it("for any segment where Aurora upsert fails for some signals, remaining signals still get processed", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.array(arbValidSignal, { minLength: 2, maxLength: 8 }),
        fc.nat({ max: 100 }),
        async (signals, seed) => {
          // Reset mocks for each iteration
          ddbMock.reset();
          mockUpsertEmbedding.mockClear();
          consoleLogSpy.mockClear();
          consoleErrorSpy.mockClear();

          // Determine which signals will have Aurora failures (at least 1 fails, at least 1 succeeds)
          const failIndex = seed % signals.length;
          let callIndex = 0;
          mockUpsertEmbedding.mockImplementation(() => {
            const idx = callIndex++;
            if (idx === failIndex) {
              return Promise.reject(new Error("Simulated Aurora failure"));
            }
            return Promise.resolve(undefined);
          });

          // DynamoDB scan returns all signals
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

          // The worker should NOT throw — segment processing continues past Aurora failures
          await worker.process(event);

          // All signals were attempted (upsert called for each)
          expect(mockUpsertEmbedding).toHaveBeenCalledTimes(signals.length);

          // The failure was logged per-signal
          const allLogCalls = [
            ...consoleLogSpy.mock.calls.map((c) => c[0]),
            ...consoleErrorSpy.mock.calls.map((c) => c[0]),
          ];
          const failureLogs = allLogCalls.filter(
            (msg) => typeof msg === "string" && msg.includes("signal_upsert_failed"),
          );
          expect(failureLogs.length).toBe(1);

          return true;
        },
      ),
    );
  });
});
