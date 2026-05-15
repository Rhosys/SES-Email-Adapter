// ---------------------------------------------------------------------------
// Reindex Dispatcher
// Validates target cluster, fans out SQS messages for parallel DynamoDB scan.
// ---------------------------------------------------------------------------

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { getRegistryById } from "../../embedding/cluster-registry.js";
import { ok, err, notFoundError } from "../../errors.js";
import type { NotFoundError, Result } from "../../errors.js";

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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ReindexDispatcher {
  private readonly sqs: SQSClient;

  constructor(opts?: { sqs?: SQSClient }) {
    this.sqs = opts?.sqs ?? new SQSClient({});
  }

  async dispatch(targetRegistryId: string, segmentCount = 32): Promise<Result<ReindexJob, NotFoundError>> {
    const cluster = getRegistryById(targetRegistryId);
    if (!cluster) {
      return err(notFoundError("cluster", targetRegistryId));
    }

    const modelId = cluster.modelId;
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();

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

    return ok({ jobId, targetRegistryId, modelId, segmentCount, startedAt });
  }
}
