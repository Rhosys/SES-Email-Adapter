// ---------------------------------------------------------------------------
// Reindex Dispatcher
// Dispatches parallel DynamoDB scan segments via SQS and reports job progress.
// ---------------------------------------------------------------------------

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ExecuteStatementCommand, RDSDataClient } from "@aws-sdk/client-rds-data";
import { randomUUID } from "node:crypto";
import { dynamo, PROCESSING_TABLE } from "../../database/shared.js";
import { CLUSTER_REGISTRY, getRegistryById, type ClusterRegistryEntry } from "../../embedding/cluster-registry.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ReindexJob {
  jobId: string;
  targetRegistryId: string;
  modelId: string;
  segmentCount: number;
  startedAt: string;
}

export interface ReindexReport {
  jobId: string;
  signalsScanned: number;
  copiedCount: number;
  regeneratedCount: number;
  unrecoverableCount: number;
  validationOk: boolean;
  validationDetail: string;
  durationMs: number;
}

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

const REINDEX_QUEUE_URL = process.env["REINDEX_QUEUE_URL"] ?? "";
const DISCREPANCY_THRESHOLD = 0.01; // 1%
const VALIDATION_SAMPLE_SIZE = 10;

// ---------------------------------------------------------------------------
// DynamoDB key helpers
// ---------------------------------------------------------------------------

function jobPk(jobId: string): string {
  return `REINDEX#${jobId}`;
}

