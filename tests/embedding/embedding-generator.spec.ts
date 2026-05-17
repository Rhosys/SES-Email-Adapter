import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry
// ---------------------------------------------------------------------------

vi.mock("../../src/embedding/cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze([
    Object.freeze({
      registryId: "cluster-a",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    }),
    Object.freeze({
      registryId: "cluster-b",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-b",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-b",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v3:0",
      dimensions: 1536,
      active: true,
    }),
    Object.freeze({
      registryId: "cluster-c",
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
      registryId: "cluster-a",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    },
    {
      registryId: "cluster-b",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-b",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-b",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v3:0",
      dimensions: 1536,
      active: true,
    },
  ],
  getPrimaryArcMatcherRegistry: () => ({
    registryId: "cluster-a",
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

  describe("generateForModel", () => {
    it("returns Ok with embedding for a valid model ID", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1, 0.2, 0.3] }),
      });

      const result = await generator.generateForModel("embed text", "amazon.titan-embed-text-v2:0");

      expect(result.isOk()).toBe(true);
      expect(result.isOk() && result.value).toEqual({
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

    it("returns Err(BedrockError) when modelId is not found in the registry", async () => {
      const result = await generator.generateForModel("text", "nonexistent-model");

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe("bedrock_error");
        expect(result.error.modelId).toBe("nonexistent-model");
        expect((result.error.cause as Error).message).toContain("not found in CLUSTER_REGISTRY");
      }
    });

    it("returns Err(BedrockError) when Bedrock call fails", async () => {
      bedrockMock.on(InvokeModelCommand).rejects(new Error("Bedrock unavailable"));

      const result = await generator.generateForModel("text", "amazon.titan-embed-text-v2:0");

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe("bedrock_error");
        expect(result.error.modelId).toBe("amazon.titan-embed-text-v2:0");
        expect((result.error.cause as Error).message).toBe("Bedrock unavailable");
      }
    });

    it("can resolve inactive model IDs from the registry", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1] }),
      });

      // cluster-c is inactive but its model should still be resolvable
      const result = await generator.generateForModel("text", "amazon.titan-embed-text-v1:0");
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.dimensions).toBe(512);
      }
    });

    it("truncates input text to 8000 characters", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: mockBody({ embedding: [0.1] }),
      });

      const longText = "x".repeat(10000);
      await generator.generateForModel(longText, "amazon.titan-embed-text-v2:0");

      const calls = bedrockMock.commandCalls(InvokeModelCommand);
      const body = JSON.parse(new TextDecoder().decode(calls[0]!.args[0].input.body as Uint8Array));
      expect(body.inputText.length).toBe(8000);
    });
  });
});
