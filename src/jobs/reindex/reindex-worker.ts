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
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { dynamo, SIGNALS_TABLE, PROCESSING_TABLE } from "../../database/shared.js";
import { multiClusterWriter } from "../../database/multi-cluster-aurora-writer.js";
import { getClusterById } from "../../embedding/cluster-registry.js";
import { MailparserMimeParser } from "../../processor/mime.js";
import { buildEmbedText, extractEmbedTextInput } from "../../embedding/embed-text.js";
import { BedrockEmbeddingGenerator } from "../../embedding/embedding-generator.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { ArcDatabase } from "../../database/arc-database.js";
import type { Signal } from "../../types/index.js";
import type { Result } from "../../errors.js";
import { ok, err, processError } from "../../errors.js";
import type { ProcessError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReindexSegmentMessage {
  jobId: string;
  segment: number;
  totalSegments: number;
  targetClusterId: string;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETRY_TRACK_THRESHOLD = 30;
const EMAIL_BUCKET = process.env["EMAIL_BUCKET"] ?? "";

// ---------------------------------------------------------------------------
// Shared clients for regeneration path
// ---------------------------------------------------------------------------

const s3 = new S3Client({});
const mimeParser = new MailparserMimeParser();
const embeddingGenerator = new BedrockEmbeddingGenerator(new BedrockRuntimeClient({}));
const arcDatabase = new ArcDatabase();

// ---------------------------------------------------------------------------
// Logging helper — escalates level based on SQS receive count
// ---------------------------------------------------------------------------

function logAtLevel(level: "track" | "error", message: string, context: Record<string, unknown>): void {
  const payload = { level, message, ...context, timestamp: new Date().toISOString() };
  if (level === "error") {
    console.error(JSON.stringify(payload));
  } else {
    console.log(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Signal validation — checks minimum fields needed for a pure-copy upsert
// ---------------------------------------------------------------------------

function isValidSignalForCopy(item: Record<string, unknown>): item is Pick<Signal, "id" | "accountId" | "arcId" | "recipientAddress" | "embeddings" | "s3Key"> {
  return (
    typeof item["id"] === "string" &&
    typeof item["accountId"] === "string" &&
    typeof item["arcId"] === "string" &&
    typeof item["recipientAddress"] === "string"
  );
}

// ---------------------------------------------------------------------------
// S3 NoSuchKey detection
// ---------------------------------------------------------------------------

function isNoSuchKeyError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === "NoSuchKey" || e.Code === "NoSuchKey") return true;
    if (e.$metadata?.httpStatusCode === 404) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ReindexWorker
// ---------------------------------------------------------------------------

export class ReindexWorker {
  async process(event: SQSEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
    const results = await Promise.all(
      event.Records.map(record => this.processRecord(record))
    );

    const failures: Array<{ itemIdentifier: string }> = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.isErr()) {
        const record = event.Records[i]!;
        const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? "1");
        const level = receiveCount > RETRY_TRACK_THRESHOLD ? "error" : "track";
        logAtLevel(level, "reindex.worker.segment_failed", {
          messageId: result.error.messageId,
          receiveCount,
          error: result.error,
        });
        failures.push({ itemIdentifier: result.error.messageId });
      }
    }

    return { batchItemFailures: failures };
  }

  private async processRecord(record: SQSRecord): Promise<Result<void, ProcessError>> {
    let message: ReindexSegmentMessage;
    try {
      message = JSON.parse(record.body) as ReindexSegmentMessage;
    } catch {
      return err(processError(record.messageId));
    }

    const { jobId, segment, totalSegments, targetClusterId, modelId } = message;

    // Validate target cluster exists in registry
    const cluster = getClusterById(targetClusterId);
    if (!cluster) return err(processError(record.messageId));

    // Process segment
    const segmentResult = await this.processSegment(jobId, segment, totalSegments, targetClusterId, modelId);
    if (segmentResult.isErr()) return err(processError(record.messageId));

    return ok(undefined);
  }

  private async processSegment(
    jobId: string,
    segment: number,
    totalSegments: number,
    targetClusterId: string,
    modelId: string,
  ): Promise<Result<void, ProcessError>> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    try {
      do {
        const res = await dynamo.send(new ScanCommand({
          TableName: SIGNALS_TABLE,
          Segment: segment,
          TotalSegments: totalSegments,
          ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
        }));

        const items = (res.Items ?? []) as Array<Record<string, unknown>>;

        for (const item of items) {
          await this.processSignal(item, jobId, targetClusterId, modelId);
        }

        lastEvaluatedKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastEvaluatedKey);
    } catch {
      return err(processError(""));
    }

    return ok(undefined);
  }

  private async processSignal(
    item: Record<string, unknown>,
    jobId: string,
    targetClusterId: string,
    modelId: string,
  ): Promise<void> {
    // Skip non-signal items (arcs, grouping keys, etc.)
    const id = item["id"] as string | undefined;
    if (!id || typeof id !== "string") return;

    // Validate signal has the minimum fields for a copy
    if (!isValidSignalForCopy(item)) {
      logAtLevel("track", "reindex.worker.malformed_signal", {
        jobId,
        signalId: id,
        reason: "missing required fields (accountId, arcId, or recipientAddress)",
      });
      return;
    }

    const signal = item as unknown as Pick<Signal, "id" | "accountId" | "arcId" | "recipientAddress" | "embeddings" | "s3Key">;
    const embeddings = signal.embeddings;

    // Check if the target model's embedding is cached (cache-hit guard)
    const vector = embeddings?.[modelId];
    if (vector && Array.isArray(vector)) {
      // Pure-copy: upsert the cached embedding to the target Aurora cluster
      await this.pureCopyToAurora(signal, vector, jobId, targetClusterId);
      return;
    }

    // Cache miss — attempt regeneration from S3
    await this.regenerateFromS3(signal, jobId, targetClusterId, modelId);
  }

  // ---------------------------------------------------------------------------
  // Pure-copy path: cache hit → upsert to Aurora
  // ---------------------------------------------------------------------------

  private async pureCopyToAurora(
    signal: Pick<Signal, "id" | "accountId" | "arcId" | "recipientAddress">,
    vector: number[],
    jobId: string,
    targetClusterId: string,
  ): Promise<void> {
    try {
      await multiClusterWriter.upsertEmbedding({
        clusterId: targetClusterId,
        arcId: signal.arcId!,
        accountId: signal.accountId,
        recipientAddress: signal.recipientAddress,
        embedding: vector,
      });

      // Increment copiedCount on the processing table
      await dynamo.send(new UpdateCommand({
        TableName: PROCESSING_TABLE,
        Key: { pk: `JOB#${jobId}`, sk: "COUNTERS" },
        UpdateExpression: "ADD copiedCount :one",
        ExpressionAttributeValues: { ":one": 1 },
      }));
    } catch (err) {
      // Per-signal failure: log and continue, do not retry the whole segment
      logAtLevel("track", "reindex.worker.signal_upsert_failed", {
        jobId,
        signalId: signal.id,
        arcId: signal.arcId,
        targetClusterId,
        error: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Regeneration path: cache miss → fetch S3 → parse MIME → Bedrock → cache + Aurora
  // ---------------------------------------------------------------------------

  private async regenerateFromS3(
    signal: Pick<Signal, "id" | "accountId" | "arcId" | "recipientAddress" | "s3Key">,
    jobId: string,
    targetClusterId: string,
    modelId: string,
  ): Promise<void> {
    const s3Key = signal.s3Key;

    // If no s3Key on the signal, it's unrecoverable
    if (!s3Key) {
      await this.incrementUnrecoverable(jobId, signal.id, "no s3Key on signal record");
      return;
    }

    // Attempt to fetch the raw MIME from S3
    let rawMimeBuffer: Buffer;
    try {
      rawMimeBuffer = await this.fetchFromS3(s3Key);
    } catch (err) {
      if (isNoSuchKeyError(err)) {
        await this.incrementUnrecoverable(jobId, signal.id, `NoSuchKey: ${s3Key}`);
        return;
      }
      // Non-NoSuchKey S3 error — log per-signal and continue
      logAtLevel("track", "reindex.worker.s3_fetch_failed", {
        jobId,
        signalId: signal.id,
        s3Key,
        error: String(err),
      });
      return;
    }

    // Parse MIME, build embed text, generate embedding via Bedrock
    try {
      const parsed = await mimeParser.parse(rawMimeBuffer);
      const embedTextInput = extractEmbedTextInput(parsed, signal.accountId, signal.recipientAddress);
      const embedText = buildEmbedText(embedTextInput);

      const result = await embeddingGenerator.generateForModel(embedText, modelId);

      // Write the vector back to DynamoDB cache
      await arcDatabase.addEmbeddingToCache(
        signal.accountId,
        signal.id,
        modelId,
        result.vector,
      );

      // Upsert to target Aurora cluster
      await multiClusterWriter.upsertEmbedding({
        clusterId: targetClusterId,
        arcId: signal.arcId!,
        accountId: signal.accountId,
        recipientAddress: signal.recipientAddress,
        embedding: result.vector,
      });

      // Increment regeneratedCount
      await dynamo.send(new UpdateCommand({
        TableName: PROCESSING_TABLE,
        Key: { pk: `JOB#${jobId}`, sk: "COUNTERS" },
        UpdateExpression: "ADD regeneratedCount :one",
        ExpressionAttributeValues: { ":one": 1 },
      }));
    } catch (err) {
      // Per-signal failure during regeneration: log and continue
      logAtLevel("track", "reindex.worker.regeneration_failed", {
        jobId,
        signalId: signal.id,
        s3Key,
        modelId,
        error: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // S3 fetch helper
  // ---------------------------------------------------------------------------

  private async fetchFromS3(s3Key: string): Promise<Buffer> {
    const res = await s3.send(new GetObjectCommand({ Bucket: EMAIL_BUCKET, Key: s3Key }));
    const body = await res.Body?.transformToByteArray();
    if (!body) throw new Error(`Empty S3 object: ${s3Key}`);
    return Buffer.from(body);
  }

  // ---------------------------------------------------------------------------
  // Unrecoverable counter helper
  // ---------------------------------------------------------------------------

  private async incrementUnrecoverable(
    jobId: string,
    signalId: string,
    reason: string,
  ): Promise<void> {
    logAtLevel("track", "reindex.worker.unrecoverable", {
      jobId,
      signalId,
      reason,
    });

    await dynamo.send(new UpdateCommand({
      TableName: PROCESSING_TABLE,
      Key: { pk: `JOB#${jobId}`, sk: "COUNTERS" },
      UpdateExpression: "ADD unrecoverableCount :one",
      ExpressionAttributeValues: { ":one": 1 },
    }));
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const reindexWorker = new ReindexWorker();
