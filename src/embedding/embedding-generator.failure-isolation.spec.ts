import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEmbeddingGenerator } from "./embedding-generator.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with two active clusters
// ---------------------------------------------------------------------------

vi.mock("./cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze([
    Object.freeze({
      clusterId: "cluster-a",
      clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-a",
      secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-a",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    }),
    Object.freeze({
      clusterId: "cluster-b",
      clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-b",
      secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-b",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v3:0",
      dimensions: 1536,
      active: true,
    }),
  ]),
  getActiveClusters: () => [
    {
      clusterId: "cluster-a",
      clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-a",
      secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-a",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    },
    {
      clusterId: "cluster-b",
      clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-b",
      secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-b",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v3:0",
      dimensions: 1536,
      active: true,
    },
  ],
}));

// Cluster metadata used in assertions (mirrors the mock above)
const ACTIVE_CLUSTERS = [
  { modelId: "amazon.titan-embed-text-v2:0", dimensions: 1024 },
  { modelId: "amazon.titan-embed-text-v3:0", dimensions: 1536 },
] as const;

// ---------------------------------------------------------------------------
// Feature: aurora-reindex-strategy, Property 7: Bedrock failure for one model preserves all other writes
// **Validates: Requirements 3.5**
// ---------------------------------------------------------------------------

/**
 * For any signal processed against a registry where Bedrock fails for one model after retries,
 * the DynamoDB Signal record is still persisted; its embeddings map contains entries only for
 * the succeeding models; the failure is reported via the embedding_generation_failed metric
 * tagged with the failing model ID; and the succeeding clusters' Aurora rows are unaffected.
 */
describe("Property 7: Bedrock failure for one model preserves all other writes", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  /** Encode JSON as a mock Bedrock response body. */
  const mockBody = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)) as never;
  let generator: BedrockEmbeddingGenerator;
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    bedrockMock.reset();
    generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  // -------------------------------------------------------------------------
  // Example-based tests (supporting the property)
  // -------------------------------------------------------------------------

  it("returns null for the failed model and includes the successful model", async () => {
    // Simulate failure for cluster-a (first call), success for cluster-b (second call)
    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount === 1) {
        // First call (cluster-a) fails
        throw new Error("Bedrock throttled for titan-v2");
      }
      // Second call (cluster-b) succeeds
      return {
        body: mockBody({ embedding: [0.5, 0.6, 0.7] }),
      };
    });

    const results = await generator.generateForActiveClusters("test text");

    // Should have exactly 1 result (only the successful model)
    expect(results).toHaveLength(1);
    expect(results[0]!.modelId).toBe("amazon.titan-embed-text-v3:0");
    expect(results[0]!.dimensions).toBe(1536);
  });

  it("emits embedding_generation_failed metric for the failing model", async () => {
    // First call fails, second succeeds
    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Bedrock unavailable");
      }
      return {
        body: mockBody({ embedding: [0.1] }),
      };
    });

    await generator.generateForActiveClusters("test");

    // Should have emitted exactly 1 metric (for the failing model)
    expect(stdoutSpy).toHaveBeenCalledTimes(1);

    const metricLog = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
    expect(metricLog._aws.CloudWatchMetrics[0].Metrics[0].Name).toBe("embedding_generation_failed");
    expect(metricLog.modelId).toBe("amazon.titan-embed-text-v2:0");
    expect(metricLog.embedding_generation_failed).toBe(1);
  });

  it("does not emit metric for successful models", async () => {
    // Both calls succeed
    bedrockMock.on(InvokeModelCommand).resolves({
      body: mockBody({ embedding: [0.1] }),
    });

    await generator.generateForActiveClusters("test");

    // Should have emitted 0 metrics (no failures)
    expect(stdoutSpy).toHaveBeenCalledTimes(0);
  });

  it("continues processing remaining models after one failure", async () => {
    // First call fails, second succeeds, third fails
    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount === 1 || callCount === 3) {
        throw new Error("Bedrock error");
      }
      return {
        body: mockBody({ embedding: [0.2] }),
      };
    });

    const results = await generator.generateForActiveClusters("test");

    // Should have exactly 1 result (only the successful model)
    expect(results).toHaveLength(1);
    expect(results[0]!.modelId).toBe("amazon.titan-embed-text-v3:0");
  });

  it("does not throw when all models fail", async () => {
    // Both calls fail
    bedrockMock.on(InvokeModelCommand).rejects(new Error("All broken"));

    const results = await generator.generateForActiveClusters("test");

    // Should return empty array, not throw
    expect(results).toEqual([]);
    expect(stdoutSpy).toHaveBeenCalledTimes(2); // 2 metrics, one per failed model
  });

  it("produces deterministic results when same model fails consistently", async () => {
    // Both calls see the same failure pattern: cluster-a always fails, cluster-b always succeeds.
    // This tests generator determinism — given the same external behavior, same output.
    bedrockMock.reset();

    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v2:0" })
      .rejects(new Error("Bedrock throttled"));
    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v3:0" })
      .resolves({
        body: mockBody({ embedding: [0.5, 0.6] }),
      });

    const results1 = await generator.generateForActiveClusters("same text");
    const results2 = await generator.generateForActiveClusters("same text");

    expect(results1).toEqual(results2);
    expect(results1).toHaveLength(1);
    expect(results1[0]!.modelId).toBe("amazon.titan-embed-text-v3:0");
  });
});
