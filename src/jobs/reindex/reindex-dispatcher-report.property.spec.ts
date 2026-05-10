// Feature: aurora-reindex-strategy, Property 14: Job reports preserve scan accounting
// **Validates: Requirements 5.5, 9.1, 9.2**
//
// For any arbitrary counter values (copiedCount, regeneratedCount, unrecoverableCount),
// the ReindexDispatcher's getReport method correctly accounts for all signals processed:
// 1. signalsScanned equals copiedCount + regeneratedCount + unrecoverableCount
// 2. The report includes all three counter fields (copiedCount, regeneratedCount, unrecoverableCount)
// 3. signalsScanned is always computed (never stored), so stale stored values are ignored

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient } from "@aws-sdk/client-sqs";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ReindexDispatcher } from "./reindex-dispatcher.js";
import { propertyRunner } from "../../testing/property-runner.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const sqsMock = mockClient(SQSClient);
const rdsMock = mockClient(RDSDataClient);

vi.mock("../../database/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../database/shared.js")>();
  const { mockClient } = await import("aws-sdk-client-mock");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const mockedDynamo = mockClient(DynamoDBDocumentClient);
  return {
    ...actual,
    dynamo: mockedDynamo as unknown as typeof actual.dynamo,
    __dynamoMock: mockedDynamo,
  };
});

async function getDynamoMock() {
  const mod = (await import("../../database/shared.js")) as unknown as {
    __dynamoMock: ReturnType<typeof mockClient>;
  };
  return mod.__dynamoMock;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate arbitrary non-negative integer counter values */
const arbCounterValue = fc.integer({ min: 0, max: 10_000 });

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe("Property 14: Job reports preserve scan accounting", () => {
  let dispatcher: ReindexDispatcher;
  let dynamoMock: ReturnType<typeof mockClient>;

  beforeEach(async () => {
    sqsMock.reset();
    rdsMock.reset();
    dynamoMock = await getDynamoMock();
    dynamoMock.reset();

    dispatcher = new ReindexDispatcher({
      sqs: sqsMock as unknown as SQSClient,
      rds: rdsMock as unknown as RDSDataClient,
    });
  });

  it("for any counter values, signalsScanned === copiedCount + regeneratedCount + unrecoverableCount", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbCounterValue,
        arbCounterValue,
        arbCounterValue,
        async (copiedCount, regeneratedCount, unrecoverableCount) => {
          dynamoMock.reset();
          rdsMock.reset();

          const jobId = "prop14-job";
          const expectedSignalsScanned = copiedCount + regeneratedCount + unrecoverableCount;

          // Mock DynamoDB GetCommand to return the job record with arbitrary counters
          dynamoMock.on(GetCommand).resolves({
            Item: {
              pk: `REINDEX#${jobId}`,
              sk: "JOB",
              jobId,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
              startedAt: new Date(Date.now() - 5000).toISOString(),
              copiedCount,
              regeneratedCount,
              unrecoverableCount,
            },
          });

          // Mock Aurora validation (row count + sample vectors)
          rdsMock
            .on(ExecuteStatementCommand)
            .resolvesOnce({
              records: [[{ longValue: copiedCount + regeneratedCount }]],
            })
            .resolvesOnce({
              records: Array.from({ length: 10 }, (_, i) => [
                { stringValue: `arc_${i}` },
                { doubleValue: 0 },
              ]),
            });

          const report = await dispatcher.getReport(jobId);

          // Core invariant: signalsScanned is the sum of the three counters
          expect(report.signalsScanned).toBe(expectedSignalsScanned);
          expect(report.signalsScanned).toBe(
            report.copiedCount + report.regeneratedCount + report.unrecoverableCount,
          );

          // Verify individual counters are preserved
          expect(report.copiedCount).toBe(copiedCount);
          expect(report.regeneratedCount).toBe(regeneratedCount);
          expect(report.unrecoverableCount).toBe(unrecoverableCount);

          return true;
        },
      ),
    );
  });

  it("signalsScanned is always computed from counters, never from a stored value", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbCounterValue,
        arbCounterValue,
        arbCounterValue,
        async (copiedCount, regeneratedCount, unrecoverableCount) => {
          dynamoMock.reset();
          rdsMock.reset();

          const jobId = "prop14-stale";
          const staleSignalsScanned = 999_999; // Clearly wrong stored value

          // DynamoDB record includes a stale signalsScanned field — dispatcher must ignore it
          dynamoMock.on(GetCommand).resolves({
            Item: {
              pk: `REINDEX#${jobId}`,
              sk: "JOB",
              jobId,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
              startedAt: new Date(Date.now() - 5000).toISOString(),
              signalsScanned: staleSignalsScanned,
              copiedCount,
              regeneratedCount,
              unrecoverableCount,
            },
          });

          rdsMock
            .on(ExecuteStatementCommand)
            .resolvesOnce({
              records: [[{ longValue: copiedCount + regeneratedCount }]],
            })
            .resolvesOnce({
              records: Array.from({ length: 10 }, (_, i) => [
                { stringValue: `arc_${i}` },
                { doubleValue: 0 },
              ]),
            });

          const report = await dispatcher.getReport(jobId);

          // Must compute from the three counters, NOT use the stored value
          const expectedSignalsScanned = copiedCount + regeneratedCount + unrecoverableCount;
          expect(report.signalsScanned).toBe(expectedSignalsScanned);
          expect(report.signalsScanned).not.toBe(staleSignalsScanned);

          return true;
        },
      ),
    );
  });

  it("edge case: all zero counters produce signalsScanned of zero", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: "REINDEX#job-zero",
        sk: "JOB",
        jobId: "job-zero",
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date().toISOString(),
        copiedCount: 0,
        regeneratedCount: 0,
        unrecoverableCount: 0,
      },
    });

    rdsMock
      .on(ExecuteStatementCommand)
      .resolvesOnce({ records: [[{ longValue: 0 }]] })
      .resolvesOnce({ records: [] });

    const report = await dispatcher.getReport("job-zero");

    expect(report.signalsScanned).toBe(0);
    expect(report.copiedCount).toBe(0);
    expect(report.regeneratedCount).toBe(0);
    expect(report.unrecoverableCount).toBe(0);
  });
});
