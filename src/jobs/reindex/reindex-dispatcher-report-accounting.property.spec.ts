// Feature: aurora-reindex-strategy, Property 14: Job reports preserve scan accounting
// **Validates: Requirements 5.5, 9.1, 9.2**
//
// For any completed reindex job, the report's signalsScanned === copiedCount + regeneratedCount + unrecoverableCount
// invariant holds. The dispatcher computes signalsScanned as the sum of the three counters (never stored separately).

import { describe, it, beforeEach } from "vitest";
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
const ddbMock = mockClient(DynamoDBDocumentClient);

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

  // -------------------------------------------------------------------------
  // Property 14: signalsScanned === copiedCount + regeneratedCount + unrecoverableCount
  // -------------------------------------------------------------------------

  it("signalsScanned always equals copiedCount + regeneratedCount + unrecoverableCount for any counter values", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.nat({ max: 100000 }), // copiedCount
        fc.nat({ max: 100000 }), // regeneratedCount
        fc.nat({ max: 100000 }), // unrecoverableCount
        async (copiedCount, regeneratedCount, unrecoverableCount) => {
          ddbMock.reset();
          rdsMock.reset();

          const jobId = `job-prop14-${copiedCount}-${regeneratedCount}-${unrecoverableCount}`;
          const expectedSignalsScanned = copiedCount + regeneratedCount + unrecoverableCount;

          // Mock DynamoDB GetCommand to return the job counters
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

          // Mock Aurora validation queries (row count + sample)
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

          // The core invariant: signalsScanned is always the sum of the three counters
          if (report.signalsScanned !== expectedSignalsScanned) {
            return false;
          }
          if (report.signalsScanned !== report.copiedCount + report.regeneratedCount + report.unrecoverableCount) {
            return false;
          }
          // Verify individual counters are preserved correctly
          if (report.copiedCount !== copiedCount) return false;
          if (report.regeneratedCount !== regeneratedCount) return false;
          if (report.unrecoverableCount !== unrecoverableCount) return false;

          return true;
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property 14b: The invariant holds even when all counters are zero
  // -------------------------------------------------------------------------

  it("signalsScanned is zero when all counters are zero", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.constant(null), // no input needed, just verifying the zero case
        async () => {
          ddbMock.reset();
          rdsMock.reset();

          const jobId = "job-prop14-zero";

          ddbMock.on(GetCommand).resolves({
            Item: {
              pk: `REINDEX#${jobId}`,
              sk: "JOB",
              jobId,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
              startedAt: new Date(Date.now() - 60000).toISOString(),
              copiedCount: 0,
              regeneratedCount: 0,
              unrecoverableCount: 0,
            },
          });

          // Aurora returns 0 rows
          rdsMock.on(ExecuteStatementCommand)
            .resolvesOnce({ records: [[{ longValue: 0 }]] })
            .resolvesOnce({ records: [] });

          const report = await dispatcher.getReport(jobId);

          if (report.signalsScanned !== 0) return false;
          if (report.copiedCount !== 0) return false;
          if (report.regeneratedCount !== 0) return false;
          if (report.unrecoverableCount !== 0) return false;

          return true;
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property 14c: signalsScanned is never stored separately — it is always
  // derived from the three counters, so even if DynamoDB returns undefined
  // for a counter, the sum still holds (defaults to 0).
  // -------------------------------------------------------------------------

  it("signalsScanned handles missing counter fields gracefully (defaults to 0)", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.option(fc.nat({ max: 100000 }), { nil: undefined }),
        fc.option(fc.nat({ max: 100000 }), { nil: undefined }),
        fc.option(fc.nat({ max: 100000 }), { nil: undefined }),
        async (copiedCount, regeneratedCount, unrecoverableCount) => {
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

          // Aurora row count matches expected
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

          // The invariant must hold even with missing fields
          if (report.signalsScanned !== expectedSignalsScanned) return false;
          if (report.signalsScanned !== report.copiedCount + report.regeneratedCount + report.unrecoverableCount) return false;

          return true;
        },
      ),
    );
  });
});
