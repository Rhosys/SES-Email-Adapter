// Feature: split-embedding-pipeline, Property 5: generateForModel never throws
// **Validates: Requirements 3.1**
//
// For any embed text and model ID (including invalid/missing model IDs),
// `generateForModel` SHALL return a Result and never throw an exception.

import { describe, it, expect, beforeEach, vi } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEmbeddingGenerator } from "./embedding-generator.js";

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
  ],
  getReadCluster: () => ({
    clusterId: "cluster-a",
    modelId: "amazon.titan-embed-text-v2:0",
  }),
}));

// ---------------------------------------------------------------------------
// Property 5: generateForModel never throws
// ---------------------------------------------------------------------------

describe("Property 5: generateForModel never throws", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  let generator: BedrockEmbeddingGenerator;

  beforeEach(() => {
    bedrockMock.reset();
    generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
  });

  it("always returns a Result and never throws for any embedText and modelId", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (embedText, modelId) => {
        // Randomly configure the mock to either succeed or throw
        const shouldFail = modelId.length % 2 === 0;
        bedrockMock.reset();
        if (shouldFail) {
          bedrockMock.on(InvokeModelCommand).rejects(new Error("Simulated Bedrock failure"));
        } else {
          bedrockMock.on(InvokeModelCommand).resolves({
            body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2] })) as never,
          });
        }

        // The property: calling generateForModel must NEVER throw — it must always return a Result
        const result = await generator.generateForModel(embedText, modelId);

        // Result must be either Ok or Err — never undefined/null
        expect(result.isOk() || result.isErr()).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
