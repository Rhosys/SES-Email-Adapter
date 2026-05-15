// Feature: aurora-reindex-strategy, Property 17: Validation flags discrepancies above 1%
// **Validates: Requirements 9.3, 9.4**
//
// For any (auroraCount, expectedCount) pair after a reindex, report.validationOk is true
// if and only if abs(auroraCount - expectedCount) / max(expectedCount, 1) <= 0.01,
// and the 10 sampled cosine similarity values are all non-NaN finite floats in valid range.

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
// Property 17: Validation flags discrepancies above 1%
// ---------------------------------------------------------------------------

describe("Property 17: Validation flags discrepancies above 1%", () => {
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

  // -------------------------------------------------------------------------
  // Property 17a: validationOk is true iff discrepancy <= 1% AND all samples valid
  // -------------------------------------------------------------------------

  const withinThresholdCases: Array<[string, { expectedCount: number; auroraRowCount: number }]> = [
    ["exact match — 1000 expected, 1000 aurora", { expectedCount: 1000, auroraRowCount: 1000 }],
    ["at 1% threshold — 1000 expected, 990 aurora", { expectedCount: 1000, auroraRowCount: 990 }],
    ["small count — 10 expected, 10 aurora", { expectedCount: 10, auroraRowCount: 10 }],
    ["large count at threshold — 5000 expected, 4950 aurora", { expectedCount: 5000, auroraRowCount: 4950 }],
  ];

  it.each(withinThresholdCases)("validationOk is true when discrepancy <= 1%: %s", async (_label, { expectedCount, auroraRowCount }) => {
    dynamoMock.reset();
    rdsMock.reset();

    const jobId = "prop17a-job";

    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: `REINDEX#${jobId}`,
        sk: "JOB",
        jobId,
        targetRegistryId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        copiedCount: expectedCount,
        regeneratedCount: 0,
        unrecoverableCount: 0,
      },
    });

    rdsMock.on(ExecuteStatementCommand)
      .resolvesOnce({ records: [[{ longValue: auroraRowCount }]] })
      .resolvesOnce({
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

    const report = await dispatcher.getReport(jobId);

    const discrepancy = Math.abs(auroraRowCount - expectedCount) / Math.max(expectedCount, 1);
    expect(discrepancy).toBeLessThanOrEqual(0.01);
    expect(report.validationOk).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Property 17b: validationOk is false when discrepancy > 1%
  // -------------------------------------------------------------------------

  const aboveThresholdCases: Array<[string, { expectedCount: number; discrepancyPercent: number }]> = [
    ["2% discrepancy on 1000 signals", { expectedCount: 1000, discrepancyPercent: 2 }],
    ["5% discrepancy on 500 signals", { expectedCount: 500, discrepancyPercent: 5 }],
    ["50% discrepancy on 200 signals", { expectedCount: 200, discrepancyPercent: 50 }],
    ["10% discrepancy on 5000 signals", { expectedCount: 5000, discrepancyPercent: 10 }],
  ];

  it.each(aboveThresholdCases)("validationOk is false when discrepancy exceeds 1%: %s", async (_label, { expectedCount, discrepancyPercent }) => {
    dynamoMock.reset();
    rdsMock.reset();

    const delta = Math.ceil(expectedCount * discrepancyPercent / 100);
    const auroraRowCount = expectedCount - delta;

    const jobId = "prop17b-job";

    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: `REINDEX#${jobId}`,
        sk: "JOB",
        jobId,
        targetRegistryId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        copiedCount: expectedCount,
        regeneratedCount: 0,
        unrecoverableCount: 0,
      },
    });

    rdsMock.on(ExecuteStatementCommand)
      .resolvesOnce({ records: [[{ longValue: auroraRowCount }]] })
      .resolvesOnce({
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

    const report = await dispatcher.getReport(jobId);

    const discrepancy = Math.abs(auroraRowCount - expectedCount) / Math.max(expectedCount, 1);
    expect(discrepancy).toBeGreaterThan(0.01);
    expect(report.validationOk).toBe(false);
    expect(report.validationDetail).toContain("Row count discrepancy");
  });

  // -------------------------------------------------------------------------
  // Property 17c: validationOk is false when any sample has invalid similarity
  // -------------------------------------------------------------------------

  const invalidSamplePositions: Array<[string, { invalidIndex: number }]> = [
    ["invalid sample at position 0 (first)", { invalidIndex: 0 }],
    ["invalid sample at position 4 (middle)", { invalidIndex: 4 }],
    ["invalid sample at position 9 (last)", { invalidIndex: 9 }],
  ];

  it.each(invalidSamplePositions)("validationOk is false when %s", async (_label, { invalidIndex }) => {
    dynamoMock.reset();
    rdsMock.reset();

    const expectedCount = 1000;
    const jobId = "prop17c-job";

    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: `REINDEX#${jobId}`,
        sk: "JOB",
        jobId,
        targetRegistryId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        copiedCount: expectedCount,
        regeneratedCount: 0,
        unrecoverableCount: 0,
      },
    });

    // Aurora count matches exactly (no discrepancy)
    // But one sample has an invalid similarity value (isNull simulates missing)
    const samples = Array.from({ length: 10 }, (_, i) => [
      { stringValue: `arc_${i}` },
      i === invalidIndex ? { isNull: true } : { doubleValue: 0 },
    ]);

    rdsMock.on(ExecuteStatementCommand)
      .resolvesOnce({ records: [[{ longValue: expectedCount }]] })
      .resolvesOnce({ records: samples });

    const report = await dispatcher.getReport(jobId);

    expect(report.validationOk).toBe(false);
    expect(report.validationDetail).toContain("Sample validation failed");
  });

  // -------------------------------------------------------------------------
  // Property 17d: Zero expected count edge case
  // -------------------------------------------------------------------------

  const zeroExpectedCases: Array<[string, { auroraRowCount: number; expectedOk: boolean }]> = [
    ["zero expected, zero aurora — passes", { auroraRowCount: 0, expectedOk: true }],
    ["zero expected, 1 aurora row — fails", { auroraRowCount: 1, expectedOk: false }],
    ["zero expected, 5 aurora rows — fails", { auroraRowCount: 5, expectedOk: false }],
  ];

  it.each(zeroExpectedCases)("handles zero expected count: %s", async (_label, { auroraRowCount, expectedOk }) => {
    dynamoMock.reset();
    rdsMock.reset();

    const jobId = "prop17d-job";

    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: `REINDEX#${jobId}`,
        sk: "JOB",
        jobId,
        targetRegistryId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        copiedCount: 0,
        regeneratedCount: 0,
        unrecoverableCount: 0,
      },
    });

    rdsMock.on(ExecuteStatementCommand)
      .resolvesOnce({ records: [[{ longValue: auroraRowCount }]] })
      .resolvesOnce({
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

    const report = await dispatcher.getReport(jobId);

    expect(report.validationOk).toBe(expectedOk);
  });

  // -------------------------------------------------------------------------
  // Property 17e: Both copiedCount and regeneratedCount contribute to expected
  // -------------------------------------------------------------------------

  const bothCountersCases: Array<[string, { copiedCount: number; regeneratedCount: number; unrecoverableCount: number }]> = [
    ["equal split — 500 copied, 500 regenerated", { copiedCount: 500, regeneratedCount: 500, unrecoverableCount: 0 }],
    ["mostly copied with some regenerated", { copiedCount: 4000, regeneratedCount: 100, unrecoverableCount: 50 }],
    ["mostly regenerated with some copied", { copiedCount: 100, regeneratedCount: 4000, unrecoverableCount: 200 }],
    ["unrecoverable does not affect expected count", { copiedCount: 1000, regeneratedCount: 500, unrecoverableCount: 5000 }],
  ];

  it.each(bothCountersCases)("expectedCount is copiedCount + regeneratedCount: %s", async (_label, { copiedCount, regeneratedCount, unrecoverableCount }) => {
    dynamoMock.reset();
    rdsMock.reset();

    const jobId = "prop17e-job";
    const expectedCount = copiedCount + regeneratedCount;

    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: `REINDEX#${jobId}`,
        sk: "JOB",
        jobId,
        targetRegistryId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        copiedCount,
        regeneratedCount,
        unrecoverableCount,
      },
    });

    // Aurora count matches expected exactly
    rdsMock.on(ExecuteStatementCommand)
      .resolvesOnce({ records: [[{ longValue: expectedCount }]] })
      .resolvesOnce({
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

    const report = await dispatcher.getReport(jobId);

    expect(report.validationOk).toBe(true);
  });
});
