// Feature: aurora-reindex-strategy, Property 14: Job reports preserve scan accounting
// **Validates: Requirements 5.5, 9.1, 9.2**
//
// For any arbitrary counter values (copiedCount, regeneratedCount, unrecoverableCount),
// the ReindexDispatcher's getReport method correctly accounts for all signals processed:
// 1. signalsScanned equals copiedCount + regeneratedCount + unrecoverableCount
// 2. The report includes all three counter fields (copiedCount, regeneratedCount, unrecoverableCount)
// 3. signalsScanned is always computed (never stored), so stale stored values are ignored

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient } from "@aws-sdk/client-sqs";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ReindexDispatcher } from "./reindex-dispatcher.js";

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
// Edge cases
// ---------------------------------------------------------------------------

const counterCases: Array<[string, { copiedCount: number; regeneratedCount: number; unrecoverableCount: number }]> = [
  ["all zeros — empty job", { copiedCount: 0, regeneratedCount: 0, unrecoverableCount: 0 }],
  ["only copied signals", { copiedCount: 500, regeneratedCount: 0, unrecoverableCount: 0 }],
  ["only regenerated signals", { copiedCount: 0, regeneratedCount: 300, unrecoverableCount: 0 }],
  ["only unrecoverable signals", { copiedCount: 0, regeneratedCount: 0, unrecoverableCount: 42 }],
  ["all three counters populated", { copiedCount: 100, regeneratedCount: 50, unrecoverableCount: 7 }],
  ["large values — overflow boundary", { copiedCount: 10000, regeneratedCount: 10000, unrecoverableCount: 10000 }],
];

// ---------------------------------------------------------------------------
// Tests
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

  it.each(counterCases)("%s", async (_label, { copiedCount, regeneratedCount, unrecoverableCount }) => {
    dynamoMock.reset();
    rdsMock.reset();

    const jobId = "prop14-job";
    const expectedSignalsScanned = copiedCount + regeneratedCount + unrecoverableCount;

    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: `REINDEX#${jobId}`,
        sk: "JOB",
        jobId,
        targetRegistryId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date(Date.now() - 5000).toISOString(),
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

    // Core invariant: signalsScanned is the sum of the three counters
    expect(report.signalsScanned).toBe(expectedSignalsScanned);
    expect(report.signalsScanned).toBe(
      report.copiedCount + report.regeneratedCount + report.unrecoverableCount,
    );

    // Verify individual counters are preserved
    expect(report.copiedCount).toBe(copiedCount);
    expect(report.regeneratedCount).toBe(regeneratedCount);
    expect(report.unrecoverableCount).toBe(unrecoverableCount);
  });

  it("signalsScanned is always computed from counters, never from a stored value", async () => {
    dynamoMock.reset();
    rdsMock.reset();

    const jobId = "prop14-stale";
    const staleSignalsScanned = 999_999;
    const copiedCount = 100;
    const regeneratedCount = 50;
    const unrecoverableCount = 7;

    // DynamoDB record includes a stale signalsScanned field — dispatcher must ignore it
    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: `REINDEX#${jobId}`,
        sk: "JOB",
        jobId,
        targetRegistryId: "aurora-prod-titan-v2",
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
  });
});
