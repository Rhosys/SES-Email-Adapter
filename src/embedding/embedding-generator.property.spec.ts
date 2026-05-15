import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEmbeddingGenerator } from "./embedding-generator.js";

vi.mock("./cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze([
    Object.freeze({ clusterId: "cluster-a", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a", databaseName: "signals", modelId: "amazon.titan-embed-text-v2:0", dimensions: 1024, active: true }),
    Object.freeze({ clusterId: "cluster-b", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-b", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-b", databaseName: "signals", modelId: "amazon.titan-embed-text-v3:0", dimensions: 1536, active: true }),
    Object.freeze({ clusterId: "cluster-c", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-c", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-c", databaseName: "signals", modelId: "amazon.titan-embed-text-v1:0", dimensions: 512, active: false }),
  ]),
  getActiveClusters: () => [
    { clusterId: "cluster-a", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a", databaseName: "signals", modelId: "amazon.titan-embed-text-v2:0", dimensions: 1024, active: true },
    { clusterId: "cluster-b", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-b", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-b", databaseName: "signals", modelId: "amazon.titan-embed-text-v3:0", dimensions: 1536, active: true },
  ],
  getReadCluster: () => ({ clusterId: "cluster-a", clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-a", secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-a", databaseName: "signals", modelId: "amazon.titan-embed-text-v2:0", dimensions: 1024, active: true }),
  getSecondaryClusters: () => [
    { clusterId: "cluster-b", clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-b", secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-b", databaseName: "signals", modelId: "amazon.titan-embed-text-v3:0", dimensions: 1536, active: true },
  ],
}));

describe("Active cluster set drives embedding generation", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  const mockBody = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)) as never;
  let generator: BedrockEmbeddingGenerator;

  beforeEach(() => {
    bedrockMock.reset();
    generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
  });

  it("generateForModel returns ok with correct modelId and dimensions", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: mockBody({ embedding: [0.1, 0.2, 0.3] }) });

    const result = await generator.generateForModel("test embed text", "amazon.titan-embed-text-v2:0");

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.modelId).toBe("amazon.titan-embed-text-v2:0");
      expect(result.value.dimensions).toBe(1024);
      expect(result.value.vector).toEqual([0.1, 0.2, 0.3]);
    }
  });

  it("generateForSecondaryClusters generates one embedding per secondary cluster", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: mockBody({ embedding: [0.1, 0.2, 0.3] }) });

    const results = await generator.generateForSecondaryClusters("test embed text");

    expect(results).toHaveLength(1);
    expect(results[0]!.isOk()).toBe(true);
    if (results[0]!.isOk()) {
      expect(results[0]!.value.modelId).toBe("amazon.titan-embed-text-v3:0");
      expect(results[0]!.value.dimensions).toBe(1536);
    }
  });

  it("does not call Bedrock for inactive clusters", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: mockBody({ embedding: [0.1] }) });

    await generator.generateForModel("test text", "amazon.titan-embed-text-v2:0");
    await generator.generateForSecondaryClusters("test text");

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(calls).toHaveLength(2);
    const modelIdsUsed = calls.map((c) => c.args[0].input.modelId);
    expect(modelIdsUsed).not.toContain("amazon.titan-embed-text-v1:0");
  });

  it("calls Bedrock with normalize=true for all active clusters", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: mockBody({ embedding: [0.1] }) });

    await generator.generateForModel("test", "amazon.titan-embed-text-v2:0");
    await generator.generateForSecondaryClusters("test");

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    calls.forEach((call) => {
      const body = JSON.parse(new TextDecoder().decode(call.args[0].input.body as Uint8Array));
      expect(body).toEqual(expect.objectContaining({ normalize: true }));
    });
  });

  it("calls Bedrock with the correct dimensions per model", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: mockBody({ embedding: [0.1] }) });

    await generator.generateForModel("test", "amazon.titan-embed-text-v2:0");
    await generator.generateForSecondaryClusters("test");

    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    const call0Body = JSON.parse(new TextDecoder().decode(calls[0]!.args[0].input.body as Uint8Array));
    const call1Body = JSON.parse(new TextDecoder().decode(calls[1]!.args[0].input.body as Uint8Array));
    expect([call0Body.dimensions, call1Body.dimensions]).toEqual(expect.arrayContaining([1024, 1536]));
  });

  it("produces deterministic results for the same input", async () => {
    bedrockMock.on(InvokeModelCommand).resolves({ body: mockBody({ embedding: [0.5, 0.6] }) });

    const results1 = await generator.generateForModel("same text", "amazon.titan-embed-text-v2:0");
    const results2 = await generator.generateForModel("same text", "amazon.titan-embed-text-v2:0");
    expect(results1).toEqual(results2);
  });
});
