// ---------------------------------------------------------------------------
// Feature: aurora-reindex-strategy, Property 17: Validation flags discrepancies above 1%
// ---------------------------------------------------------------------------
// **Validates: Requirements 9.3, 9.4**
//
// For any (auroraRowCount, dynamoEmbeddingCount) pair:
// - If the discrepancy exceeds 1%, the report flags validationOk = false
// - If the discrepancy is ≤ 1%, the report flags validationOk = true
//   (assuming sample validation passes)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient } from "@aws-sdk/client-sqs";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
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
  const mod = await import("../../database/shared.js") as unknown as {
    __dynamoMock: ReturnType<typeof mockClient>;
  };
  return mod.__dynamoMock;
}

// ---------------------------------------------------------------------------
// Edge cases for discrepancy threshold
// ---------------------------------------------------------------------------

const discrepancyCases: Array<[string, { copiedCount: number; regeneratedCount: number; auroraRowCount: number; expectedOk: boolean }]> = [
  ["exact match — 0% discrepancy", { copiedCount: 1000, regeneratedCount: 0, auroraRowCount: 1000, expectedOk: true }],
  ["at threshold — exactly 1% below", { copiedCount: 1000, regeneratedCount: 0, auroraRowCount: 990, expectedOk: true }],
  ["just above threshold — 2% discrepancy", { copiedCount: 1000, regeneratedCount: 0, auroraRowCount: 980, expectedOk: false }],
  ["large discrepancy — 50% missing", { copiedCount: 1000, regeneratedCount: 0, auroraRowCount: 500, expectedOk: false }],
  ["aurora has more rows than expected — 2% over", { copiedCount: 1000, regeneratedCount: 0, auroraRowCount: 1020, expectedOk: false }],
  ["zero expected, zero aurora — no discrepancy", { copiedCount: 0, regeneratedCount: 0, auroraRowCount: 0, expectedOk: true }],
  ["zero expected, non-zero aurora — 100% discrepancy", { copiedCount: 0, regeneratedCount: 0, auroraRowCount: 5, expectedOk: false }],
  ["both copied and regenerated contribute to expected", { copiedCount: 500, regeneratedCount: 500, auroraRowCount: 1000, expectedOk: true }],
  ["small count at threshold boundary — 100 expected, 99 aurora", { copiedCount: 100, regeneratedCount: 0, auroraRowCount: 99, expectedOk: true }],
  ["small count just over threshold — 100 expected, 98 aurora", { copiedCount: 100, regeneratedCount: 0, auroraRowCount: 98, expectedOk: false }],
];

const invalidSampleCases: Array<[string, { invalidSimilarity: number | null }]> = [
  ["NaN similarity value", { invalidSimilarity: NaN }],
  ["similarity above valid range (2.5)", { invalidSimilarity: 2.5 }],
  ["similarity below valid range (-1.5)", { invalidSimilarity: -1.5 }],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReindexDispatcher — Property 17: Validation flags discrepancies above 1%", () => {
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

  it.each(discrepancyCases)("%s", async (_label, { copiedCount, regeneratedCount, auroraRowCount, expectedOk }) => {
    dynamoMock.reset();
    rdsMock.reset();

    const jobId = "prop17-job";

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
        unrecoverableCount: 0,
      },
    });

    rdsMock.on(ExecuteStatementCommand)
      .resolvesOnce({
        records: [[{ longValue: auroraRowCount }]],
      })
      .resolvesOnce({
        // 10 valid sample vectors with self-similarity = 0
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

    const report = await dispatcher.getReport(jobId);

    expect(report.validationOk).toBe(expectedOk);
  });

  it.each(invalidSampleCases)("validationOk is false when samples contain %s", async (_label, { invalidSimilarity }) => {
    dynamoMock.reset();
    rdsMock.reset();

    const jobId = "prop17-invalid-sample";
    const count = 1000;

    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: `REINDEX#${jobId}`,
        sk: "JOB",
        jobId,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date(Date.now() - 5000).toISOString(),
        copiedCount: count,
        regeneratedCount: 0,
        unrecoverableCount: 0,
      },
    });

    // Aurora row count matches exactly (0% discrepancy)
    rdsMock.on(ExecuteStatementCommand)
      .resolvesOnce({
        records: [[{ longValue: count }]],
      })
      .resolvesOnce({
        // Include one invalid sample
        records: [
          [{ stringValue: "arc_0" }, { doubleValue: 0 }],
          [{ stringValue: "arc_1" }, invalidSimilarity === null ? { isNull: true } : { doubleValue: invalidSimilarity }],
          [{ stringValue: "arc_2" }, { doubleValue: 0 }],
        ],
      });

    const report = await dispatcher.getReport(jobId);

    // Even with 0% count discrepancy, invalid samples should fail validation
    expect(report.validationOk).toBe(false);
  });
});
