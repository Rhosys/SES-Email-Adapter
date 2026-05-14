import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEmbeddingGenerator } from "./embedding-generator.js";
import { createMockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with two active clusters
// ---------------------------------------------------------------------------

vi.mock("./cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze([
    Object.freeze({
      clusterId: "cluster-a",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    }),
    Object.freeze({
      clusterId: "cluster-b",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-b",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-b",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v3:0",
      dimensions: 1536,
      active: true,
    }),
  ]),
  getActiveClusters: () => [
    {
      clusterId: "cluster-a",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    },
    {
      clusterId: "cluster-b",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-b",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-b",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v3:0",
      dimensions: 1536,
      active: true,
    },
  ],
  getReadCluster: () => ({
    clusterId: "cluster-a",
    modelId: "amazon.titan-embed-text-v2:0",
  }),
}));

describe("Property 7: Bedrock failure for one model preserves all other writes", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  const mockBody = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)) as never;
  let generator: BedrockEmbeddingGenerator;
  const mockLogger = createMockLogger();

  beforeEach(() => {
    bedrockMock.reset();
    generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}), mockLogger);
    mockLogger.calls.length = 0;
  });

  it("returns err for the failed model and ok for the successful model", async () => {
    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Bedrock throttled for titan-v2");
      }
      return { body: mockBody({ embedding: [0.5, 0.6, 0.7] }) };
    });

    const results = await generator.generateForActiveClusters("test text");

    expect(results).toHaveLength(2);
    expect(results[0]!.isErr()).toBe(true);
    if (results[0]!.isErr()) {
      expect(results[0]!.error.modelId).toBe("amazon.titan-embed-text-v2:0");
    }
    expect(results[1]!.isOk()).toBe(true);
    if (results[1]!.isOk()) {
      expect(results[1]!.value.modelId).toBe("amazon.titan-embed-text-v3:0");
      expect(results[1]!.value.dimensions).toBe(1536);
    }
  });

  it("logs ERROR for primary cluster failure", async () => {
    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount === 1) throw new Error("Bedrock unavailable");
      return { body: mockBody({ embedding: [0.1] }) };
    });

    await generator.generateForActiveClusters("test");

    // cluster-a is primary → ERROR
    expect(mockLogger.calls.filter(c => c.method === "error")).toHaveLength(1);
    expect(mockLogger.calls.find(c => c.method === "error")!.context).toEqual(
      expect.objectContaining({ code: "embedding.generation_failed", modelId: "amazon.titan-embed-text-v2:0" }),
    );
  });

  it("does not log when all models succeed", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: mockBody({ embedding: [0.1] }) });

    await generator.generateForActiveClusters("test");

    expect(mockLogger.calls.filter(c => c.method === "warn" || c.method === "error")).toHaveLength(0);
  });

  it("continues processing remaining models after one failure", async () => {
    let callCount = 0;
    bedrockMock.on(InvokeModelCommand).callsFake(() => {
      callCount++;
      if (callCount === 1) throw new Error("Bedrock error");
      return { body: mockBody({ embedding: [0.2] }) };
    });

    const results = await generator.generateForActiveClusters("test");

    expect(results).toHaveLength(2);
    const successful = results.filter(r => r.isOk());
    expect(successful).toHaveLength(1);
  });

  it("does not throw when all models fail", async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error("All broken"));

    const results = await generator.generateForActiveClusters("test");

    expect(results).toHaveLength(2);
    expect(results.every(r => r.isErr())).toBe(true);
  });

  it("produces deterministic results when same model fails consistently", async () => {
    bedrockMock.reset();

    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v2:0" })
      .rejects(new Error("Bedrock throttled"));
    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v3:0" })
      .resolves({ body: mockBody({ embedding: [0.5, 0.6] }) });

    const results1 = await generator.generateForActiveClusters("same text");
    mockLogger.calls.length = 0;
    const results2 = await generator.generateForActiveClusters("same text");

    expect(results1[0]!.isErr()).toBe(true);
    expect(results2[0]!.isErr()).toBe(true);
    expect(results1[1]!.isOk()).toBe(true);
    expect(results2[1]!.isOk()).toBe(true);
    if (results1[1]!.isOk() && results2[1]!.isOk()) {
      expect(results1[1]!.value.vector).toEqual(results2[1]!.value.vector);
    }
  });
});
