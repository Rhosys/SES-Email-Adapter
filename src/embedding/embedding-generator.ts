// ---------------------------------------------------------------------------
// Embedding Generator
// Wraps Bedrock per active cluster. Replaces SignalClassifier.embed().
// ---------------------------------------------------------------------------

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import { bedrockError } from "../errors.js";
import type { BedrockError } from "../errors.js";
import { CLUSTER_REGISTRY, getSecondaryClusters, type ClusterRegistryEntry } from "./cluster-registry.js";
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
  generateForModel(embedText: string, modelId: string): Promise<Result<EmbeddingResult, BedrockError>>;
  generateForSecondaryClusters(embedText: string): Promise<Result<EmbeddingResult, BedrockError>[]>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class BedrockEmbeddingGenerator implements EmbeddingGenerator {
  constructor(
    private readonly bedrock: BedrockRuntimeClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Generates an embedding for a specific model by ID.
   * Resolves dimensions from CLUSTER_REGISTRY by modelId.
   * Returns Err(BedrockError) on registry miss or generation failure.
   */
  async generateForModel(embedText: string, modelId: string): Promise<Result<EmbeddingResult, BedrockError>> {
    const entry = CLUSTER_REGISTRY.find((c) => c.modelId === modelId);
    if (!entry) {
      return err(bedrockError(modelId, new Error(`Model ID "${modelId}" not found in CLUSTER_REGISTRY`)));
    }

    return this.invokeForEntry(embedText, entry);
  }

  /**
   * Generates embeddings for all secondary clusters in parallel.
   * Returns one Result per secondary cluster.
   */
  async generateForSecondaryClusters(embedText: string): Promise<Result<EmbeddingResult, BedrockError>[]> {
    const clusters = getSecondaryClusters();
    return Promise.all(clusters.map((entry) => this.invokeForEntry(embedText, entry)));
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
