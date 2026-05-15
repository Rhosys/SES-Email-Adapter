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
    clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-a",
    secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-a",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  }),
  getSecondaryClusters: () => [
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
    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v2:0" })
      .rejects(new Error("Bedrock throttled for titan-v2"));
    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v3:0" })
      .resolves({ body: mockBody({ embedding: [0.5, 0.6, 0.7] }) });

    const primaryResult = await generator.generateForModel("test text", "amazon.titan-embed-text-v2:0");
    const secondaryResults = await generator.generateForSecondaryClusters("test text");

    expect(primaryResult.isErr()).toBe(true);
    if (primaryResult.isErr()) {
      expect(primaryResult.error.modelId).toBe("amazon.titan-embed-text-v2:0");
    }
    expect(secondaryResults).toHaveLength(1);
    expect(secondaryResults[0]!.isOk()).toBe(true);
    if (secondaryResults[0]!.isOk()) {
      expect(secondaryResults[0]!.value.modelId).toBe("amazon.titan-embed-text-v3:0");
      expect(secondaryResults[0]!.value.dimensions).toBe(1536);
    }
  });

  it("generateForModel returns err without throwing on Bedrock failure", async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error("Bedrock unavailable"));

    const result = await generator.generateForModel("test", "amazon.titan-embed-text-v2:0");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.modelId).toBe("amazon.titan-embed-text-v2:0");
    }
  });

  it("does not throw when all models succeed", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: mockBody({ embedding: [0.1] }) });

    const primaryResult = await generator.generateForModel("test", "amazon.titan-embed-text-v2:0");
    const secondaryResults = await generator.generateForSecondaryClusters("test");

    expect(primaryResult.isOk()).toBe(true);
    expect(secondaryResults.every(r => r.isOk())).toBe(true);
  });

  it("secondary cluster failure does not affect primary result", async () => {
    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v2:0" })
      .resolves({ body: mockBody({ embedding: [0.2] }) });
    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v3:0" })
      .rejects(new Error("Bedrock error"));

    const primaryResult = await generator.generateForModel("test", "amazon.titan-embed-text-v2:0");
    const secondaryResults = await generator.generateForSecondaryClusters("test");

    expect(primaryResult.isOk()).toBe(true);
    expect(secondaryResults).toHaveLength(1);
    expect(secondaryResults[0]!.isErr()).toBe(true);
  });

  it("does not throw when all models fail", async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error("All broken"));

    const primaryResult = await generator.generateForModel("test", "amazon.titan-embed-text-v2:0");
    const secondaryResults = await generator.generateForSecondaryClusters("test");

    expect(primaryResult.isErr()).toBe(true);
    expect(secondaryResults).toHaveLength(1);
    expect(secondaryResults[0]!.isErr()).toBe(true);
  });

  it("produces deterministic results when same model fails consistently", async () => {
    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v2:0" })
      .rejects(new Error("Bedrock throttled"));
    bedrockMock.on(InvokeModelCommand, { modelId: "amazon.titan-embed-text-v3:0" })
      .resolves({ body: mockBody({ embedding: [0.5, 0.6] }) });

    const result1 = await generator.generateForModel("same text", "amazon.titan-embed-text-v2:0");
    const result2 = await generator.generateForModel("same text", "amazon.titan-embed-text-v2:0");

    expect(result1.isErr()).toBe(true);
    expect(result2.isErr()).toBe(true);

    const secondary1 = await generator.generateForSecondaryClusters("same text");
    const secondary2 = await generator.generateForSecondaryClusters("same text");

    expect(secondary1[0]!.isOk()).toBe(true);
    expect(secondary2[0]!.isOk()).toBe(true);
    if (secondary1[0]!.isOk() && secondary2[0]!.isOk()) {
      expect(secondary1[0]!.value.vector).toEqual(secondary2[0]!.value.vector);
    }
  });
});
