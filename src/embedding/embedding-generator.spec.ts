import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEmbeddingGenerator } from "./embedding-generator.js";
import { createMockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry
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
    Object.freeze({
      clusterId: "cluster-c",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-c",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-c",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v1:0",
      dimensions: 512,
      active: false,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const bedrockMock = mockClient(BedrockRuntimeClient);

/** Encode JSON as a mock Bedrock response body (cast to satisfy Uint8ArrayBlobAdapter type). */
const mockBody = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)) as never;

describe("BedrockEmbeddingGenerator", () => {
  let generator: BedrockEmbeddingGenerator;
  const mockLogger = createMockLogger();

  beforeEach(() => {
    bedrockMock.reset();
    generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}), mockLogger);
    mockLogger.calls.length = 0;
  });

  describe("generateForActiveClusters", () => {
    it("generates embeddings for all active clusters in parallel", async () => {
      bedrockMock.on(InvokeModelCommand).callsFake((input) => {
        const body = JSON.parse(new TextDecoder().decode(input.body as Uint8Array));
        const dims = body.dimensions as number;
        return {
          body: mockBody({ embedding: Array(dims).fill(0.01) }),
        };
      });

      const results = await generator.generateForActiveClusters("test embed text");

      expect(results).toHaveLength(2);
      expect(results.every(r => r.isOk())).toBe(true);
      expect(results[0]!.isOk() && results[0]!.value).toEqual({
        modelId: "amazon.titan-embed-text-v2:0",
        vector: Array(1024).fill(0.01),
        dimensions: 1024,
      });
      expect(results[1]!.isOk() && results[1]!.value).toEqual({
        modelId: "amazon.titan-embed-text-v3:0",
        vector: Array(1536).fill(0.01),
        dimensions: 1536,
      });
    });

    it("calls Bedrock with normalize=true and correct dimensions", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1, 0.2] }),
      });

      await generator.generateForActiveClusters("hello");

      const calls = bedrockMock.commandCalls(InvokeModelCommand);
      expect(calls).toHaveLength(2);

      const body0 = JSON.parse(new TextDecoder().decode(calls[0]!.args[0].input.body as Uint8Array));
      expect(body0).toEqual({ inputText: "hello", dimensions: 1024, normalize: true });
      expect(calls[0]!.args[0].input.modelId).toBe("amazon.titan-embed-text-v2:0");

      const body1 = JSON.parse(new TextDecoder().decode(calls[1]!.args[0].input.body as Uint8Array));
      expect(body1).toEqual({ inputText: "hello", dimensions: 1536, normalize: true });
      expect(calls[1]!.args[0].input.modelId).toBe("amazon.titan-embed-text-v3:0");
    });

    it("does not include inactive clusters", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1] }),
      });

      const results = await generator.generateForActiveClusters("text");

      // Only 2 active clusters, not the inactive cluster-c
      expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(2);
      const modelIds = results.filter(r => r.isOk()).map(r => r.value.modelId);
      expect(modelIds).not.toContain("amazon.titan-embed-text-v1:0");
    });

    it("returns err for failed models and ok for successful ones", async () => {
      let callIndex = 0;
      bedrockMock.on(InvokeModelCommand).callsFake(() => {
        callIndex++;
        if (callIndex === 1) throw new Error("Bedrock throttled");
        return {
          body: mockBody({ embedding: [0.5, 0.6] }),
        };
      });

      const results = await generator.generateForActiveClusters("text");

      expect(results).toHaveLength(2);
      expect(results[0]!.isErr()).toBe(true);
      if (results[0]!.isErr()) {
        expect(results[0]!.error.modelId).toBe("amazon.titan-embed-text-v2:0");
      }
      expect(results[1]!.isOk()).toBe(true);
      if (results[1]!.isOk()) {
        expect(results[1]!.value.modelId).toBe("amazon.titan-embed-text-v3:0");
      }
    });

    it("logs ERROR for primary cluster failure, WARN for non-primary", async () => {
      bedrockMock.on(InvokeModelCommand).rejects(new Error("Bedrock error"));

      await generator.generateForActiveClusters("text");

      // cluster-a is primary → ERROR, cluster-b is non-primary → WARN
      expect(mockLogger.calls.filter(c => c.method === "error")).toHaveLength(1);
      expect(mockLogger.calls.find(c => c.method === "error")!.context).toEqual(
        expect.objectContaining({ code: "embedding.generation_failed", modelId: "amazon.titan-embed-text-v2:0" }),
      );
      expect(mockLogger.calls.filter(c => c.method === "warn")).toHaveLength(1);
      expect(mockLogger.calls.find(c => c.method === "warn")!.context).toEqual(
        expect.objectContaining({ code: "embedding.generation_failed", modelId: "amazon.titan-embed-text-v3:0" }),
      );
    });

    it("does not throw when all models fail", async () => {
      bedrockMock.on(InvokeModelCommand).rejects(new Error("All broken"));

      const results = await generator.generateForActiveClusters("text");
      expect(results).toHaveLength(2);
      expect(results.every(r => r.isErr())).toBe(true);
    });

    it("truncates input text to 8000 characters", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1] }),
      });

      const longText = "x".repeat(10000);
      await generator.generateForActiveClusters(longText);

      const calls = bedrockMock.commandCalls(InvokeModelCommand);
      const body = JSON.parse(new TextDecoder().decode(calls[0]!.args[0].input.body as Uint8Array));
      expect(body.inputText.length).toBe(8000);
    });
  });

  describe("generateForModel", () => {
    it("generates an embedding for a specific model by ID", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1, 0.2, 0.3] }),
      });

      const result = await generator.generateForModel("embed text", "amazon.titan-embed-text-v2:0");

      expect(result).toEqual({
        modelId: "amazon.titan-embed-text-v2:0",
        vector: [0.1, 0.2, 0.3],
        dimensions: 1024,
      });
    });

    it("resolves dimensions from CLUSTER_REGISTRY by modelId", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1] }),
      });

      await generator.generateForModel("text", "amazon.titan-embed-text-v3:0");

      const calls = bedrockMock.commandCalls(InvokeModelCommand);
      const body = JSON.parse(new TextDecoder().decode(calls[0]!.args[0].input.body as Uint8Array));
      expect(body.dimensions).toBe(1536);
      expect(calls[0]!.args[0].input.modelId).toBe("amazon.titan-embed-text-v3:0");
    });

    it("calls Bedrock with normalize=true", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1] }),
      });

      await generator.generateForModel("text", "amazon.titan-embed-text-v2:0");

      const calls = bedrockMock.commandCalls(InvokeModelCommand);
      const body = JSON.parse(new TextDecoder().decode(calls[0]!.args[0].input.body as Uint8Array));
      expect(body.normalize).toBe(true);
    });

    it("throws when modelId is not found in the registry", async () => {
      await expect(
        generator.generateForModel("text", "nonexistent-model"),
      ).rejects.toThrow('Model ID "nonexistent-model" not found in CLUSTER_REGISTRY');
    });

    it("throws when Bedrock call fails (does not swallow errors)", async () => {
      bedrockMock.on(InvokeModelCommand).rejects(new Error("Bedrock unavailable"));

      await expect(
        generator.generateForModel("text", "amazon.titan-embed-text-v2:0"),
      ).rejects.toThrow('Embedding generation failed for model "amazon.titan-embed-text-v2:0"');
    });

    it("can resolve inactive model IDs from the registry", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1] }),
      });

      // cluster-c is inactive but its model should still be resolvable
      const result = await generator.generateForModel("text", "amazon.titan-embed-text-v1:0");
      expect(result.dimensions).toBe(512);
    });
  });
});
