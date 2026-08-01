// ---------------------------------------------------------------------------
// Reindex Dispatcher
// Validates target cluster, fans out SQS messages for parallel DynamoDB scan.
// ---------------------------------------------------------------------------

import { DateTime } from "luxon";
import { getRegistryById } from "../../embedding/cluster-registry.js";
import { ok, err, notFoundError } from "../../errors.js";
import type { NotFoundError, Result } from "../../errors.js";
import type { Logger } from "../../logger.js";
import type { SignalQueue } from "../../messaging/signal-queue.js";

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
// Implementation
// ---------------------------------------------------------------------------

export class ReindexDispatcher {
  private readonly queue: SignalQueue;
  private readonly logger: Logger;

  constructor(opts: { signalQueue: SignalQueue; logger: Logger }) {
    this.queue = opts.signalQueue;
    this.logger = opts.logger;
  }

  async dispatch(targetRegistryId: string, segmentCount = 32): Promise<Result<ReindexJob, NotFoundError>> {
    const cluster = getRegistryById(targetRegistryId);
    if (!cluster) {
      return err(notFoundError("cluster", targetRegistryId));
    }

    const modelId = cluster.modelId;
    const jobId = this.logger.getInvocationId();
    const startedAt = DateTime.utc().toISO()!;

    const sendPromises: Promise<unknown>[] = [];
    for (let segment = 0; segment < segmentCount; segment++) {
      const message: ReindexSegmentMessage = {
        jobId,
        segment,
        totalSegments: segmentCount,
        targetRegistryId,
        modelId,
      };

      sendPromises.push(this.queue.send("reindex", message));
    }

    await Promise.all(sendPromises);

    return ok({ jobId, targetRegistryId, modelId, segmentCount, startedAt });
  }
}
