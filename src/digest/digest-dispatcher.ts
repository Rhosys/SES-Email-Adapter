// ---------------------------------------------------------------------------
// Digest Dispatcher
// Receives `digest_dispatch` SQS message, queries all accounts via gsi1,
// filters by frequency + current date, enqueues `digest_send` per qualifying
// account. All-or-nothing — quits on any SQS batch send failure.
// ---------------------------------------------------------------------------

import { DateTime } from "luxon"

import { ok, err } from "../errors.js"
import type { DbError, Result } from "../errors.js"
import type { Logger } from "../logger.js"
import type { SignalQueue } from "../messaging/signal-queue.js"
import { shouldDispatchDigest } from "./digest-frequency-filter.js"
import type { DigestFrequency } from "./digest-frequency-filter.js"
import type { AccountDatabase } from "../database/account-database.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IAccountMetaRow {
  id: string
  digest?: { frequency: string; forwardingTargetId: string } | null
}

export interface IDigestDispatcherDeps {
  accountDb: AccountDatabase
  signalQueue: SignalQueue
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
    const { accountDb, signalQueue, logger } = this.deps

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
        id: `${index}`,
        payload: { accountId: account.id },
      }))

      const result = await signalQueue.sendBatch("digest_send", entries)
      if (result.isErr()) {
        logger.error("SQS batch send failed — aborting dispatch", {
          code: "digest.dispatch.batch_send_error",
          error: result.error,
          batchSize: entries.length,
        })
        return err(result.error)
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
