// ---------------------------------------------------------------------------
// Embedding Generator
// Wraps Bedrock per active cluster. Replaces SignalClassifier.embed().
// ---------------------------------------------------------------------------

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import { bedrockError } from "../errors.js";
import type { BedrockError } from "../errors.js";
import { getActiveClusters, getReadCluster, CLUSTER_REGISTRY, type ClusterRegistryEntry } from "./cluster-registry.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
  modelId: string;
  vector: number[];
  dimensions: number;
}

export interface EmbeddingGenerator {
  generateForActiveClusters(embedText: string): Promise<Result<EmbeddingResult, BedrockError>[]>;
  generateForModel(embedText: string, modelId: string): Promise<EmbeddingResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class BedrockEmbeddingGenerator implements EmbeddingGenerator {
  constructor(
    private readonly bedrock: BedrockRuntimeClient,
    private readonly logger?: Logger,
  ) {}

  /**
   * Generates embeddings for all active clusters in parallel.
   * Returns one Result per cluster — ok with the embedding, or err with BedrockError.
   * Logs ERROR for primary cluster failures, WARN for non-primary.
   */
  async generateForActiveClusters(embedText: string): Promise<Result<EmbeddingResult, BedrockError>[]> {
    const activeClusters = getActiveClusters();
    const primaryCluster = getReadCluster();

    const results = await Promise.all(
      activeClusters.map((entry) => this.invokeForEntry(embedText, entry)),
    );

    // Log failures with primary/non-primary distinction
    for (const result of results) {
      if (result.isErr()) {
        const isPrimary = result.error.modelId === primaryCluster.modelId;
        const message = "Bedrock embedding generation failed. The InvokeModel call returned an error. This signal will proceed without an embedding for this cluster — arc matching may be degraded.";
        const context = { code: "embedding.generation_failed", modelId: result.error.modelId, error: result.error.cause };
        if (isPrimary) {
          this.logger?.error(message, context);
        } else {
          this.logger?.warn(message, context);
        }
      }
    }

    return results;
  }

  /**
   * Generates an embedding for a specific model by ID.
   * Resolves dimensions from CLUSTER_REGISTRY by modelId.
   * Throws if the modelId is not found in the registry or if generation fails.
   */
  async generateForModel(embedText: string, modelId: string): Promise<EmbeddingResult> {
    const entry = CLUSTER_REGISTRY.find((c) => c.modelId === modelId);
    if (!entry) {
      throw new Error(`Model ID "${modelId}" not found in CLUSTER_REGISTRY`);
    }

    const result = await this.invokeForEntry(embedText, entry);
    if (result.isErr()) {
      throw new Error(`Embedding generation failed for model "${modelId}"`);
    }
    return result.value;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async invokeForEntry(embedText: string, entry: ClusterRegistryEntry): Promise<Result<EmbeddingResult, BedrockError>> {
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

      const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { embedding: number[] };
      return ok({
        modelId: entry.modelId,
        vector: parsed.embedding,
        dimensions: entry.dimensions,
      });
    } catch (error) {
      return err(bedrockError(entry.modelId, error instanceof Error ? error : new Error(String(error))));
    }
  }
}
