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

import { describe, it, beforeEach, vi } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { SQSClient } from "@aws-sdk/client-sqs";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
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
  const mod = await import("../../database/shared.js") as unknown as {
    __dynamoMock: ReturnType<typeof mockClient>;
  };
  return mod.__dynamoMock;
}

// ---------------------------------------------------------------------------
// Property test
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

  it("validationOk is true iff discrepancy ≤ 1% and samples are valid", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        // Generate copiedCount and regeneratedCount (these sum to the expected DDB count)
        fc.nat({ max: 10000 }),
        fc.nat({ max: 10000 }),
        // Generate unrecoverableCount (does not affect expected Aurora count)
        fc.nat({ max: 1000 }),
        // Generate auroraRowCount independently
        fc.nat({ max: 20000 }),
        async (copiedCount, regeneratedCount, unrecoverableCount, auroraRowCount) => {
          dynamoMock.reset();
          rdsMock.reset();

          const jobId = "prop17-job";
          const expectedCount = copiedCount + regeneratedCount;

          // Mock DynamoDB GetCommand to return the job counters
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

          // Mock Aurora: first call returns row count, second returns valid samples
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

          // Compute expected discrepancy using the same formula as the implementation
          const discrepancy = expectedCount > 0
            ? Math.abs(auroraRowCount - expectedCount) / expectedCount
            : (auroraRowCount === 0 ? 0 : 1);

          const shouldBeOk = discrepancy <= 0.01;

          // validationOk should match the threshold check
          // (sample validation always passes in this test since we mock valid samples)
          if (shouldBeOk) {
            return report.validationOk === true;
          } else {
            return report.validationOk === false;
          }
        },
      ),
    );
  });

  it("validationOk is false when samples contain invalid cosine similarity values", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        // Generate a matching count (discrepancy = 0%) so only sample validation matters
        fc.integer({ min: 1, max: 5000 }),
        // Generate an invalid similarity value (NaN, or out of [-1, 2] range)
        fc.oneof(
          fc.constant(NaN),
          fc.double({ min: 2.01, max: 100, noNaN: true }),
          fc.double({ min: -100, max: -1.01, noNaN: true }),
        ),
        async (count, invalidSimilarity) => {
          dynamoMock.reset();
          rdsMock.reset();

          const jobId = "prop17-invalid-sample";

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
              // Include at least one invalid sample
              records: [
                [{ stringValue: "arc_0" }, { doubleValue: 0 }],
                [{ stringValue: "arc_1" }, { doubleValue: invalidSimilarity }],
                [{ stringValue: "arc_2" }, { doubleValue: 0 }],
              ],
            });

          const report = await dispatcher.getReport(jobId);

          // Even with 0% count discrepancy, invalid samples should fail validation
          return report.validationOk === false;
        },
      ),
    );
  });
});
