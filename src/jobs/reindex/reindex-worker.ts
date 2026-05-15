// ---------------------------------------------------------------------------
// Reindex Worker — pure-copy + regenerate-from-S3 mode
// SQS consumer: parallel-scans DynamoDB for the assigned segment, upserts
// cached embeddings to the target Aurora cluster via MultiClusterAuroraWriter.
// When a signal lacks the target model's embedding (cache miss), the worker
// fetches the raw MIME from S3, regenerates the embedding via Bedrock, writes
// it back to the DynamoDB cache, and upserts to Aurora.
// ---------------------------------------------------------------------------

import type { SQSEvent, SQSRecord } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { dynamo, SIGNALS_TABLE } from "../../database/shared.js";
import { multiClusterWriter } from "../../database/multi-cluster-aurora-writer.js";
import { getRegistryById } from "../../embedding/cluster-registry.js";
import { MailparserMimeParser } from "../../processor/mime.js";
import { buildEmbedText, extractEmbedTextInput } from "../../embedding/embed-text.js";
import { BedrockEmbeddingGenerator } from "../../embedding/embedding-generator.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { ArcDatabase } from "../../database/arc-database.js";
import type { Signal } from "../../types/index.js";
import type { Result } from "../../errors.js";
import { ok, err, processError, dbError } from "../../errors.js";
import type { ProcessError } from "../../errors.js";
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

const EMAIL_BUCKET = process.env["EMAIL_BUCKET"] ?? "";

// ---------------------------------------------------------------------------
// Shared clients for regeneration path
// ---------------------------------------------------------------------------

const s3 = new S3Client({});
const mimeParser = new MailparserMimeParser();
const embeddingGenerator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
const arcDatabase = new ArcDatabase();

// ---------------------------------------------------------------------------
// S3 NoSuchKey detection
// ---------------------------------------------------------------------------

