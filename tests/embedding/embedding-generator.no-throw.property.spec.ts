// Feature: split-embedding-pipeline, Property 5: generateForModel never throws
// **Validates: Requirements 3.1**
//
// For any embed text and model ID (including invalid/missing model IDs),
// `generateForModel` SHALL return a Result and never throw an exception.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { BedrockEmbeddingGenerator } from "../../src/embedding/embedding-generator.js";

vi.mock("../../src/embedding/cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze([
    Object.freeze({
      registryId: "cluster-a",
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
      registryId: "cluster-a",
      clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-a",
      secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-a",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    },
  ],
  getPrimaryArcMatcherRegistry: () => ({
    registryId: "cluster-a",
    modelId: "amazon.titan-embed-text-v2:0",
  }),
}));

// ---------------------------------------------------------------------------
// Static test cases: distinct code paths through generateForModel
// ---------------------------------------------------------------------------

const cases = [
  {
    scenario: "empty embedText + valid model → Bedrock succeeds → Ok",
    embedText: "",
    modelId: "amazon.titan-embed-text-v2:0",
    bedrockBehavior: "succeed" as const,
  },
  {
    scenario: "normal text + invalid model → Bedrock throws → Err",
    embedText: "Hello world, this is a normal email body.",
    modelId: "invalid.nonexistent-model:99",
    bedrockBehavior: "throw" as const,
  },
  {
    scenario: "very long text + valid model → Bedrock succeeds → Ok",
    embedText: "A".repeat(10_000),
    modelId: "amazon.titan-embed-text-v2:0",
    bedrockBehavior: "succeed" as const,
  },
  {
    scenario: "normal text + empty model ID → Bedrock throws → Err",
    embedText: "Some email content to embed.",
    modelId: "",
    bedrockBehavior: "throw" as const,
  },
];

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

  it.each(cases)("$scenario", async ({ embedText, modelId, bedrockBehavior }) => {
    bedrockMock.reset();
    if (bedrockBehavior === "throw") {
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

    // Verify the correct branch was taken
    if (bedrockBehavior === "succeed") {
      expect(result.isOk()).toBe(true);
    } else {
      expect(result.isErr()).toBe(true);
    }
  });
});
