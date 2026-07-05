// ---------------------------------------------------------------------------
// Per-model failure isolation in the embedding generator
// **Validates: Requirements 3.1, 3.2**
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockActiveClusters, mockReadCluster, mockSecondaryClusters } = vi.hoisted(() => ({
  mockActiveClusters: { value: [] as Array<{ registryId: string; clusterArn: string; secretArn: string; databaseName: string; modelId: string; dimensions: number; active: boolean }> },
  mockReadCluster: { value: { registryId: "cluster-a", clusterArn: "arn:a", secretArn: "secret:a", databaseName: "signals", modelId: "model-alpha", dimensions: 1024, active: true } as { registryId: string; clusterArn: string; secretArn: string; databaseName: string; modelId: string; dimensions: number; active: boolean } },
  mockSecondaryClusters: { value: [] as Array<{ registryId: string; clusterArn: string; secretArn: string; databaseName: string; modelId: string; dimensions: number; active: boolean }> },
}));

vi.mock("../../src/embedding/cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze(mockActiveClusters.value.map((c) => Object.freeze(c))),
  getActiveClusters: () => mockActiveClusters.value.filter((c) => c.active),
  getPrimaryThreadMatcherRegistry: () => mockReadCluster.value,
  getSecondaryClusters: () => mockSecondaryClusters.value,
  getRegistryById: (id: string) => mockActiveClusters.value.find((c) => c.registryId === id) ?? null,
}));

describe("Bedrock failure for one model preserves all other writes", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  const mockLogger = createMockLogger();

  const THREE_CLUSTERS = [
    { registryId: "cluster-a", clusterArn: "arn:a", secretArn: "secret:a", databaseName: "signals", modelId: "model-alpha", dimensions: 1024, active: true },
    { registryId: "cluster-b", clusterArn: "arn:b", secretArn: "secret:b", databaseName: "signals", modelId: "model-beta", dimensions: 1536, active: true },
    { registryId: "cluster-c", clusterArn: "arn:c", secretArn: "secret:c", databaseName: "signals", modelId: "model-gamma", dimensions: 512, active: true },
  ];

  beforeEach(() => {
    bedrockMock.reset();
    mockLogger.calls.length = 0;
    mockActiveClusters.value = THREE_CLUSTERS;
    mockReadCluster.value = THREE_CLUSTERS[0]!;
    mockSecondaryClusters.value = [THREE_CLUSTERS[1]!, THREE_CLUSTERS[2]!];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when primary model fails, generateForModel returns err without throwing", async () => {
    const { BedrockEmbeddingGenerator } = await import("../../src/embedding/embedding-generator.js");

    bedrockMock.on(InvokeModelCommand).rejects(new Error("Bedrock failed for testing"));

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}), mockLogger);
    const result = await generator.generateForModel("test text", "model-alpha");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.modelId).toBe("model-alpha");
    }
  });

  it("when secondary models fail, generateForSecondaryClusters returns err for each without throwing", async () => {
    const { BedrockEmbeddingGenerator } = await import("../../src/embedding/embedding-generator.js");

    bedrockMock.on(InvokeModelCommand).rejects(new Error("Bedrock failed"));

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}), mockLogger);
    const results = await generator.generateForSecondaryClusters("test text");

    expect(results).toHaveLength(2);
    expect(results.every(r => r.isErr())).toBe(true);
    const errorModelIds = results.filter(r => r.isErr()).map(r => r.error.modelId);
    expect(errorModelIds).toContain("model-beta");
    expect(errorModelIds).toContain("model-gamma");
  });

  it("when one secondary model fails, other secondary models still succeed", async () => {
    const { BedrockEmbeddingGenerator } = await import("../../src/embedding/embedding-generator.js");

    bedrockMock.on(InvokeModelCommand, { modelId: "model-beta" })
      .rejects(new Error("Bedrock failed"));
    bedrockMock.on(InvokeModelCommand, { modelId: "model-gamma" })
      .resolves({ body: new TextEncoder().encode(JSON.stringify({ embedding: Array(10).fill(0.1) })) as never });

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}), mockLogger);
    const results = await generator.generateForSecondaryClusters("test text");

    expect(results).toHaveLength(2);
    const successful = results.filter(r => r.isOk());
    const failed = results.filter(r => r.isErr());
    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(successful[0]!.isOk() && successful[0]!.value.modelId).toBe("model-gamma");
    expect(failed[0]!.isErr() && failed[0]!.error.modelId).toBe("model-beta");
  });
});
