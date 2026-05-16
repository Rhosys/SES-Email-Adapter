// Feature: split-embedding-pipeline, Property 6: generateForSecondaryClusters result count
// **Validates: Requirements 3.2**
//
// For any embed text, `generateForSecondaryClusters` SHALL return exactly one
// Result per secondary cluster (i.e., `result.length === getSecondaryClusters().length`).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ClusterRegistryEntry } from "./cluster-registry.js";

// ---------------------------------------------------------------------------
// Hoisted mock state — allows dynamic secondary cluster count per test case
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
// Static test cases: distinct secondary cluster counts
// ---------------------------------------------------------------------------

const PRIMARY: ClusterRegistryEntry = {
  registryId: "primary-cluster",
  clusterArn: "arn:aws:rds:eu-west-1:111:cluster:primary",
  secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:primary",
  databaseName: "signals",
  modelId: "amazon.titan-embed-text-v2:0",
  dimensions: 1024,
  active: true,
  primary: true,
};

function makeSecondaries(count: number): ClusterRegistryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    registryId: `secondary-cluster-${i}`,
    clusterArn: `arn:aws:rds:eu-west-1:111:cluster:secondary-${i}`,
    secretArn: `arn:aws:secretsmanager:eu-west-1:111:secret:secondary-${i}`,
    databaseName: "signals",
    modelId: `model-secondary-${i}`,
    dimensions: 1024,
    active: true,
    primary: false,
  }));
}

const cases = [
  { scenario: "0 secondary clusters → returns empty array", secondaryCount: 0 },
  { scenario: "1 secondary cluster → returns array of length 1", secondaryCount: 1 },
  { scenario: "3 secondary clusters → returns array of length 3", secondaryCount: 3 },
  { scenario: "4 secondary clusters (max) → returns array of length 4", secondaryCount: 4 },
];

// ---------------------------------------------------------------------------
// Property 6: generateForSecondaryClusters result count
// ---------------------------------------------------------------------------

describe("Property 6: generateForSecondaryClusters result count", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);

  beforeEach(() => {
    bedrockMock.reset();
  });

  it.each(cases)("$scenario", async ({ secondaryCount }) => {
    const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

    const secondaries = makeSecondaries(secondaryCount);

    // Configure mocks for this test case
    mockRegistry.value = [PRIMARY, ...secondaries];
    mockSecondaryClusters.value = secondaries;

    bedrockMock.reset();
    bedrockMock.on(InvokeModelCommand).resolves({
      body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2] })) as never,
    });

    const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
    const results = await generator.generateForSecondaryClusters("test embedding text");

    // The property: result count === secondary cluster count
    expect(results).toHaveLength(secondaryCount);
  });
});
