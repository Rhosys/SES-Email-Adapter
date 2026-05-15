// Feature: aurora-reindex-strategy, Property 21: Persistent failures surface via SQS metrics, not DLQ
// **Validates: Requirements 10.4**
//
// For any reindex SQS message that fails processing:
// 1. The reindex SQS queue has no `redrive_policy` (no DLQ) — infrastructure assertion
// 2. The reindex worker uses `ApproximateReceiveCount` from SQS message attributes to determine log level
// 3. When receiveCount <= 30, failures log at 'warn' level
// 4. When receiveCount > 30, failures log at 'error' level

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { createMockLogger } from "../../testing/mock-logger.js";
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
  getRegistryById: (registryId: string) => {
    if (registryId === "aurora-prod-titan-v2") {
      return {
        registryId: "aurora-prod-titan-v2",
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
    eventSourceARN: "arn:aws:sqs:eu-central-1:123:reindex-queue",
    awsRegion: "eu-central-1",
  };
}

function makeSqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

// ---------------------------------------------------------------------------
// Edge cases for log escalation threshold
// ---------------------------------------------------------------------------

const trackLevelCases: Array<[string, { receiveCount: number }]> = [
  ["first attempt (receiveCount=1)", { receiveCount: 1 }],
  ["mid-range (receiveCount=15)", { receiveCount: 15 }],
  ["just below threshold (receiveCount=29)", { receiveCount: 29 }],
  ["exactly at threshold (receiveCount=30)", { receiveCount: 30 }],
];

const errorLevelCases: Array<[string, { receiveCount: number }]> = [
  ["just above threshold (receiveCount=31)", { receiveCount: 31 }],
  ["well above threshold (receiveCount=50)", { receiveCount: 50 }],
  ["high retry count (receiveCount=100)", { receiveCount: 100 }],
  ["maximum observed (receiveCount=200)", { receiveCount: 200 }],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 21: Persistent failures surface via SQS metrics, not DLQ", () => {
  let worker: ReindexWorker;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    worker = new ReindexWorker(mockLogger);
    ddbMock.reset();
    mockUpsertEmbedding.mockClear();
  });

  afterEach(() => {
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
  // receiveCount <= 30 → failures log at 'warn' level
  // -------------------------------------------------------------------------

  it.each(trackLevelCases)("logs at 'warn' level when %s", async (_label, { receiveCount }) => {
    ddbMock.reset();
    mockLogger.calls.length = 0;

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

    const result = await worker.process(event);
    expect(result.batchItemFailures).toHaveLength(1);

    const warnCalls = mockLogger.calls.filter(
      (c) => c.method === "warn" && c.context?.code === "reindex.worker.segment_failed",
    );
    const errorCalls = mockLogger.calls.filter(
      (c) => c.method === "error" && c.context?.code === "reindex.worker.segment_failed",
    );

    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(errorCalls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // receiveCount > 30 → failures log at 'error' level
  // -------------------------------------------------------------------------

  it.each(errorLevelCases)("logs at 'error' level when %s", async (_label, { receiveCount }) => {
    ddbMock.reset();
    mockLogger.calls.length = 0;

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

    const result = await worker.process(event);
    expect(result.batchItemFailures).toHaveLength(1);

    const errorCalls = mockLogger.calls.filter(
      (c) => c.method === "error" && c.context?.code === "reindex.worker.segment_failed",
    );
    const warnCalls = mockLogger.calls.filter(
      (c) => c.method === "warn" && c.context?.code === "reindex.worker.segment_failed",
    );

    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnCalls.length).toBe(0);
  });
});
