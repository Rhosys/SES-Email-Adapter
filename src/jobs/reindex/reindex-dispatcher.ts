// ---------------------------------------------------------------------------
// Reindex Dispatcher
// Validates target cluster, fans out SQS messages for parallel DynamoDB scan.
// ---------------------------------------------------------------------------

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DateTime } from "luxon";
import { getRegistryById } from "../../embedding/cluster-registry.js";
import { ok, err, notFoundError } from "../../errors.js";
import type { NotFoundError, Result } from "../../errors.js";
import type { Logger } from "../../logger.js";
import { SQS_MESSAGE_TYPES } from "../../types/index.js";

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

const SIGNAL_QUEUE_URL = process.env["SIGNAL_QUEUE_URL"] ?? "";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ReindexDispatcher {
  private readonly sqs: SQSClient;
  private readonly logger: Logger;

  constructor(opts: { sqs?: SQSClient; logger: Logger }) {
    this.sqs = opts.sqs ?? new SQSClient({});
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

      sendPromises.push(
        this.sqs.send(new SendMessageCommand({
          QueueUrl: SIGNAL_QUEUE_URL,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            messageType: { DataType: "String", StringValue: SQS_MESSAGE_TYPES[0] },
            callerInvocationId: { DataType: "String", StringValue: this.logger.getInvocationId() || "<NULL>" },
          },
        })),
      );
    }

    await Promise.all(sendPromises);

    return ok({ jobId, targetRegistryId, modelId, segmentCount, startedAt });
  }
}
