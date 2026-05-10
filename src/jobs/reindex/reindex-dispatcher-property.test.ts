// Feature: aurora-reindex-strategy, Property 17: Validation flags discrepancies above 1%
// **Validates: Requirements 9.3, 9.4**
//
// For any (auroraCount, expectedCount) pair after a reindex, report.validationOk is true
// if and only if abs(auroraCount - expectedCount) / max(expectedCount, 1) <= 0.01,
// and the 10 sampled cosine similarity values are all non-NaN finite floats in valid range.

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

  it("validationOk is true when discrepancy <= 1% and all 10 samples are valid", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10_000 }),
        async (expectedCount) => {
          dynamoMock.reset();
          rdsMock.reset();

          // Aurora row count within 1% of expected
          const maxDelta = Math.floor(expectedCount * 0.01);
          const auroraRowCount = expectedCount - maxDelta; // exactly at threshold

          const jobId = "prop17a-job";

          dynamoMock.on(GetCommand).resolves({
            Item: {
              pk: `REINDEX#${jobId}`,
              sk: "JOB",
              jobId,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
              startedAt: new Date(Date.now() - 60000).toISOString(),
              copiedCount: expectedCount,
              regeneratedCount: 0,
              unrecoverableCount: 0,
            },
          });

          // Aurora count query returns within-threshold count
          rdsMock.on(ExecuteStatementCommand)
            .resolvesOnce({ records: [[{ longValue: auroraRowCount }]] })
            .resolvesOnce({
              // 10 valid cosine similarity samples (self-similarity = 0)
              records: Array.from({ length: 10 }, (_, i) => [
                { stringValue: `arc_${i}` },
                { doubleValue: 0 },
              ]),
            });

          const report = await dispatcher.getReport(jobId);

          // Verify the discrepancy is indeed <= 1%
          const discrepancy = Math.abs(auroraRowCount - expectedCount) / Math.max(expectedCount, 1);
          expect(discrepancy).toBeLessThanOrEqual(0.01);
          expect(report.validationOk).toBe(true);

          return true;
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property 17b: validationOk is false when discrepancy > 1%
  // -------------------------------------------------------------------------

  it("validationOk is false when discrepancy exceeds 1%", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 10_000 }),
        fc.integer({ min: 2, max: 50 }), // discrepancy percentage (2% to 50%)
        async (expectedCount, discrepancyPercent) => {
          dynamoMock.reset();
          rdsMock.reset();

          // Aurora row count with discrepancy > 1%
          const delta = Math.ceil(expectedCount * discrepancyPercent / 100);
          const auroraRowCount = expectedCount - delta;

          const jobId = "prop17b-job";

          dynamoMock.on(GetCommand).resolves({
            Item: {
              pk: `REINDEX#${jobId}`,
              sk: "JOB",
              jobId,
              targetClusterId: "aurora-prod-titan-v2",
              modelId: "amazon.titan-embed-text-v2:0",
              startedAt: new Date(Date.now() - 60000).toISOString(),
              copiedCount: expectedCount,
              regeneratedCount: 0,
              unrecoverableCount: 0,
            },
          });

          // Aurora count query returns out-of-threshold count
          rdsMock.on(ExecuteStatementCommand)
            .resolvesOnce({ records: [[{ longValue: auroraRowCount }]] })
            .resolvesOnce({
              // Valid samples — discrepancy alone should fail validation
              records: Array.from({ length: 10 }, (_, i) => [
                { stringValue: `arc_${i}` },
                { doubleValue: 0 },
              ]),
            });

          const report = await dispatcher.getReport(jobId);

          // Verify the discrepancy is indeed > 1%
          const discrepancy = Math.abs(auroraRowCount - expectedCount) / Math.max(expectedCount, 1);
          expect(discrepancy).toBeGreaterThan(0.01);
          expect(report.validationOk).toBe(false);
          expect(report.validationDetail).toContain("Row count discrepancy");

          return true;
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property 17c: validationOk is false when any sample has invalid similarity
  // -------------------------------------------------------------------------

  it("validationOk is false when any sampled cosine similarity is NaN or out of range", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 10_000 }),
        fc.integer({ min: 0, max: 9 }), // index of the invalid sample
        async (expectedCount, invalidIndex) => {
          dynamoMock.reset();
          rdsMock.reset();

          const jobId = "prop17c-job";

          dynamoMock.on(GetCommand).resolves({
            Item: {
              pk: `REINDEX#${jobId}`,
              sk: "JOB",
              jobId,
              targetClusterId: "aurora-prod-titan-v2",
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

          // Count is fine, but sample validation should fail
          expect(report.validationOk).toBe(false);
          expect(report.validationDetail).toContain("Sample validation failed");

          return true;
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property 17d: Zero expected count edge case
  // -------------------------------------------------------------------------

  it("handles zero expected count correctly (no division by zero)", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }), // small aurora count when expected is 0
        async (auroraRowCount) => {
          dynamoMock.reset();
          rdsMock.reset();

          const jobId = "prop17d-job";

          dynamoMock.on(GetCommand).resolves({
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

          rdsMock.on(ExecuteStatementCommand)
            .resolvesOnce({ records: [[{ longValue: auroraRowCount }]] })
            .resolvesOnce({
              records: Array.from({ length: 10 }, (_, i) => [
                { stringValue: `arc_${i}` },
                { doubleValue: 0 },
              ]),
            });

          const report = await dispatcher.getReport(jobId);

          // When expectedCount is 0 and auroraRowCount is 0, discrepancy is 0 → pass
          // When expectedCount is 0 and auroraRowCount > 0, discrepancy is 1 (100%) → fail
          if (auroraRowCount === 0) {
            expect(report.validationOk).toBe(true);
          } else {
            expect(report.validationOk).toBe(false);
          }

          return true;
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property 17e: Both copiedCount and regeneratedCount contribute to expected
  // -------------------------------------------------------------------------

  it("expectedCount is copiedCount + regeneratedCount (unrecoverable excluded)", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        async (copiedCount, regeneratedCount, unrecoverableCount) => {
          dynamoMock.reset();
          rdsMock.reset();

          const jobId = "prop17e-job";
          const expectedCount = copiedCount + regeneratedCount;

          dynamoMock.on(GetCommand).resolves({
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

          // When aurora matches expected exactly, validation passes
          if (expectedCount === 0) {
            // Zero expected + zero aurora = pass
            expect(report.validationOk).toBe(true);
          } else {
            expect(report.validationOk).toBe(true);
          }

          return true;
        },
      ),
    );
  });
});
