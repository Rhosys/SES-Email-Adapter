// ---------------------------------------------------------------------------
// Property test for per-model failure isolation in the generator
// **Validates: Requirements 3.5**
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { propertyRunner } from "../testing/property-runner.js";

// ---------------------------------------------------------------------------
// Hoisted mock state — available before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockActiveClusters } = vi.hoisted(() => ({
  mockActiveClusters: { value: [] as Array<{ clusterId: string; clusterArn: string; secretArn: string; databaseName: string; modelId: string; dimensions: number; active: boolean }> },
}));

// ---------------------------------------------------------------------------
// Mock cluster registry using hoisted state
// ---------------------------------------------------------------------------

vi.mock("./cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze(mockActiveClusters.value.map((c) => Object.freeze(c))),
  getActiveClusters: () => mockActiveClusters.value.filter((c) => c.active),
  getClusterById: (id: string) => mockActiveClusters.value.find((c) => c.clusterId === id) ?? null,
}));

// ---------------------------------------------------------------------------
// Arbitraries for generating cluster registries
// ---------------------------------------------------------------------------

const arbString = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);
const arbDimension = fc.integer({ min: 512, max: 4096 });

const arbClusterRegistryEntry = fc
  .tuple(
    arbString,
    arbString,
    arbString,
    arbString,
    arbString,
    arbDimension,
  )
  .map(([clusterId, clusterArn, secretArn, databaseName, modelId, dimensions]) => ({
    clusterId,
    clusterArn,
    secretArn,
    databaseName,
    modelId,
    dimensions,
    active: true,
  }));

const arbClusterRegistry = fc
  .array(arbClusterRegistryEntry, { minLength: 2, maxLength: 4 })
  .filter((entries) => new Set(entries.map((e) => e.modelId)).size === entries.length);

// ---------------------------------------------------------------------------
// Property 7: Bedrock failure for one model preserves all other writes
// ---------------------------------------------------------------------------

/**
 * For any signal processed against a registry where Bedrock fails for one model after retries,
 * the DynamoDB Signal record is still persisted; its embeddings map contains entries only for
 * the succeeding models; the failure is reported via the embedding_generation_failed metric
 * tagged with the failing model ID; and the succeeding clusters' Aurora rows are unaffected.
 */
describe("Property 7: Bedrock failure for one model preserves all other writes (Property Test)", () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    bedrockMock.reset();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "for any registry with 2-4 active clusters, when one model fails, results contain only succeeding models and metric is emitted",
    async () => {
      // Dynamic import after mocks are set up
      const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

      await propertyRunner.assert(
        fc.asyncProperty(arbClusterRegistry, async (registryEntries) => {
          // Need at least 2 active clusters for this test
          if (registryEntries.length < 2) {
            return true;
          }

          // Update the hoisted mock state
          mockActiveClusters.value = registryEntries;

          // Reset mocks for each iteration
          bedrockMock.reset();
          stdoutSpy.mockClear();

          // Simulate failure for exactly one model (the first one)
          const failingModelId = registryEntries[0]!.modelId;
          const succeedingModels = registryEntries.slice(1).map((c) => c.modelId);

          // Create generator with mocked Bedrock
          const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));

          // Mock Bedrock to fail for the first model, succeed for others
          let callCount = 0;
          bedrockMock.on(InvokeModelCommand).callsFake(() => {
            callCount++;
            if (callCount === 1) {
              throw new Error("Bedrock failed for testing");
            }
            return {
              body: new TextEncoder().encode(
                JSON.stringify({ embedding: Array(10).fill(0.1) }),
              ),
            };
          });

          // Generate embeddings
          const results = await generator.generateForActiveClusters("test text");

          // Verify results contain only succeeding models
          expect(results).toHaveLength(succeedingModels.length);
          const resultModelIds = results.map((r) => r.modelId);
          succeedingModels.forEach((modelId) => {
            expect(resultModelIds).toContain(modelId);
          });
          expect(resultModelIds).not.toContain(failingModelId);

          // Verify metric was emitted for the failing model
          expect(stdoutSpy).toHaveBeenCalledTimes(1);
          const metricLog = JSON.parse(stdoutSpy.mock.calls[0]![0] as string);
          expect(metricLog.modelId).toBe(failingModelId);
          expect(metricLog.embedding_generation_failed).toBe(1);

          return true;
        }),
      );
    },
    30000,
  );

  it(
    "for any registry, when multiple models fail, results contain only successful models",
    async () => {
      const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

      await propertyRunner.assert(
        fc.asyncProperty(arbClusterRegistry, async (registryEntries) => {
          if (registryEntries.length < 2) {
            return true;
          }

          // Update the hoisted mock state
          mockActiveClusters.value = registryEntries;

          bedrockMock.reset();
          stdoutSpy.mockClear();

          const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));

          // Fail at least one but not all (fail the first half)
          const numFailing = Math.max(1, Math.floor(registryEntries.length / 2));
          const failingModels = new Set(
            registryEntries.slice(0, numFailing).map((c) => c.modelId),
          );
          const succeedingModels = registryEntries
            .slice(numFailing)
            .map((c) => c.modelId);

          let callCount = 0;
          bedrockMock.on(InvokeModelCommand).callsFake(() => {
            callCount++;
            if (callCount <= numFailing) {
              throw new Error("Bedrock failed");
            }
            return {
              body: new TextEncoder().encode(
                JSON.stringify({ embedding: Array(10).fill(0.1) }),
              ),
            };
          });

          const results = await generator.generateForActiveClusters("test text");

          expect(results).toHaveLength(succeedingModels.length);
          const resultModelIds = results.map((r) => r.modelId);
          succeedingModels.forEach((modelId) => {
            expect(resultModelIds).toContain(modelId);
          });
          failingModels.forEach((modelId) => {
            expect(resultModelIds).not.toContain(modelId);
          });

          // Verify metric count matches failing count
          expect(stdoutSpy).toHaveBeenCalledTimes(numFailing);

          return true;
        }),
      );
    },
    30000,
  );

  it(
    "for any registry, when all models fail, results is empty array and metrics are emitted for each",
    async () => {
      const { BedrockEmbeddingGenerator } = await import("./embedding-generator.js");

      await propertyRunner.assert(
        fc.asyncProperty(arbClusterRegistry, async (registryEntries) => {
          if (registryEntries.length === 0) {
            return true;
          }

          // Update the hoisted mock state
          mockActiveClusters.value = registryEntries;

          bedrockMock.reset();
          stdoutSpy.mockClear();

          const generator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));

          // All calls fail
          bedrockMock.on(InvokeModelCommand).rejects(new Error("All broken"));

          const results = await generator.generateForActiveClusters("test text");

          expect(results).toEqual([]);
          expect(stdoutSpy).toHaveBeenCalledTimes(registryEntries.length);

          // Verify each failed model emitted a metric
          const metricLogs = stdoutSpy.mock.calls.map(
            (call) => JSON.parse(call[0] as string),
          );
          const failedModelIds = metricLogs.map((m: { modelId: string }) => m.modelId);
          registryEntries.forEach((c) => {
            expect(failedModelIds).toContain(c.modelId);
          });

          return true;
        }),
      );
    },
    30000,
  );
});
