// ---------------------------------------------------------------------------
// Unit tests for ReindexDispatcher
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ReindexDispatcher } from "./reindex-dispatcher.js";
import { dynamo } from "../../database/shared.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const sqsMock = mockClient(SQSClient);
const rdsMock = mockClient(RDSDataClient);

vi.mock("../../database/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../database/shared.js")>();
  const { mockClient } = await import("aws-sdk-client-mock");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const mockedDynamo = mockClient(DynamoDBDocumentClient);
  return {
    ...actual,
    dynamo: mockedDynamo as unknown as typeof actual.dynamo,
    __dynamoMock: mockedDynamo,
  };
});

// Access the mocked dynamo client for assertions
async function getDynamoMock() {
  const mod = await import("../../database/shared.js") as unknown as { __dynamoMock: ReturnType<typeof mockClient> };
  return mod.__dynamoMock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReindexDispatcher", () => {
  let dispatcher: ReindexDispatcher;
  let dynamoMock: ReturnType<typeof mockClient>;

  beforeEach(async () => {
    sqsMock.reset();
    rdsMock.reset();
    dynamoMock = await getDynamoMock();
    dynamoMock.reset();

    sqsMock.on(SendMessageCommand).resolves({});
    dynamoMock.on(PutCommand).resolves({});

    dispatcher = new ReindexDispatcher({
      sqs: sqsMock as unknown as SQSClient,
      rds: rdsMock as unknown as RDSDataClient,
    });
  });

  describe("dispatch", () => {
    it("rejects unknown cluster IDs", async () => {
      const result = await dispatcher.dispatch("nonexistent-cluster");
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe("not_found");
      }
    });

    it("dispatches correct number of SQS messages with default segment count", async () => {
      const result = await dispatcher.dispatch("aurora-prod-titan-v2");

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value.targetRegistryId).toBe("aurora-prod-titan-v2");
      expect(result.value.modelId).toBe("amazon.titan-embed-text-v2:0");
      expect(result.value.segmentCount).toBe(32);
      expect(result.value.jobId).toBeDefined();
      expect(result.value.startedAt).toBeDefined();

      // Verify 32 SQS messages were sent
      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      expect(sqsCalls).toHaveLength(32);
    });

    it("dispatches custom segment count", async () => {
      const result = await dispatcher.dispatch("aurora-prod-titan-v2", 8);

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;
      expect(result.value.segmentCount).toBe(8);

      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      expect(sqsCalls).toHaveLength(8);
    });

    it("sends well-formed SQS messages with correct segment metadata", async () => {
      const result = await dispatcher.dispatch("aurora-prod-titan-v2", 4);

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
      const messages = sqsCalls.map((call) => JSON.parse(call.args[0].input.MessageBody!));

      // Verify each message has correct structure
      for (let i = 0; i < 4; i++) {
        expect(messages[i]).toEqual({
          jobId: result.value.jobId,
          segment: i,
          totalSegments: 4,
          targetRegistryId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
        });
      }
    });

    it("writes initial counters row to processing table without signalsScanned", async () => {
      const result = await dispatcher.dispatch("aurora-prod-titan-v2", 16);

      expect(result.isOk()).toBe(true);
      if (!result.isOk()) return;

      const putCalls = dynamoMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      const putInput = putCalls[0]!.args[0].input;
      expect(putInput.Item).toMatchObject({
        pk: `REINDEX#${result.value.jobId}`,
        sk: "JOB",
        jobId: result.value.jobId,
        targetRegistryId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        segmentCount: 16,
        copiedCount: 0,
        regeneratedCount: 0,
        unrecoverableCount: 0,
      });
      // signalsScanned is NOT stored — it is computed as the sum of the three counters
      expect(putInput.Item).not.toHaveProperty("signalsScanned");
    });
  });

  describe("getReport", () => {
    it("throws when job not found", async () => {
      dynamoMock.on(GetCommand).resolves({ Item: undefined });

      const result = await dispatcher.getReport("nonexistent-job");
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe("not_found");
      }
    });

    it("returns report with validation when Aurora is healthy", async () => {
      const jobId = "test-job-123";
      dynamoMock.on(GetCommand).resolves({
        Item: {
          pk: `REINDEX#${jobId}`,
          sk: "JOB",
          jobId,
          targetRegistryId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
          startedAt: new Date(Date.now() - 60000).toISOString(),
          copiedCount: 95,
          regeneratedCount: 3,
          unrecoverableCount: 2,
        },
      });

      // Aurora row count matches expected (95 + 3 = 98)
      rdsMock.on(ExecuteStatementCommand).resolvesOnce({
        records: [[{ longValue: 98 }]],
      }).resolvesOnce({
        // Sample validation — 10 vectors with valid self-similarity (0 = identical)
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

      const report = await dispatcher.getReport(jobId);

      expect(report.isOk()).toBe(true);
      if (!report.isOk()) return;
      expect(report.value.jobId).toBe(jobId);
      // signalsScanned is computed as copiedCount + regeneratedCount + unrecoverableCount
      expect(report.value.signalsScanned).toBe(95 + 3 + 2);
      expect(report.value.signalsScanned).toBe(report.value.copiedCount + report.value.regeneratedCount + report.value.unrecoverableCount);
      expect(report.value.copiedCount).toBe(95);
      expect(report.value.regeneratedCount).toBe(3);
      expect(report.value.unrecoverableCount).toBe(2);
      expect(report.value.validationOk).toBe(true);
      expect(report.value.durationMs).toBeGreaterThan(0);
    });

    it("flags validation failure when row count discrepancy exceeds 1%", async () => {
      const jobId = "test-job-discrepancy";
      dynamoMock.on(GetCommand).resolves({
        Item: {
          pk: `REINDEX#${jobId}`,
          sk: "JOB",
          jobId,
          targetRegistryId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
          startedAt: new Date(Date.now() - 30000).toISOString(),
          copiedCount: 900,
          regeneratedCount: 50,
          unrecoverableCount: 50,
        },
      });

      // Aurora has significantly fewer rows than expected (950 expected, 900 actual = 5.3% off)
      rdsMock.on(ExecuteStatementCommand).resolvesOnce({
        records: [[{ longValue: 900 }]],
      }).resolvesOnce({
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

      const report = await dispatcher.getReport(jobId);

      expect(report.isOk()).toBe(true);
      if (!report.isOk()) return;
      expect(report.value.validationOk).toBe(false);
      expect(report.value.validationDetail).toContain("Row count discrepancy");
    });

    it("flags validation failure when sample vectors are invalid", async () => {
      const jobId = "test-job-invalid-vectors";
      dynamoMock.on(GetCommand).resolves({
        Item: {
          pk: `REINDEX#${jobId}`,
          sk: "JOB",
          jobId,
          targetRegistryId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
          startedAt: new Date(Date.now() - 10000).toISOString(),
          copiedCount: 50,
          regeneratedCount: 0,
          unrecoverableCount: 0,
        },
      });

      // Row count matches
      rdsMock.on(ExecuteStatementCommand).resolvesOnce({
        records: [[{ longValue: 50 }]],
      }).resolvesOnce({
        // Some samples have NaN similarity
        records: [
          [{ stringValue: "arc_0" }, { doubleValue: 0 }],
          [{ stringValue: "arc_1" }, { doubleValue: NaN }],
          [{ stringValue: "arc_2" }, { doubleValue: 0 }],
        ],
      });

      const report = await dispatcher.getReport(jobId);

      expect(report.isOk()).toBe(true);
      if (!report.isOk()) return;
      expect(report.value.validationOk).toBe(false);
      expect(report.value.validationDetail).toContain("Sample validation failed");
    });

    it("handles cluster removed from registry gracefully", async () => {
      const jobId = "test-job-removed-cluster";
      dynamoMock.on(GetCommand).resolves({
        Item: {
          pk: `REINDEX#${jobId}`,
          sk: "JOB",
          jobId,
          targetRegistryId: "removed-cluster-xyz",
          modelId: "some-model",
          startedAt: new Date(Date.now() - 5000).toISOString(),
          copiedCount: 10,
          regeneratedCount: 0,
          unrecoverableCount: 0,
        },
      });

      const report = await dispatcher.getReport(jobId);

      expect(report.isOk()).toBe(true);
      if (!report.isOk()) return;
      expect(report.value.validationOk).toBe(false);
      expect(report.value.validationDetail).toContain("no longer in registry");
    });

    it("computes signalsScanned as copiedCount + regeneratedCount + unrecoverableCount (invariant)", async () => {
      const jobId = "test-job-invariant";
      dynamoMock.on(GetCommand).resolves({
        Item: {
          pk: `REINDEX#${jobId}`,
          sk: "JOB",
          jobId,
          targetRegistryId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
          startedAt: new Date(Date.now() - 20000).toISOString(),
          copiedCount: 42,
          regeneratedCount: 7,
          unrecoverableCount: 3,
        },
      });

      // Aurora row count matches copied + regenerated
      rdsMock.on(ExecuteStatementCommand).resolvesOnce({
        records: [[{ longValue: 49 }]],
      }).resolvesOnce({
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

      const report = await dispatcher.getReport(jobId);

      // The invariant: signalsScanned is always the sum of the three counters
      expect(report.isOk()).toBe(true);
      if (!report.isOk()) return;
      expect(report.value.signalsScanned).toBe(42 + 7 + 3);
      expect(report.value.signalsScanned).toBe(report.value.copiedCount + report.value.regeneratedCount + report.value.unrecoverableCount);
    });

    it("signalsScanned is zero when all counters are zero", async () => {
      const jobId = "test-job-empty";
      dynamoMock.on(GetCommand).resolves({
        Item: {
          pk: `REINDEX#${jobId}`,
          sk: "JOB",
          jobId,
          targetRegistryId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
          startedAt: new Date(Date.now() - 1000).toISOString(),
          copiedCount: 0,
          regeneratedCount: 0,
          unrecoverableCount: 0,
        },
      });

      rdsMock.on(ExecuteStatementCommand).resolvesOnce({
        records: [[{ longValue: 0 }]],
      }).resolvesOnce({
        records: [],
      });

      const report = await dispatcher.getReport(jobId);

      expect(report.isOk()).toBe(true);
      if (!report.isOk()) return;
      expect(report.value.signalsScanned).toBe(0);
      expect(report.value.signalsScanned).toBe(report.value.copiedCount + report.value.regeneratedCount + report.value.unrecoverableCount);
    });

    it("ignores any stored signalsScanned value and computes from counters", async () => {
      const jobId = "test-job-stale-scanned";
      // Simulate a DynamoDB record that has a stale signalsScanned value
      // (e.g. from an older version of the code). The dispatcher should ignore it.
      dynamoMock.on(GetCommand).resolves({
        Item: {
          pk: `REINDEX#${jobId}`,
          sk: "JOB",
          jobId,
          targetRegistryId: "aurora-prod-titan-v2",
          modelId: "amazon.titan-embed-text-v2:0",
          startedAt: new Date(Date.now() - 15000).toISOString(),
          signalsScanned: 9999, // stale/wrong value — should be ignored
          copiedCount: 20,
          regeneratedCount: 5,
          unrecoverableCount: 1,
        },
      });

      rdsMock.on(ExecuteStatementCommand).resolvesOnce({
        records: [[{ longValue: 25 }]],
      }).resolvesOnce({
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

      const report = await dispatcher.getReport(jobId);

      // Must compute from the three counters, NOT use the stored value
      expect(report.isOk()).toBe(true);
      if (!report.isOk()) return;
      expect(report.value.signalsScanned).toBe(20 + 5 + 1);
      expect(report.value.signalsScanned).not.toBe(9999);
      expect(report.value.signalsScanned).toBe(report.value.copiedCount + report.value.regeneratedCount + report.value.unrecoverableCount);
    });
  });
});