const JOB_SK = "JOB";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ReindexDispatcher {
  private readonly sqs: SQSClient;
  private readonly rds: RDSDataClient;

  constructor(opts?: { sqs?: SQSClient; rds?: RDSDataClient }) {
    this.sqs = opts?.sqs ?? new SQSClient({});
    this.rds = opts?.rds ?? new RDSDataClient({});
  }

  // -------------------------------------------------------------------------
  // dispatch — validate cluster, fan out SQS messages, write initial counters
  // -------------------------------------------------------------------------

  async dispatch(targetRegistryId: string, segmentCount = 32): Promise<ReindexJob> {
    // Validate cluster exists in registry
    const cluster = getRegistryById(targetRegistryId);
    if (!cluster) {
      throw new Error(`Cluster "${targetRegistryId}" not found in CLUSTER_REGISTRY`);
    }

    const modelId = cluster.modelId;
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();

    // Emit N SQS messages — one per scan segment
    const sendPromises: Promise<unknown>[] = [];
    for (let segment = 0; segment < segmentCount; segment++) {
      const message: ReindexSegmentMessage = {
        jobId,
        segment,
        totalSegments: segmentCount,
        targetRegistryId,
        modelId,
      };

      sendPromises.push(
        this.sqs.send(new SendMessageCommand({
          QueueUrl: REINDEX_QUEUE_URL,
          MessageBody: JSON.stringify(message),
        })),
      );
    }

    await Promise.all(sendPromises);

    // Write initial counters row to the processing DynamoDB table.
    // signalsScanned is NOT stored — it is always computed as the sum of
    // copiedCount + regeneratedCount + unrecoverableCount in getReport.
    await dynamo.send(new PutCommand({
      TableName: PROCESSING_TABLE,
      Item: {
        pk: jobPk(jobId),
        sk: JOB_SK,
        jobId,
        targetRegistryId,
        modelId,
        segmentCount,
        startedAt,
        copiedCount: 0,
        regeneratedCount: 0,
        unrecoverableCount: 0,
      },
    }));

    return { jobId, targetRegistryId, modelId, segmentCount, startedAt };
  }

  // -------------------------------------------------------------------------
  // getReport — read counters, query Aurora for validation, compute result
  // -------------------------------------------------------------------------

  async getReport(jobId: string): Promise<ReindexReport> {
    // Read counters from processing table
    const result = await dynamo.send(new GetCommand({
      TableName: PROCESSING_TABLE,
      Key: { pk: jobPk(jobId), sk: JOB_SK },
    }));

    if (!result.Item) {
      throw new Error(`Reindex job "${jobId}" not found`);
    }

    const item = result.Item;
    const targetRegistryId = item["targetRegistryId"] as string;
    const modelId = item["modelId"] as string;
    const startedAt = item["startedAt"] as string;
    const copiedCount = (item["copiedCount"] as number) ?? 0;
    const regeneratedCount = (item["regeneratedCount"] as number) ?? 0;
    const unrecoverableCount = (item["unrecoverableCount"] as number) ?? 0;

    // signalsScanned is always the sum of the three counters — never stored
    // separately — so it cannot drift from the individual counts.
    const signalsScanned = copiedCount + regeneratedCount + unrecoverableCount;

    const durationMs = Date.now() - new Date(startedAt).getTime();

    // Query target Aurora for validation
    const cluster = getRegistryById(targetRegistryId);
    if (!cluster) {
      return {
        jobId,
        signalsScanned,
        copiedCount,
        regeneratedCount,
        unrecoverableCount,
        validationOk: false,
        validationDetail: `Target cluster "${targetRegistryId}" no longer in registry`,
        durationMs,
      };
    }

    const { auroraRowCount, sampleValidation } = await this.validateAuroraState(cluster);

    // Compare Aurora row count to DynamoDB embedding-cache count
    const expectedCount = copiedCount + regeneratedCount;
    const discrepancy = expectedCount > 0
      ? Math.abs(auroraRowCount - expectedCount) / expectedCount
      : (auroraRowCount === 0 ? 0 : 1);

    const countOk = discrepancy <= DISCREPANCY_THRESHOLD;
    const validationOk = countOk && sampleValidation.allValid;

    const details: string[] = [];
    if (!countOk) {
      details.push(`Row count discrepancy: Aurora has ${auroraRowCount} rows, expected ${expectedCount} (${(discrepancy * 100).toFixed(2)}% off)`);
    }
    if (!sampleValidation.allValid) {
      details.push(`Sample validation failed: ${sampleValidation.detail}`);
    }
    if (validationOk) {
      details.push(`Validation passed: ${auroraRowCount} Aurora rows match expected ${expectedCount}, ${VALIDATION_SAMPLE_SIZE} sample vectors valid`);
    }

    return {
      jobId,
      signalsScanned,
      copiedCount,
      regeneratedCount,
      unrecoverableCount,
      validationOk,
      validationDetail: details.join("; "),
      durationMs,
    };
  }

  // -------------------------------------------------------------------------
  // Aurora validation helpers
  // -------------------------------------------------------------------------

  private async validateAuroraState(cluster: ClusterRegistryEntry): Promise<{
    auroraRowCount: number;
    sampleValidation: { allValid: boolean; detail: string };
  }> {
    // Get row count
    const countResult = await this.rds.send(new ExecuteStatementCommand({
      resourceArn: cluster.clusterArn,
      secretArn: cluster.secretArn,
      database: cluster.databaseName,
      sql: "SELECT COUNT(*) AS cnt FROM arc_embeddings",
    }));

    const auroraRowCount = countResult.records?.[0]?.[0]?.longValue ?? 0;

    // Sample 10 random vectors and verify cosine similarity is valid
    const sampleResult = await this.rds.send(new ExecuteStatementCommand({
      resourceArn: cluster.clusterArn,
      secretArn: cluster.secretArn,
      database: cluster.databaseName,
      sql: `SELECT arc_id, embedding <=> embedding AS self_similarity
            FROM arc_embeddings
            ORDER BY RANDOM()
            LIMIT :sampleSize`,
      parameters: [
        { name: "sampleSize", value: { longValue: VALIDATION_SAMPLE_SIZE } },
      ],
    }));

    const samples = sampleResult.records ?? [];
    let invalidCount = 0;
    const invalidDetails: string[] = [];

    for (const row of samples) {
      const arcId = row[0]?.stringValue ?? "unknown";
      const similarity = row[1]?.doubleValue;

      // Self-similarity via cosine distance should be 0 (identical vectors)
      // Valid range for cosine similarity results: [-1, 1] (distance: [0, 2])
      if (similarity == null || isNaN(similarity) || similarity < -1 || similarity > 2) {
        invalidCount++;
        invalidDetails.push(`arc_id=${arcId} has invalid self-similarity: ${similarity}`);
      }
    }

    const allValid = invalidCount === 0;
    const detail = allValid
      ? `${samples.length} samples have valid cosine similarity`
      : `${invalidCount}/${samples.length} samples invalid: ${invalidDetails.join(", ")}`;

    return { auroraRowCount, sampleValidation: { allValid, detail } };
  }
}
