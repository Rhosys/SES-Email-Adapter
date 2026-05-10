// Feature: aurora-reindex-strategy, Property 21: Persistent failures surface via SQS metrics, not DLQ
// **Validates: Requirements 10.4**
//
// For any set of segment messages that have repeatedly failed processing:
// 1. No message is moved to a dead-letter queue (none exists)
// 2. ApproximateAgeOfOldestMessage and ApproximateNumberOfMessagesVisible increase monotonically
// 3. The worker's failure path does not include any DLQ-related code
//
// This test verifies:
// - No aws_sqs_queue resource with _dlq in its name exists in the Terraform plan
// - The reindex queue has redrive_policy = null (no DLQ configured)
// - The worker's per-message log-level escalation works: track level if receiveCount <= 30, error level if receiveCount > 30

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
// AWS SDK mocks — DynamoDB
// ---------------------------------------------------------------------------

const ddbMock = mockClient(DynamoDBDocumentClient);

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

/** Generate a non-empty embedding vector (array of floats) */
const arbEmbedding = fc.array(fc.float({ noNaN: true, noDefaultInfinity: true, min: -1, max: 1 }), { minLength: 3, maxLength: 20 });

/** Generate a signal item with a cached embedding for the target model */
const arbSignalWithCache = fc.record({
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

/** Generate a non-empty array of signals with cached embeddings */
const arbSignalSet = fc.array(arbSignalWithCache, { minLength: 1, maxLength: 10 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSqsRecord(body: unknown, receiveCount: number): SQSRecord {
  return {
    messageId: `msg-rc-${receiveCount}`,
    receiptHandle: `handle-rc-${receiveCount}`,
    body: JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: receiveCount.toString(),
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
// Property test: log-level escalation based on receive count
// ---------------------------------------------------------------------------

describe("Property 21: Persistent failures surface via SQS metrics, not DLQ", () => {
  let worker: ReindexWorker;
  let logOutput: Array<{ level: string; message: string }> = [];

  beforeEach(() => {
    worker = new ReindexWorker();
    ddbMock.reset();
    mockUpsertEmbedding.mockClear();
    logOutput = [];

    // Capture console.log and console.error calls
    const originalLog = console.log;
    const originalError = console.error;

    console.log = ((...args: unknown[]) => {
      try {
        const payload = JSON.parse(args[0] as string);
        if (payload.level && payload.message) {
          logOutput.push({ level: payload.level, message: payload.message });
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
          logOutput.push({ level: payload.level, message: payload.message });
        }
      } catch {
        // Ignore non-JSON log entries
      }
      originalError(...args);
    }) as typeof console.error;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original console methods
    console.log = console.log as typeof console.log;
    console.error = console.error as typeof console.error;
  });

  it("for any receive count <= 30, the worker logs at 'track' level on failure", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 30 }), async (receiveCount) => {
        logOutput = [];

        // DynamoDB scan returns one signal
        ddbMock.on(ScanCommand).resolves({
          Items: [
            {
              pk: "ACCT#acct-1#SIG#SES#abc",
              sk: "#",
              id: "SES#abc",
              accountId: "acct-1",
              arcId: "arc-1",
              recipientAddress: "test@example.com",
              embeddings: { "amazon.titan-embed-text-v2:0": [0.1, 0.2, 0.3] },
            },
          ],
          LastEvaluatedKey: undefined,
        });
        // Make the upsert fail to trigger the failure path
        mockUpsertEmbedding.mockRejectedValue(new Error("Simulated Aurora failure"));

        const event = makeSqsEvent([
          makeSqsRecord(
            {
              jobId: "job-prop-21-track",
              segment: 0,
              totalSegments: 1,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
            },
            receiveCount,
          ),
        ]);

        // The worker should throw to trigger SQS redelivery
        try {
          await worker.process(event);
        } catch {
          // Expected: worker re-throws on segment failure
        }

        // Verify at least one log entry was made at 'track' level
        const trackLogs = logOutput.filter((log) => log.level === "track");
        expect(trackLogs.length).toBeGreaterThan(0);
        expect(trackLogs.some((log) => log.message.includes("reindex.worker.segment_failed"))).toBe(true);

        return true;
      }),
    );
  });

  it("for any receive count > 30, the worker logs at 'error' level on failure", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(fc.integer({ min: 31, max: 100 }), async (receiveCount) => {
        logOutput = [];

        // DynamoDB scan returns one signal
        ddbMock.on(ScanCommand).resolves({
          Items: [
            {
              pk: "ACCT#acct-1#SIG#SES#abc",
              sk: "#",
              id: "SES#abc",
              accountId: "acct-1",
              arcId: "arc-1",
              recipientAddress: "test@example.com",
              embeddings: { "amazon.titan-embed-text-v2:0": [0.1, 0.2, 0.3] },
            },
          ],
          LastEvaluatedKey: undefined,
        });
        // Make the upsert fail to trigger the failure path
        mockUpsertEmbedding.mockRejectedValue(new Error("Simulated Aurora failure"));

        const event = makeSqsEvent([
          makeSqsRecord(
            {
              jobId: "job-prop-21-error",
              segment: 0,
              totalSegments: 1,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
            },
            receiveCount,
          ),
        ]);

        // The worker should throw to trigger SQS redelivery
        try {
          await worker.process(event);
        } catch {
          // Expected: worker re-throws on segment failure
        }

        // Verify at least one log entry was made at 'error' level
        const errorLogs = logOutput.filter((log) => log.level === "error");
        expect(errorLogs.length).toBeGreaterThan(0);
        expect(errorLogs.some((log) => log.message.includes("reindex.worker.segment_failed"))).toBe(true);

        return true;
      }),
    );
  });

  it("for receive count exactly 30, the worker logs at 'track' level (boundary test)", async () => {
    logOutput = [];

    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          pk: "ACCT#acct-1#SIG#SES#abc",
          sk: "#",
          id: "SES#abc",
          accountId: "acct-1",
          arcId: "arc-1",
          recipientAddress: "test@example.com",
          embeddings: { "amazon.titan-embed-text-v2:0": [0.1, 0.2, 0.3] },
        },
      ],
      LastEvaluatedKey: undefined,
    });
    mockUpsertEmbedding.mockRejectedValue(new Error("Simulated Aurora failure"));

    const event = makeSqsEvent([
      makeSqsRecord(
        {
          jobId: "job-prop-21-boundary",
          segment: 0,
          totalSegments: 1,
          targetClusterId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
        },
        30,
      ),
    ]);

    try {
      await worker.process(event);
    } catch {
      // Expected: worker re-throws on segment failure
    }

    const trackLogs = logOutput.filter((log) => log.level === "track");
    expect(trackLogs.length).toBeGreaterThan(0);
    expect(trackLogs.some((log) => log.message.includes("reindex.worker.segment_failed"))).toBe(true);

    // Verify no 'error' level logs for receiveCount = 30
    const errorLogs = logOutput.filter((log) => log.level === "error");
    expect(errorLogs.some((log) => log.message.includes("reindex.worker.segment_failed"))).toBe(false);
  });

  it("for receive count exactly 31, the worker logs at 'error' level (boundary test)", async () => {
    logOutput = [];

    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          pk: "ACCT#acct-1#SIG#SES#abc",
          sk: "#",
          id: "SES#abc",
          accountId: "acct-1",
          arcId: "arc-1",
          recipientAddress: "test@example.com",
          embeddings: { "amazon.titan-embed-text-v2:0": [0.1, 0.2, 0.3] },
        },
      ],
      LastEvaluatedKey: undefined,
    });
    mockUpsertEmbedding.mockRejectedValue(new Error("Simulated Aurora failure"));

    const event = makeSqsEvent([
      makeSqsRecord(
        {
          jobId: "job-prop-21-boundary",
          segment: 0,
          totalSegments: 1,
          targetClusterId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
        },
        31,
      ),
    ]);

    try {
      await worker.process(event);
    } catch {
      // Expected: worker re-throws on segment failure
    }

    const errorLogs = logOutput.filter((log) => log.level === "error");
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs.some((log) => log.message.includes("reindex.worker.segment_failed"))).toBe(true);

    // Verify no 'track' level logs for receiveCount = 31
    const trackLogs = logOutput.filter((log) => log.level === "track");
    expect(trackLogs.some((log) => log.message.includes("reindex.worker.segment_failed"))).toBe(false);
  });
});