function isNoSuchKeyError(e: unknown): boolean {
  if (e && typeof e === "object") {
    const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchKey" || err.Code === "NoSuchKey") return true;
    if (err.$metadata?.httpStatusCode === 404) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ReindexWorker
// ---------------------------------------------------------------------------

export class ReindexWorker {
  constructor(private readonly logger: Logger) {}

  async process(event: SQSEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
    this.logger.startInvocation();
    const results = await Promise.all(
      event.Records.map(record => this.processRecord(record))
    );

    const failures: Array<{ itemIdentifier: string }> = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.isErr()) {
        failures.push({ itemIdentifier: result.error.messageId });
      }
    }

    return { batchItemFailures: failures };
  }

  private async processRecord(record: SQSRecord): Promise<Result<void, ProcessError>> {
    let message: ReindexSegmentMessage;
    try {
      message = JSON.parse(record.body) as ReindexSegmentMessage;
    } catch (e) {
      this.logger.error("Failed to parse reindex segment message from SQS record. The JSON payload could not be deserialized. This message will be retried.", { code: "reindex.worker.parse_failed", error: e, record });
      return err(processError(record.messageId));
    }

    const { segment, totalSegments, targetRegistryId, modelId } = message;

    // Validate target cluster exists in registry
    const cluster = getRegistryById(targetRegistryId);
    if (!cluster) return err(processError(record.messageId));

    // Process segment
    const segmentResult = await this.processSegment(segment, totalSegments, targetRegistryId, modelId);
    if (segmentResult.isErr()) return err(processError(record.messageId));

    return ok(undefined);
  }

  private async processSegment(
    segment: number,
    totalSegments: number,
    targetRegistryId: string,
    modelId: string,
  ): Promise<Result<void, ProcessError>> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    const failures: Array<{ signalId: string; reason: string }> = [];

    try {
      do {
        const res = await dynamo.send(new ScanCommand({
          TableName: SIGNALS_TABLE,
          Segment: segment,
          TotalSegments: totalSegments,
          FilterExpression: "contains(pk, :sigMarker)",
          ExpressionAttributeValues: { ":sigMarker": "#SIG#" },
          ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
        }));

        const items = (res.Items ?? []) as Array<Record<string, unknown>>;

        for (const item of items) {
          const result = await this.processSignal(item, targetRegistryId, modelId);
          if (result.isErr()) {
            failures.push(result.error);
          }
        }

        lastEvaluatedKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastEvaluatedKey);
    } catch (e) {
      this.logger.error("DynamoDB scan failed during reindex segment processing. The segment will be retried.", { code: "reindex.worker.scan_failed", error: e, segment, totalSegments, targetRegistryId });
      return err(processError(""));
    }

    if (failures.length > 0) {
      this.logger.error("Reindex segment completed with per-signal failures.", {
        code: "reindex.worker.segment_partial_failure",
        segment,
        failureCount: failures.length,
        failures: failures.slice(0, 10),
      });
    }

    return ok(undefined);
  }

  private async processSignal(
    item: Record<string, unknown>,
    targetRegistryId: string,
    modelId: string,
  ): Promise<Result<void, { signalId: string; reason: string }>> {
    const signal = item as unknown as Pick<Signal, "id" | "accountId" | "arcId" | "recipientAddress" | "embeddings" | "s3Key">;
    const embeddings = signal.embeddings;

    const vector = embeddings?.[modelId];
    if (vector && Array.isArray(vector)) {
      return this.pureCopyToAurora(signal, vector, targetRegistryId);
    }

    return this.regenerateFromS3(signal, targetRegistryId, modelId);
  }

  // ---------------------------------------------------------------------------
  // Pure-copy path: cache hit → upsert to Aurora
  // ---------------------------------------------------------------------------

  private async pureCopyToAurora(
    signal: Pick<Signal, "id" | "accountId" | "arcId" | "recipientAddress">,
    vector: number[],
    targetRegistryId: string,
  ): Promise<Result<void, { signalId: string; reason: string }>> {
    const upsertResult = await multiClusterWriter.upsertEmbedding({
      registryId: targetRegistryId,
      arcId: signal.arcId!,
      accountId: signal.accountId,
      recipientAddress: signal.recipientAddress,
      embedding: vector,
    });
    if (upsertResult.isErr()) {
      return err({ signalId: signal.id, reason: `Aurora upsert failed: ${String(upsertResult.error.cause)}` });
    }
    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Regeneration path: cache miss → fetch S3 → parse MIME → Bedrock → cache + Aurora
  // ---------------------------------------------------------------------------

  private async regenerateFromS3(
    signal: Pick<Signal, "id" | "accountId" | "arcId" | "recipientAddress" | "s3Key">,
    targetRegistryId: string,
    modelId: string,
  ): Promise<Result<void, { signalId: string; reason: string }>> {
    const s3Key = signal.s3Key;

    if (!s3Key) {
      return err({ signalId: signal.id, reason: "no s3Key on signal record" });
    }

    const fetchResult = await this.fetchFromS3(s3Key);
    if (fetchResult.isErr()) {
      const e = fetchResult.error;
      if (isNoSuchKeyError(e)) {
        return err({ signalId: signal.id, reason: `NoSuchKey: ${s3Key}` });
      }
      return err({ signalId: signal.id, reason: `S3 fetch failed: ${String(e)}` });
    }
    const rawMimeBuffer = fetchResult.value;

    const parseResult = await mimeParser.parseBuffer(rawMimeBuffer);
    if (parseResult.isErr()) {
      return err({ signalId: signal.id, reason: `MIME parse failed: ${String(parseResult.error.cause)}` });
    }
    const parsed = parseResult.value;

    const embedTextInput = extractEmbedTextInput(parsed, signal.accountId, signal.recipientAddress);
    const embedText = buildEmbedText(embedTextInput);

    const result = await embeddingGenerator.generateForModel(embedText, modelId);
    if (result.isErr()) {
      return err({ signalId: signal.id, reason: `Embedding generation failed for model "${modelId}": ${String(result.error.cause)}` });
    }

    const cacheResult = await arcDatabase.addEmbeddingToCache(
      signal.accountId,
      signal.id,
      modelId,
      result.value.vector,
    );
    if (cacheResult.isErr()) {
      return err({ signalId: signal.id, reason: `DDB cache write failed: ${String(cacheResult.error.cause)}` });
    }

    const upsertResult = await multiClusterWriter.upsertEmbedding({
      registryId: targetRegistryId,
      arcId: signal.arcId!,
      accountId: signal.accountId,
      recipientAddress: signal.recipientAddress,
      embedding: result.value.vector,
    });
    if (upsertResult.isErr()) {
      return err({ signalId: signal.id, reason: `Aurora upsert failed: ${String(upsertResult.error.cause)}` });
    }

    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // S3 fetch helper
  // ---------------------------------------------------------------------------

  private async fetchFromS3(s3Key: string): Promise<Result<Buffer, Error>> {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: EMAIL_BUCKET, Key: s3Key }));
      const body = await res.Body?.transformToByteArray();
      if (!body) return err(new Error(`Empty S3 object: ${s3Key}`));
      return ok(Buffer.from(body));
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
