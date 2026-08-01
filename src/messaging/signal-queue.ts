import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from "@aws-sdk/client-sqs"
import { ok, err, dbError } from "../errors.js"
import type { DbError, Result } from "../errors.js"
import type { SqsMessageType } from "../types/index.js"

const QUEUE_URL = process.env["SIGNAL_QUEUE_URL"]!

const sqs = new SQSClient({})

export class SignalQueue {
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
      return err(dbError(e))
    }
  }

  async sendBatch(messageType: SqsMessageType, entries: Array<{ id: string; payload: unknown }>): Promise<Result<void, DbError>> {
    try {
      await sqs.send(new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: entries.map(e => ({
          Id: e.id,
          MessageBody: JSON.stringify(e.payload),
          MessageAttributes: {
            messageType: { DataType: "String", StringValue: messageType },
          },
        })),
      }))
      return ok(undefined)
    } catch (e) {
      return err(dbError(e))
    }
  }
}
