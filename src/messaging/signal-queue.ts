import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from "@aws-sdk/client-sqs"
import { ok, err, dbError } from "../errors.js"
import type { DbError, Result } from "../errors.js"
import type { SqsMessageType } from "../types/index.js"
import type { Logger } from "../logger.js"

const QUEUE_URL = process.env["SIGNAL_QUEUE_URL"]!

const sqs = new SQSClient({})

// SQS hard limits
const MAX_BATCH_ENTRIES = 10
const MAX_BATCH_BYTES = 256 * 1024

export class SignalQueue {
  private readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  async send(messageType: SqsMessageType, payload: unknown, options?: { delaySeconds?: number }): Promise<Result<void, DbError>> {
    try {
      await sqs.send(new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(payload),
        ...(options?.delaySeconds ? { DelaySeconds: options.delaySeconds } : {}),
        MessageAttributes: {
          messageType: { DataType: "String", StringValue: messageType },
        },
      }))
      return ok(undefined)
    } catch (e) {
      this.logger.warn("SignalQueue: send failed", { code: "signal_queue.send_failed", messageType, error: e })
      return err(dbError(e))
    }
  }

  async sendBatch(messageType: SqsMessageType, entries: Array<{ id: string; payload: unknown }>): Promise<Result<void, DbError>> {
    if (entries.length === 0) return ok(undefined)

    const chunks = chunkEntries(messageType, entries)

    for (const chunk of chunks) {
      try {
        const result = await sqs.send(new SendMessageBatchCommand({
          QueueUrl: QUEUE_URL,
          Entries: chunk.map(e => ({
            Id: e.id,
            MessageBody: JSON.stringify(e.payload),
            MessageAttributes: {
              messageType: { DataType: "String", StringValue: messageType },
            },
          })),
        }))

        const failed = result.Failed ?? []
        if (failed.length > 0) {
          this.logger.warn("SignalQueue: partial batch failure", { code: "signal_queue.batch_partial_failure", messageType, failedCount: failed.length, failed })
          return err(dbError(new Error(`SQS batch: ${failed.length} messages failed`)))
        }
      } catch (e) {
        this.logger.warn("SignalQueue: sendBatch failed", { code: "signal_queue.batch_failed", messageType, chunkSize: chunk.length, error: e })
        return err(dbError(e))
      }
    }

    return ok(undefined)
  }
}

function chunkEntries(messageType: SqsMessageType, entries: Array<{ id: string; payload: unknown }>): Array<Array<{ id: string; payload: unknown }>> {
  const chunks: Array<Array<{ id: string; payload: unknown }>> = []
  let currentChunk: Array<{ id: string; payload: unknown }> = []
  let currentBytes = 0

  for (const entry of entries) {
    const body = JSON.stringify(entry.payload)
    // Approximate per-entry size: body + message attributes + overhead
    const entryBytes = Buffer.byteLength(body, "utf8") + Buffer.byteLength(messageType, "utf8") + 200

    if (currentChunk.length >= MAX_BATCH_ENTRIES || (currentBytes + entryBytes > MAX_BATCH_BYTES && currentChunk.length > 0)) {
      chunks.push(currentChunk)
      currentChunk = []
      currentBytes = 0
    }

    currentChunk.push(entry)
    currentBytes += entryBytes
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}
