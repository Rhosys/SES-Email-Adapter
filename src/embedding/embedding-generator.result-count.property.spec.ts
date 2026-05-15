// Feature: split-embedding-pipeline, Property 6: generateForSecondaryClusters result count
// **Validates: Requirements 3.2**
//
// For any embed text, `generateForSecondaryClusters` SHALL return exactly one
// Result per secondary cluster (i.e., `result.length === getSecondaryClusters().length`).

import { describe, it, expect, beforeEach, vi } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ClusterRegistryEntry } from "./cluster-registry.js";

// ---------------------------------------------------------------------------
// Hoisted mock state — allows dynamic secondary cluster count per iteration
// ---------------------------------------------------------------------------

const { mockSecondaryClusters, mockRegistry } = vi.hoisted(() => ({
  mockSecondaryClusters: { value: [] as ClusterRegistryEntry[] },
  mockRegistry: { value: [] as ClusterRegistryEntry[] },
}));

vi.mock("./cluster-registry.js", () => ({
  CLUSTER_REGISTRY: mockRegistry.value,
  getActiveClusters: () => mockRegistry.value.filter((c) => c.active),
  getPrimaryArcMatcherRegistry: () => mockRegistry.value.find((c) => c.active)!,
  getSecondaryClusters: () => mockSecondaryClusters.value,
}));

// ---------------------------------------------------------------------------
// Property 6: generateForSecondaryClusters result count
// ---------------------------------------------------------------------------

describe("Property 6: generateForSecondaryClusters result count", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);

  beforeEach(() => {
    bedrockMock.reset();
  });

  it("returns exactly one Result per secondary cluster for any embedText", async () => {
    const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.integer({ min: 0, max: 4 }),
        async (embedText, secondaryCount) => {
          // Build a primary cluster + N secondary clusters
          const primary: ClusterRegistryEntry = {
            registryId: "primary-cluster",
            clusterArn: "arn:aws:rds:eu-west-1:111:cluster:primary",
            secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:primary",
            databaseName: "signals",
            modelId: "amazon.titan-embed-text-v2:0",
            dimensions: 1024,
            active: true,
            primary: true,
          };

          const secondaries: ClusterRegistryEntry[] = Array.from({ length: secondaryCount }, (_, i) => ({
            registryId: `secondary-cluster-${i}`,
            clusterArn: `arn:aws:rds:eu-west-1:111:cluster:secondary-${i}`,
            secretArn: `arn:aws:secretsmanager:eu-west-1:111:secret:secondary-${i}`,
            databaseName: "signals",
            modelId: `model-secondary-${i}`,
            dimensions: 1024,
            active: true,
            primary: false,
          }));

          // Configure mocks for this iteration
          mockRegistry.value = [primary, ...secondaries];
          mockSecondaryClusters.value = secondaries;

          bedrockMock.reset();
          bedrockMock.on(InvokeModelCommand).resolves({
            body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2] })) as never,
          });

          const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
          const results = await generator.generateForSecondaryClusters(embedText);

          // The property: result count === secondary cluster count
          expect(results).toHaveLength(secondaryCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});
