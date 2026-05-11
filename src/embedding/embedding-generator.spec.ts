import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEmbeddingGenerator } from "./embedding-generator.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry
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
    Object.freeze({
      clusterId: "cluster-c",
      clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-c",
      secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-c",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v1:0",
      dimensions: 512,
      active: false,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const bedrockMock = mockClient(BedrockRuntimeClient);

/** Encode JSON as a mock Bedrock response body (cast to satisfy Uint8ArrayBlobAdapter type). */
const mockBody = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)) as never;

describe("BedrockEmbeddingGenerator", () => {
  let generator: BedrockEmbeddingGenerator;
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    bedrockMock.reset();
    generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
      expect(results[0]).toEqual({
        modelId: "amazon.titan-embed-text-v2:0",
        vector: Array(1024).fill(0.01),
        dimensions: 1024,
      });
      expect(results[1]).toEqual({
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
      expect(results.every((r) => r.modelId !== "amazon.titan-embed-text-v1:0")).toBe(true);
    });

    it("returns null for failed models and filters them out", async () => {
      let callIndex = 0;
      bedrockMock.on(InvokeModelCommand).callsFake(() => {
        callIndex++;
        if (callIndex === 1) throw new Error("Bedrock throttled");
        return {
          body: mockBody({ embedding: [0.5, 0.6] }),
        };
      });

      const results = await generator.generateForActiveClusters("text");

      // Only the successful model is returned
      expect(results).toHaveLength(1);
      expect(results[0]!.modelId).toBe("amazon.titan-embed-text-v3:0");
    });

    it("emits embedding_generation_failed metric on failure", async () => {
      bedrockMock.on(InvokeModelCommand).rejects(new Error("Bedrock error"));

      await generator.generateForActiveClusters("text");

      // Should have emitted 2 metrics (one per failed active cluster)
      expect(stdoutSpy).toHaveBeenCalledTimes(2);
      const firstCall = stdoutSpy.mock.calls[0]![0] as string;
      const emfLog = JSON.parse(firstCall.trim());
      expect(emfLog._aws.CloudWatchMetrics[0].Metrics[0].Name).toBe("embedding_generation_failed");
      expect(emfLog.modelId).toBe("amazon.titan-embed-text-v2:0");
      expect(emfLog.embedding_generation_failed).toBe(1);
    });

    it("does not throw when all models fail", async () => {
      bedrockMock.on(InvokeModelCommand).rejects(new Error("All broken"));

      const results = await generator.generateForActiveClusters("text");
      expect(results).toEqual([]);
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
