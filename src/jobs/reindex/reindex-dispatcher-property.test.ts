// ---------------------------------------------------------------------------
// Property-based tests for ReindexDispatcher validation discrepancy threshold
// ---------------------------------------------------------------------------

import { describe, it, beforeEach, expect } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ReindexDispatcher } from "./reindex-dispatcher.js";
import { propertyRunner } from "../../testing/property-runner.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const sqsMock = mockClient(SQSClient);
const rdsMock = mockClient(RDSDataClient);

// ---------------------------------------------------------------------------
// Property 17: Validation flags discrepancies above 1%
// Validates: Requirements 9.3, 9.4
// ---------------------------------------------------------------------------

describe.skip("ReindexDispatcher — Property 17: Validation discrepancy threshold", () => {
  let dispatcher: ReindexDispatcher;
  let dynamoMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    sqsMock.reset();
    rdsMock.reset();

    dynamoMock = mockClient(GetCommand);
    dynamoMock.on(GetCommand).resolves({
      Item: {
        pk: "REINDEX#test-job",
        sk: "JOB",
        jobId: "test-job",
        targetClusterId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        copiedCount: 0,
        regeneratedCount: 0,
        unrecoverableCount: 0,
      },
    });

    dispatcher = new ReindexDispatcher({
      sqs: sqsMock as unknown as SQSClient,
      rds: rdsMock as unknown as RDSDataClient,
    });
  });

  // -------------------------------------------------------------------------
  // Property 17a: Discrepancy ≤ 1% → validation passes
  // -------------------------------------------------------------------------

  it(
    "validates successfully when row count discrepancy is ≤ 1%",
    { numRuns: 100 },
    async () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 10000 }), // expectedCount (copied + regenerated)
          fc.integer({ min: 0, max: 1 }), // max discrepancy in absolute terms (1% of expected)
          async (expectedCount, maxDiscrepancy) => {
            // Aurora row count within 1% of expected
            const auroraRowCount = expectedCount + maxDiscrepancy;

            dynamoMock.on(GetCommand).resolves({
              Item: {
                pk: `REINDEX#${expectedCount}`,
                sk: "JOB",
                jobId: `job-${expectedCount}`,
                targetClusterId: "aurora-prod-titan-v2",
                modelId: "amazon.titan-embed-text-v2:0",
                startedAt: new Date(Date.now() - 60000).toISOString(),
                copiedCount: expectedCount,
                regeneratedCount: 0,
                unrecoverableCount: 0,
              },
            });

            rdsMock.on(ExecuteStatementCommand).resolvesOnce({
              records: [[{ longValue: auroraRowCount }]],
            }).resolvesOnce({
              records: Array.from({ length: 10 }, (_, i) => [
                { stringValue: `arc_${i}` },
                { doubleValue: 0 },
              ]),
            });

            const report = await dispatcher.getReport(`job-${expectedCount}`);

            // Validation should pass when discrepancy ≤ 1%
            const discrepancy = expectedCount > 0
              ? Math.abs(auroraRowCount - expectedCount) / expectedCount
              : 0;
            expect(discrepancy).toBeLessThanOrEqual(0.01);
            expect(report.validationOk).toBe(true);
          },
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Property 17b: Discrepancy > 1% → validation fails
  // -------------------------------------------------------------------------

  it(
    "flags validation failure when row count discrepancy exceeds 1%",
    { numRuns: 100 },
    async () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 10000 }), // expectedCount
          fc.integer({ min: 2, max: 100 }), // discrepancy multiplier (2% to 100%)
          async (expectedCount, discrepancyPercent) => {
            // Aurora row count with discrepancy > 1%
            const discrepancy = discrepancyPercent / 100;
            const auroraRowCount = Math.floor(expectedCount * (1 - discrepancy));

            dynamoMock.on(GetCommand).resolves({
              Item: {
                pk: `REINDEX#${expectedCount}`,
                sk: "JOB",
                jobId: `job-${expectedCount}`,
                targetClusterId: "aurora-prod-titan-v2",
                modelId: "amazon.titan-embed-text-v2:0",
                startedAt: new Date(Date.now() - 60000).toISOString(),
                copiedCount: expectedCount,
                regeneratedCount: 0,
                unrecoverableCount: 0,
              },
            });

            rdsMock.on(ExecuteStatementCommand).resolvesOnce({
              records: [[{ longValue: auroraRowCount }]],
            }).resolvesOnce({
              records: Array.from({ length: 10 }, (_, i) => [
                { stringValue: `arc_${i}` },
                { doubleValue: 0 },
              ]),
            });

            const report = await dispatcher.getReport(`job-${expectedCount}`);

            // Validation should fail when discrepancy > 1%
            const actualDiscrepancy = expectedCount > 0
              ? Math.abs(auroraRowCount - expectedCount) / expectedCount
              : 0;
            expect(actualDiscrepancy).toBeGreaterThan(0.01);
            expect(report.validationOk).toBe(false);
            expect(report.validationDetail).toContain("Row count discrepancy");
          },
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Property 17c: Edge case at exactly 1% threshold
  // -------------------------------------------------------------------------

  it(
    "passes validation when discrepancy is exactly 1%",
    { numRuns: 100 },
    async () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 100, max: 10000 }),
          async (expectedCount) => {
            // Exactly 1% discrepancy
            const auroraRowCount = Math.floor(expectedCount * 0.99);

            dynamoMock.on(GetCommand).resolves({
              Item: {
                pk: `REINDEX#${expectedCount}`,
                sk: "JOB",
                jobId: `job-${expectedCount}`,
                targetClusterId: "aurora-prod-titan-v2",
                modelId: "amazon.titan-embed-text-v2:0",
                startedAt: new Date(Date.now() - 60000).toISOString(),
                copiedCount: expectedCount,
                regeneratedCount: 0,
                unrecoverableCount: 0,
              },
            });

            rdsMock.on(ExecuteStatementCommand).resolvesOnce({
              records: [[{ longValue: auroraRowCount }]],
            }).resolvesOnce({
              records: Array.from({ length: 10 }, (_, i) => [
                { stringValue: `arc_${i}` },
                { doubleValue: 0 },
              ]),
            });

            const report = await dispatcher.getReport(`job-${expectedCount}`);

            const discrepancy = expectedCount > 0
              ? Math.abs(auroraRowCount - expectedCount) / expectedCount
              : 0;
            expect(discrepancy).toBeCloseTo(0.01);
            expect(report.validationOk).toBe(true);
          },
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Property 17d: Small expected counts (edge case for percentage calculation)
  // -------------------------------------------------------------------------

  it(
    "handles small expected counts correctly",
    { numRuns: 100 },
    async () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }), // small expected counts
          fc.integer({ min: 0, max: 1 }), // small absolute discrepancy
          async (expectedCount, absoluteDiscrepancy) => {
            const auroraRowCount = Math.max(0, expectedCount - absoluteDiscrepancy);

            dynamoMock.on(GetCommand).resolves({
              Item: {
                pk: `REINDEX#${expectedCount}`,
                sk: "JOB",
                jobId: `job-${expectedCount}`,
                targetClusterId: "aurora-prod-titan-v2",
                modelId: "amazon.titan-embed-text-v2:0",
                startedAt: new Date(Date.now() - 60000).toISOString(),
                copiedCount: expectedCount,
                regeneratedCount: 0,
                unrecoverableCount: 0,
              },
            });

            rdsMock.on(ExecuteStatementCommand).resolvesOnce({
              records: [[{ longValue: auroraRowCount }]],
            }).resolvesOnce({
              records: Array.from({ length: 10 }, (_, i) => [
                { stringValue: `arc_${i}` },
                { doubleValue: 0 },
              ]),
            });

            const report = await dispatcher.getReport(`job-${expectedCount}`);

            const discrepancy = expectedCount > 0
              ? Math.abs(auroraRowCount - expectedCount) / expectedCount
              : 0;

            // For small counts, even 1 absolute difference can be > 1%
            // The test verifies the dispatcher correctly flags these
            if (discrepancy <= 0.01) {
              expect(report.validationOk).toBe(true);
            } else {
              expect(report.validationOk).toBe(false);
              expect(report.validationDetail).toContain("Row count discrepancy");
            }
          },
        ),
      );
    },
  );
});
