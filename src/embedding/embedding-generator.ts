// ---------------------------------------------------------------------------
// Embedding Generator
// Wraps Bedrock per active cluster. Replaces SignalClassifier.embed().
// ---------------------------------------------------------------------------

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { getActiveClusters, CLUSTER_REGISTRY, type ClusterRegistryEntry } from "./cluster-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
  modelId: string;
  vector: number[];
  dimensions: number;
}

export interface EmbeddingGenerator {
  generateForActiveClusters(embedText: string): Promise<EmbeddingResult[]>;
  generateForModel(embedText: string, modelId: string): Promise<EmbeddingResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class BedrockEmbeddingGenerator implements EmbeddingGenerator {
  constructor(private readonly bedrock: BedrockRuntimeClient) {}

  /**
   * Generates embeddings for all active clusters in parallel.
   * Per-model failures return null (filtered out of results), do not throw.
   * Emits `embedding_generation_failed` metric tagged with modelId on failure.
   */
  async generateForActiveClusters(embedText: string): Promise<EmbeddingResult[]> {
    const activeClusters = getActiveClusters();

    const results = await Promise.all(
      activeClusters.map((entry) => this.invokeForEntry(embedText, entry)),
    );

    // Filter out nulls (failed models)
    return results.filter((r): r is EmbeddingResult => r !== null);
  }

  /**
   * Generates an embedding for a specific model by ID.
   * Resolves dimensions from CLUSTER_REGISTRY by modelId.
   * Throws if the modelId is not found in the registry.
   */
  async generateForModel(embedText: string, modelId: string): Promise<EmbeddingResult> {
    const entry = CLUSTER_REGISTRY.find((c) => c.modelId === modelId);
    if (!entry) {
      throw new Error(`Model ID "${modelId}" not found in CLUSTER_REGISTRY`);
    }

    const result = await this.invokeForEntry(embedText, entry);
    if (!result) {
      throw new Error(`Embedding generation failed for model "${modelId}"`);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async invokeForEntry(embedText: string, entry: ClusterRegistryEntry): Promise<EmbeddingResult | null> {
    try {
      const requestBody = {
        inputText: embedText.slice(0, 8000),
        dimensions: entry.dimensions,
        normalize: true,
      };

      const response = await this.bedrock.send(
        new InvokeModelCommand({
          modelId: entry.modelId,
          contentType: "application/json",
          accept: "application/json",
          body: new TextEncoder().encode(JSON.stringify(requestBody)),
        }),
      );

      const result = JSON.parse(new TextDecoder().decode(response.body)) as { embedding: number[] };
      return {
        modelId: entry.modelId,
        vector: result.embedding,
        dimensions: entry.dimensions,
      };
    } catch (error) {
      emitEmbeddingGenerationFailedMetric(entry.modelId);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Metrics (CloudWatch Embedded Metric Format)
// ---------------------------------------------------------------------------

function emitEmbeddingGenerationFailedMetric(modelId: string): void {
  // CloudWatch EMF — structured JSON to stdout is picked up by Lambda as a metric
  const emfLog = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: "EmailCatcher/Embeddings",
          Dimensions: [["modelId"]],
          Metrics: [{ Name: "embedding_generation_failed", Unit: "Count" }],
        },
      ],
    },
    modelId,
    embedding_generation_failed: 1,
  };
  process.stdout.write(JSON.stringify(emfLog) + "\n");
}
