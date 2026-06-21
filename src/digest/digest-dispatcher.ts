// ---------------------------------------------------------------------------
// Digest Dispatcher
// Receives `digest_dispatch` SQS message, queries all accounts via GSI1,
// filters by frequency + current date, enqueues `digest_send` per qualifying
// account. All-or-nothing — quits on any SQS batch send failure.
// ---------------------------------------------------------------------------

import { SendMessageBatchCommand } from "@aws-sdk/client-sqs"
import type { SQSClient } from "@aws-sdk/client-sqs"
import { DateTime } from "luxon"

import { ok, err, dbError } from "../errors.js"
import type { DbError, Result } from "../errors.js"
import type { Logger } from "../logger.js"
import { shouldDispatchDigest } from "./digest-frequency-filter.js"
import type { DigestFrequency } from "./digest-frequency-filter.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IAccountMetaRow {
  id: string
  digest?: { frequency: string; forwardingTargetId: string } | null
}

export interface IDigestDispatcherDeps {
  accountDb: { queryAllAccountMetas(): Promise<Result<IAccountMetaRow[], DbError>> }
  sqsClient: SQSClient
  queueUrl: string
  logger: Logger
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DigestDispatcher {
  private readonly deps: IDigestDispatcherDeps

  constructor(deps: IDigestDispatcherDeps) {
    this.deps = deps
  }

  async dispatch(today: DateTime = DateTime.utc()): Promise<Result<void, DbError>> {
    const { accountDb, sqsClient, queueUrl, logger } = this.deps

    const metasResult = await accountDb.queryAllAccountMetas()
    if (metasResult.isErr()) {
      return err(metasResult.error)
    }

    const qualifying = metasResult.value.filter(
      (account): account is IAccountMetaRow & { digest: { frequency: string; forwardingTargetId: string } } =>
        account.digest != null && shouldDispatchDigest(account.digest.frequency as DigestFrequency, today),
    )

    logger.info("Digest dispatch filtering complete", {
      code: "digest.dispatch.filtered",
      totalAccounts: metasResult.value.length,
      qualifyingAccounts: qualifying.length,
    })

    if (qualifying.length === 0) {
      return ok(undefined)
    }

    // Batch enqueue in groups of 10 (SQS maximum)
    const batches = chunk(qualifying, 10)
    for (const batch of batches) {
      const entries = batch.map((account, index) => ({
        Id: `${index}`,
        MessageBody: JSON.stringify({ accountId: account.id }),
        MessageAttributes: {
          messageType: { DataType: "String" as const, StringValue: "digest_send" },
        },
      }))

      try {
        const result = await sqsClient.send(new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: entries,
        }))

        if (result.Failed && result.Failed.length > 0) {
          logger.error("SQS batch send had partial failures — aborting dispatch", {
            code: "digest.dispatch.batch_partial_failure",
            failed: result.Failed,
            batchSize: entries.length,
          })
          return err(dbError(new Error(`SQS batch send partial failure: ${result.Failed.length} messages failed`)))
        }
      } catch (e) {
        logger.error("SQS batch send threw — aborting dispatch", {
          code: "digest.dispatch.batch_send_error",
          error: e,
          batchSize: entries.length,
        })
        return err(dbError(e))
      }
    }

    logger.info("Digest dispatch complete", {
      code: "digest.dispatch.complete",
      enqueuedCount: qualifying.length,
    })

    return ok(undefined)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunk<T>(array: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size))
  }
  return result
}
