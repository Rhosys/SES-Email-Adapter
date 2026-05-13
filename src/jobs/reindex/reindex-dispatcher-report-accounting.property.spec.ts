// Feature: aurora-reindex-strategy, Property 14: Job reports preserve scan accounting
// **Validates: Requirements 5.5, 9.1, 9.2**
//
// For any completed reindex job, the report's signalsScanned === copiedCount + regeneratedCount + unrecoverableCount
// invariant holds. The dispatcher computes signalsScanned as the sum of the three counters (never stored separately).

import { describe, it, expect, beforeEach } from "vitest";
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
const ddbMock = mockClient(DynamoDBDocumentClient);

// ---------------------------------------------------------------------------
// Edge cases for counter values
// ---------------------------------------------------------------------------

const accountingCases: Array<[string, { copiedCount: number; regeneratedCount: number; unrecoverableCount: number }]> = [
  ["all zeros — empty job", { copiedCount: 0, regeneratedCount: 0, unrecoverableCount: 0 }],
  ["only copied", { copiedCount: 1000, regeneratedCount: 0, unrecoverableCount: 0 }],
  ["only regenerated", { copiedCount: 0, regeneratedCount: 500, unrecoverableCount: 0 }],
  ["only unrecoverable", { copiedCount: 0, regeneratedCount: 0, unrecoverableCount: 200 }],
  ["mixed counters", { copiedCount: 3000, regeneratedCount: 1500, unrecoverableCount: 42 }],
  ["large values near max", { copiedCount: 100000, regeneratedCount: 100000, unrecoverableCount: 100000 }],
];

const missingFieldCases: Array<[string, { copiedCount?: number; regeneratedCount?: number; unrecoverableCount?: number }]> = [
  ["all fields missing — defaults to 0", { copiedCount: undefined, regeneratedCount: undefined, unrecoverableCount: undefined }],
  ["only copiedCount present", { copiedCount: 500, regeneratedCount: undefined, unrecoverableCount: undefined }],
  ["only regeneratedCount present", { copiedCount: undefined, regeneratedCount: 300, unrecoverableCount: undefined }],
  ["only unrecoverableCount present", { copiedCount: undefined, regeneratedCount: undefined, unrecoverableCount: 10 }],
  ["copiedCount missing", { copiedCount: undefined, regeneratedCount: 200, unrecoverableCount: 50 }],
  ["regeneratedCount missing", { copiedCount: 400, regeneratedCount: undefined, unrecoverableCount: 30 }],
  ["unrecoverableCount missing", { copiedCount: 400, regeneratedCount: 200, unrecoverableCount: undefined }],
];

// ---------------------------------------------------------------------------
// Property 14: Job reports preserve scan accounting
// ---------------------------------------------------------------------------

describe("ReindexDispatcher — Property 14: Job reports preserve scan accounting", () => {
  let dispatcher: ReindexDispatcher;

  beforeEach(() => {
    sqsMock.reset();
    rdsMock.reset();
    ddbMock.reset();

    dispatcher = new ReindexDispatcher({
      sqs: sqsMock as unknown as SQSClient,
      rds: rdsMock as unknown as RDSDataClient,
    });
  });

  it.each(accountingCases)("%s", async (_label, { copiedCount, regeneratedCount, unrecoverableCount }) => {
    ddbMock.reset();
    rdsMock.reset();

    const jobId = `job-prop14-${copiedCount}-${regeneratedCount}-${unrecoverableCount}`;
    const expectedSignalsScanned = copiedCount + regeneratedCount + unrecoverableCount;

    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: `REINDEX#${jobId}`,
        sk: "JOB",
        jobId,
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        copiedCount,
        regeneratedCount,
        unrecoverableCount,
      },
    });

    const auroraRowCount = copiedCount + regeneratedCount;
    rdsMock.on(ExecuteStatementCommand)
      .resolvesOnce({
        records: [[{ longValue: auroraRowCount }]],
      })
      .resolvesOnce({
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

    const report = await dispatcher.getReport(jobId);

    expect(report.signalsScanned).toBe(expectedSignalsScanned);
    expect(report.signalsScanned).toBe(report.copiedCount + report.regeneratedCount + report.unrecoverableCount);
    expect(report.copiedCount).toBe(copiedCount);
    expect(report.regeneratedCount).toBe(regeneratedCount);
    expect(report.unrecoverableCount).toBe(unrecoverableCount);
  });

  it.each(missingFieldCases)("missing fields: %s", async (_label, { copiedCount, regeneratedCount, unrecoverableCount }) => {
    ddbMock.reset();
    rdsMock.reset();

    const jobId = "job-prop14-missing-fields";

    // Simulate DynamoDB returning undefined for some counters
    const item: Record<string, unknown> = {
      pk: `REINDEX#${jobId}`,
      sk: "JOB",
      jobId,
      targetClusterId: "aurora-prod-titan-v2",
      modelId: "amazon.titan-embed-text-v2:0",
      startedAt: new Date(Date.now() - 60000).toISOString(),
    };
    if (copiedCount !== undefined) item["copiedCount"] = copiedCount;
    if (regeneratedCount !== undefined) item["regeneratedCount"] = regeneratedCount;
    if (unrecoverableCount !== undefined) item["unrecoverableCount"] = unrecoverableCount;

    ddbMock.on(GetCommand).resolves({ Item: item });

    const effectiveCopied = copiedCount ?? 0;
    const effectiveRegenerated = regeneratedCount ?? 0;
    const effectiveUnrecoverable = unrecoverableCount ?? 0;
    const expectedSignalsScanned = effectiveCopied + effectiveRegenerated + effectiveUnrecoverable;

    const auroraRowCount = effectiveCopied + effectiveRegenerated;
    rdsMock.on(ExecuteStatementCommand)
      .resolvesOnce({ records: [[{ longValue: auroraRowCount }]] })
      .resolvesOnce({
        records: Array.from({ length: 10 }, (_, i) => [
          { stringValue: `arc_${i}` },
          { doubleValue: 0 },
        ]),
      });

    const report = await dispatcher.getReport(jobId);

    expect(report.signalsScanned).toBe(expectedSignalsScanned);
    expect(report.signalsScanned).toBe(report.copiedCount + report.regeneratedCount + report.unrecoverableCount);
  });
});
