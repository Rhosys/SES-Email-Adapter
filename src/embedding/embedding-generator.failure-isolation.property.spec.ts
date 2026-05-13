// ---------------------------------------------------------------------------
// Per-model failure isolation in the embedding generator
// **Validates: Requirements 3.5**
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockActiveClusters } = vi.hoisted(() => ({
  mockActiveClusters: { value: [] as Array<{ clusterId: string; clusterArn: string; secretArn: string; databaseName: string; modelId: string; dimensions: number; active: boolean }> },
}));

vi.mock("./cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze(mockActiveClusters.value.map((c) => Object.freeze(c))),
  getActiveClusters: () => mockActiveClusters.value.filter((c) => c.active),
  getClusterById: (id: string) => mockActiveClusters.value.find((c) => c.clusterId === id) ?? null,
}));

describe("Bedrock failure for one model preserves all other writes", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  let stdoutSpy: MockInstance;

  const THREE_CLUSTERS = [
    { clusterId: "cluster-a", clusterArn: "arn:a", secretArn: "secret:a", databaseName: "signals", modelId: "model-alpha", dimensions: 1024, active: true },
    { clusterId: "cluster-b", clusterArn: "arn:b", secretArn: "secret:b", databaseName: "signals", modelId: "model-beta", dimensions: 1536, active: true },
    { clusterId: "cluster-c", clusterArn: "arn:c", secretArn: "secret:c", databaseName: "signals", modelId: "model-gamma", dimensions: 512, active: true },
  ];

  beforeEach(() => {
    bedrockMock.reset();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when first model fails, results contain only the succeeding models and metric is emitted", async () => {
    mockActiveClusters.value = THREE_CLUSTERS;
    const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount === 1) throw new Error("Bedrock failed for testing");
      return { body: new TextEncoder().encode(JSON.stringify({ embedding: Array(10).fill(0.1) })) };
    });

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
    const results = await generator.generateForActiveClusters("test text");

    expect(results).toHaveLength(2);
    const resultModelIds = results.map((r) => r.modelId);
    expect(resultModelIds).toContain("model-beta");
    expect(resultModelIds).toContain("model-gamma");
    expect(resultModelIds).not.toContain("model-alpha");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const metricLog = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
    expect(metricLog.modelId).toBe("model-alpha");
    expect(metricLog.embedding_generation_failed).toBe(1);
  });

  it("when multiple models fail, results contain only successful models", async () => {
    mockActiveClusters.value = THREE_CLUSTERS;
    const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount <= 2) throw new Error("Bedrock failed");
      return { body: new TextEncoder().encode(JSON.stringify({ embedding: Array(10).fill(0.1) })) };
    });

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
    const results = await generator.generateForActiveClusters("test text");

    expect(results).toHaveLength(1);
    expect(results[0]!.modelId).toBe("model-gamma");
    expect(stdoutSpy).toHaveBeenCalledTimes(2);
  });

  it("when all models fail, results is empty and metrics emitted for each", async () => {
    mockActiveClusters.value = THREE_CLUSTERS;
    const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

    bedrockMock.on(InvokeModelCommand).rejects(new Error("All broken"));

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
    const results = await generator.generateForActiveClusters("test text");

    expect(results).toEqual([]);
    expect(stdoutSpy).toHaveBeenCalledTimes(3);

    const metricLogs = stdoutSpy.mock.calls.map((call) => JSON.parse(call[0] as string));
    const failedModelIds = metricLogs.map((m: { modelId: string }) => m.modelId);
    expect(failedModelIds).toContain("model-alpha");
    expect(failedModelIds).toContain("model-beta");
    expect(failedModelIds).toContain("model-gamma");
  });
});
