// Feature: aurora-reindex-strategy, Property 21: Persistent failures surface via SQS metrics, not DLQ
// **Validates: Requirements 10.4**
//
// For any reindex SQS message that fails processing:
// 1. The reindex SQS queue has no `redrive_policy` (no DLQ) — infrastructure assertion
// 2. The reindex worker uses `ApproximateReceiveCount` from SQS message attributes to determine log level
// 3. When receiveCount <= 30, failures log at 'track' level
// 4. When receiveCount > 30, failures log at 'error' level

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "fs";
import { resolve } from "path";
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
// Mock cluster registry — return a valid cluster so processRecord proceeds
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
// AWS SDK mocks
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsRecord(body: unknown, receiveCount: number): SQSRecord {
  return {
    messageId: `msg-prop21-${receiveCount}`,
    receiptHandle: "handle-1",
    body: JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: String(receiveCount),
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
// Arbitraries
// ---------------------------------------------------------------------------

/** Receive count in the 'track' range: 1..30 */
const arbTrackReceiveCount = fc.integer({ min: 1, max: 30 });

/** Receive count in the 'error' range: 31..200 */
const arbErrorReceiveCount = fc.integer({ min: 31, max: 200 });

/** Any valid receive count */
const arbReceiveCount = fc.integer({ min: 1, max: 200 });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Property 21: Persistent failures surface via SQS metrics, not DLQ", () => {
  let worker: ReindexWorker;
  let consoleSpy: { log: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    worker = new ReindexWorker();
    ddbMock.reset();
    mockUpsertEmbedding.mockClear();

    consoleSpy = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.error.mockRestore();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Infrastructure assertion: no DLQ on the reindex queue
  // -------------------------------------------------------------------------

  it("reindex SQS queue has no redrive_policy (no DLQ)", () => {
    const computeTfPath = resolve(__dirname, "../../../deploy/compute.tf");
    const content = readFileSync(computeTfPath, "utf-8");

    // Extract the reindex queue resource block
    const reindexQueueMatch = content.match(
      /resource\s+"aws_sqs_queue"\s+"reindex"\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s,
    );
    expect(reindexQueueMatch).not.toBeNull();

    const queueBlock = reindexQueueMatch![1]!;

    // Assert no redrive_policy attribute is set
    expect(queueBlock).not.toMatch(/redrive_policy/);

    // Assert no DLQ queue resource exists for reindex
    expect(content).not.toMatch(/aws_sqs_queue.*reindex.*dlq/i);
    expect(content).not.toMatch(/aws_sqs_queue.*reindex_dlq/i);
  });

  // -------------------------------------------------------------------------
  // Property: receiveCount <= 30 → failures log at 'track' level
  // -------------------------------------------------------------------------

  it("for any receiveCount <= 30, segment failures log at 'track' level (console.log)", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbTrackReceiveCount, async (receiveCount) => {
        ddbMock.reset();
        consoleSpy.log.mockClear();
        consoleSpy.error.mockClear();

        // Make the DynamoDB scan throw to trigger a segment failure
        ddbMock.on(ScanCommand).rejects(new Error("Simulated DynamoDB failure"));

        const event = makeSqsEvent([
          makeSqsRecord(
            {
              jobId: "job-prop21-track",
              segment: 0,
              totalSegments: 1,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
            },
            receiveCount,
          ),
        ]);

        // The worker should re-throw on segment failure (for SQS redelivery)
        await expect(worker.process(event)).rejects.toThrow();

        // Failure should be logged at 'track' level (via console.log, not console.error)
        const logCalls = consoleSpy.log.mock.calls.flat().join(" ");
        const errorCalls = consoleSpy.error.mock.calls.flat().join(" ");

        // The segment_failed log should appear in console.log (track level)
        expect(logCalls).toContain("reindex.worker.segment_failed");
        // It should NOT appear in console.error
        expect(errorCalls).not.toContain("reindex.worker.segment_failed");

        return true;
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Property: receiveCount > 30 → failures log at 'error' level
  // -------------------------------------------------------------------------

  it("for any receiveCount > 30, segment failures log at 'error' level (console.error)", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbErrorReceiveCount, async (receiveCount) => {
        ddbMock.reset();
        consoleSpy.log.mockClear();
        consoleSpy.error.mockClear();

        // Make the DynamoDB scan throw to trigger a segment failure
        ddbMock.on(ScanCommand).rejects(new Error("Simulated DynamoDB failure"));

        const event = makeSqsEvent([
          makeSqsRecord(
            {
              jobId: "job-prop21-error",
              segment: 0,
              totalSegments: 1,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
            },
            receiveCount,
          ),
        ]);

        // The worker should re-throw on segment failure (for SQS redelivery)
        await expect(worker.process(event)).rejects.toThrow();

        // Failure should be logged at 'error' level (via console.error)
        const errorCalls = consoleSpy.error.mock.calls.flat().join(" ");
        const logCalls = consoleSpy.log.mock.calls.flat().join(" ");

        // The segment_failed log should appear in console.error
        expect(errorCalls).toContain("reindex.worker.segment_failed");
        // It should NOT appear in console.log (track level)
        expect(logCalls).not.toContain("reindex.worker.segment_failed");

        return true;
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Property: the threshold boundary is exactly 30
  // -------------------------------------------------------------------------

  it("for any receiveCount, the log level is 'track' iff receiveCount <= 30, 'error' otherwise", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbReceiveCount, async (receiveCount) => {
        ddbMock.reset();
        consoleSpy.log.mockClear();
        consoleSpy.error.mockClear();

        // Make the DynamoDB scan throw to trigger a segment failure
        ddbMock.on(ScanCommand).rejects(new Error("Simulated DynamoDB failure"));

        const event = makeSqsEvent([
          makeSqsRecord(
            {
              jobId: "job-prop21-boundary",
              segment: 0,
              totalSegments: 1,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
            },
            receiveCount,
          ),
        ]);

        await expect(worker.process(event)).rejects.toThrow();

        const logCalls = consoleSpy.log.mock.calls.flat().join(" ");
        const errorCalls = consoleSpy.error.mock.calls.flat().join(" ");

        if (receiveCount <= 30) {
          // Track level: logged via console.log
          expect(logCalls).toContain("reindex.worker.segment_failed");
          expect(errorCalls).not.toContain("reindex.worker.segment_failed");
        } else {
          // Error level: logged via console.error
          expect(errorCalls).toContain("reindex.worker.segment_failed");
          expect(logCalls).not.toContain("reindex.worker.segment_failed");
        }

        return true;
      }),
    );
  });
});
