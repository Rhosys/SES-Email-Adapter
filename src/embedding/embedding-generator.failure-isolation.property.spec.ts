// ---------------------------------------------------------------------------
// Per-model failure isolation in the embedding generator
// **Validates: Requirements 3.5**
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createMockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockActiveClusters, mockReadCluster } = vi.hoisted(() => ({
  mockActiveClusters: { value: [] as Array<{ clusterId: string; clusterArn: string; secretArn: string; databaseName: string; modelId: string; dimensions: number; active: boolean }> },
  mockReadCluster: { value: { clusterId: "cluster-a", modelId: "model-alpha" } as { clusterId: string; modelId: string } },
}));

vi.mock("./cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze(mockActiveClusters.value.map((c) => Object.freeze(c))),
  getActiveClusters: () => mockActiveClusters.value.filter((c) => c.active),
  getReadCluster: () => mockReadCluster.value,
  getClusterById: (id: string) => mockActiveClusters.value.find((c) => c.clusterId === id) ?? null,
}));

describe("Bedrock failure for one model preserves all other writes", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  const mockLogger = createMockLogger();

  const THREE_CLUSTERS = [
    { clusterId: "cluster-a", clusterArn: "arn:a", secretArn: "secret:a", databaseName: "signals", modelId: "model-alpha", dimensions: 1024, active: true },
    { clusterId: "cluster-b", clusterArn: "arn:b", secretArn: "secret:b", databaseName: "signals", modelId: "model-beta", dimensions: 1536, active: true },
    { clusterId: "cluster-c", clusterArn: "arn:c", secretArn: "secret:c", databaseName: "signals", modelId: "model-gamma", dimensions: 512, active: true },
  ];

  beforeEach(() => {
    bedrockMock.reset();
    mockLogger.calls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when first (primary) model fails, results contain err for that model and ok for others", async () => {
    mockActiveClusters.value = THREE_CLUSTERS;
    mockReadCluster.value = THREE_CLUSTERS[0]!;
    const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount === 1) throw new Error("Bedrock failed for testing");
      return { body: new TextEncoder().encode(JSON.stringify({ embedding: Array(10).fill(0.1) })) };
    });

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}), mockLogger);
    const results = await generator.generateForActiveClusters("test text");

    expect(results).toHaveLength(3);
    expect(results[0]!.isErr()).toBe(true);
    if (results[0]!.isErr()) {
      expect(results[0]!.error.modelId).toBe("model-alpha");
    }
    const successful = results.filter(r => r.isOk());
    expect(successful).toHaveLength(2);
    const successModelIds = successful.map(r => r.isOk() ? r.value.modelId : "");
    expect(successModelIds).toContain("model-beta");
    expect(successModelIds).toContain("model-gamma");

    // Primary cluster failure → ERROR
    expect(mockLogger.calls.filter(c => c.method === "error")).toHaveLength(1);
    expect(mockLogger.calls.find(c => c.method === "error")!.context).toEqual(
      expect.objectContaining({ code: "embedding.generation_failed", modelId: "model-alpha" }),
    );
  });

  it("when multiple non-primary models fail, results contain err for each", async () => {
    mockActiveClusters.value = THREE_CLUSTERS;
    mockReadCluster.value = THREE_CLUSTERS[2]!; // gamma is primary
    const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount <= 2) throw new Error("Bedrock failed");
      return { body: new TextEncoder().encode(JSON.stringify({ embedding: Array(10).fill(0.1) })) };
    });

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}), mockLogger);
    const results = await generator.generateForActiveClusters("test text");

    expect(results).toHaveLength(3);
    const successful = results.filter(r => r.isOk());
    expect(successful).toHaveLength(1);
    expect(successful[0]!.isOk() && successful[0]!.value.modelId).toBe("model-gamma");
    // Non-primary failures → WARN
    expect(mockLogger.calls.filter(c => c.method === "warn")).toHaveLength(2);
    expect(mockLogger.calls.filter(c => c.method === "error")).toHaveLength(0);
  });

  it("when all models fail including primary, results are all err", async () => {
    mockActiveClusters.value = THREE_CLUSTERS;
    mockReadCluster.value = THREE_CLUSTERS[0]!;
    const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

    bedrockMock.on(InvokeModelCommand).rejects(new Error("All broken"));

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}), mockLogger);
    const results = await generator.generateForActiveClusters("test text");

    expect(results).toHaveLength(3);
    expect(results.every(r => r.isErr())).toBe(true);
    // 1 ERROR (primary) + 2 WARN (non-primary)
    expect(mockLogger.calls.filter(c => c.method === "error")).toHaveLength(1);
    expect(mockLogger.calls.filter(c => c.method === "warn")).toHaveLength(2);
  });
});
