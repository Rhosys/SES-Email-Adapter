// ---------------------------------------------------------------------------
// Reindex Worker — pure-copy + regenerate-from-S3 mode
// SQS consumer: parallel-scans DynamoDB for the assigned segment, upserts
// cached embeddings to the target Aurora cluster via MultiClusterAuroraWriter.
// When a signal lacks the target model's embedding (cache miss), the worker
// fetches the raw MIME from S3, regenerates the embedding via Bedrock, writes
// it back to the DynamoDB cache, and upserts to Aurora.
// ---------------------------------------------------------------------------

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, SIGNALS_TABLE } from "../../database/shared.js";
import { createSearchDatabase } from "../../database/thread-matcher.js";
import { getRegistryById } from "../../embedding/cluster-registry.js";
import { generateEmbeddingFromS3 } from "../../embedding/generate-embedding-from-s3.js";
import { effectiveEmailKey } from "../../embedding/retention-tier.js";
import { BedrockEmbeddingGenerator } from "../../embedding/embedding-generator.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { ThreadDatabase } from "../../database/thread-database.js";
import type { Signal, EmailSignalData } from "../../types/index.js";
import type { DbError, ReindexSegmentProcessingError, Result } from "../../errors.js";
import { ok, err, dbError, reindexSegmentProcessingError } from "../../errors.js";
import type { Logger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReindexSegmentMessage {
  jobId: string;
  segment: number;
  totalSegments: number;
  targetRegistryId: string;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared clients for regeneration path
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ReindexWorker
// ---------------------------------------------------------------------------

export class ReindexWorker {
  private readonly embeddingGenerator: BedrockEmbeddingGenerator;
  private readonly threadDatabase: ThreadDatabase;
  private readonly searchDatabase: ReturnType<typeof createSearchDatabase>;

  constructor(private readonly logger: Logger) {
    this.embeddingGenerator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}), logger);
    this.threadDatabase = new ThreadDatabase(logger);
    this.searchDatabase = createSearchDatabase(logger);
  }

  async processSegmentMessage(message: ReindexSegmentMessage): Promise<Result<void, DbError | ReindexSegmentProcessingError>> {
    const { segment, totalSegments, targetRegistryId, modelId } = message;

    // Validate target cluster exists in registry
    const cluster = getRegistryById(targetRegistryId);
    if (!cluster) return err(dbError(`Cluster "${targetRegistryId}" not found in registry`));

    return this.processSegment(segment, totalSegments, targetRegistryId, modelId);
  }

  private async processSegment(
    segment: number,
    totalSegments: number,
    targetRegistryId: string,
    modelId: string,
  ): Promise<Result<void, DbError | ReindexSegmentProcessingError>> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    const failures: Array<{ signalId: string; cause: unknown }> = [];

    do {
      let res;
      try {
        res = await dynamo.send(new ScanCommand({
          TableName: SIGNALS_TABLE,
          Segment: segment,
          TotalSegments: totalSegments,
          FilterExpression: "contains(pk, :sigMarker)",
          ExpressionAttributeValues: { ":sigMarker": "#SIG#" },
          ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
        }));
      } catch (e) {
        this.logger.error("DynamoDB scan failed during reindex segment processing. The segment will be retried.", { code: "reindex.worker.scan_failed", error: e, segment, totalSegments, targetRegistryId });
        return err(dbError(e));
      }

      const items = (res.Items ?? []) as Array<Record<string, unknown>>;

      for (const item of items) {
        const result = await this.processSignal(item, targetRegistryId, modelId);
        if (result.isErr()) {
          failures.push(result.error);
        }
      }

      lastEvaluatedKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    if (failures.length > 0) {
      this.logger.warn("Reindex segment completed with per-signal failures. The segment will be retried.", {
        code: "reindex.worker.segment_partial_failure",
        segment,
        failureCount: failures.length,
        failures: failures.slice(0, 10),
      });
      return err(reindexSegmentProcessingError(segment, failures));
    }

    return ok(undefined);
  }

  private async processSignal(
    item: Record<string, unknown>,
    targetRegistryId: string,
    modelId: string,
  ): Promise<Result<void, { signalId: string; cause: unknown }>> {
    const signal = item as unknown as Pick<Signal, "id" | "signalLookupId" | "accountId" | "threadId" | "createdAt"> & { data?: Pick<EmailSignalData, "recipientAddress" | "embeddings" | "s3Key"> };

    if (!signal.data) {
      return err({ signalId: signal.id ?? "unknown", cause: "no data property on item" });
    }

    const embeddings = signal.data.embeddings;

    const vector = embeddings?.[modelId];
    if (vector && Array.isArray(vector)) {
      return this.pureCopyToAurora(signal as Pick<Signal, "id" | "accountId" | "threadId"> & { data: Pick<EmailSignalData, "recipientAddress"> }, vector, targetRegistryId);
    }

    return this.regenerateFromS3(signal as Pick<Signal, "id" | "signalLookupId" | "accountId" | "threadId" | "createdAt"> & { data: Pick<EmailSignalData, "recipientAddress" | "s3Key"> }, targetRegistryId, modelId);
  }

  // ---------------------------------------------------------------------------
  // Pure-copy path: cache hit → upsert to Aurora
  // ---------------------------------------------------------------------------

  private async pureCopyToAurora(
    signal: Pick<Signal, "id" | "accountId" | "threadId"> & { data: Pick<EmailSignalData, "recipientAddress"> },
    vector: number[],
    targetRegistryId: string,
  ): Promise<Result<void, { signalId: string; cause: unknown }>> {
    const upsertResult = await this.searchDatabase.upsertEmbedding({
      registryId: targetRegistryId,
      threadId: signal.threadId!,
      accountId: signal.accountId,
      recipientAddress: signal.data.recipientAddress,
      embedding: vector,
      signalId: signal.id,
    });
    if (upsertResult.isErr()) {
      return err({ signalId: signal.id, cause: upsertResult.error });
    }
    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Regeneration path: cache miss → shared pipeline (S3 → MIME → embed → Bedrock) → cache + Aurora
  // ---------------------------------------------------------------------------

  private async regenerateFromS3(
    signal: Pick<Signal, "id" | "signalLookupId" | "accountId" | "threadId" | "createdAt"> & { data: Pick<EmailSignalData, "recipientAddress" | "s3Key"> },
    targetRegistryId: string,
    modelId: string,
  ): Promise<Result<void, { signalId: string; cause: unknown }>> {
    if (!signal.data.s3Key) {
      return err({ signalId: signal.id, cause: "no s3Key on signal record" });
    }

    const result = await generateEmbeddingFromS3({
      // Reindex touches historical signals; resolve the saved/ copy by age since
      // the emails/ object may already have been expired by the lifecycle rule.
      s3Key: effectiveEmailKey(signal.data.s3Key, signal.createdAt),
      accountId: signal.accountId,
      recipientAddress: signal.data.recipientAddress,
      modelId,
      embeddingGenerator: this.embeddingGenerator,
    });
    if (result.isErr()) {
      return err({ signalId: signal.id, cause: result.error });
    }

    const cacheResult = await this.threadDatabase.addEmbeddingToCache(
      signal.accountId,
      signal.signalLookupId,
      modelId,
      result.value.vector,
    );
    if (cacheResult.isErr()) {
      return err({ signalId: signal.id, cause: cacheResult.error });
    }

    const upsertResult = await this.searchDatabase.upsertEmbedding({
      registryId: targetRegistryId,
      threadId: signal.threadId!,
      accountId: signal.accountId,
      recipientAddress: signal.data.recipientAddress,
      embedding: result.value.vector,
      signalId: signal.id,
    });
    if (upsertResult.isErr()) {
      return err({ signalId: signal.id, cause: upsertResult.error });
    }

    return ok(undefined);
  }
}
