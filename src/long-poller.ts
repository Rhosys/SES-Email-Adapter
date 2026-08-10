import type { SQSEvent, Context } from "aws-lambda";
import { EmxIdleWorker } from "./external-exchanges/emx-idle-worker.js";
import type { EmxIdlePayload } from "./external-exchanges/emx-idle-worker.js";
import { AccountDatabase } from "./database/account-database.js";
import { SignalQueue } from "./messaging/signal-queue.js";
import { EncryptionManager } from "./secrets/encryption-manager.js";
import { KMSClient } from "@aws-sdk/client-kms";
import { RequestLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Module-level singletons (warm Lambda reuse)
// ---------------------------------------------------------------------------

const logger = new RequestLogger();
const signalQueue = new SignalQueue(logger);
const accountDb = new AccountDatabase(logger);
const kms = new KMSClient({});
const encryptionManager = new EncryptionManager(kms);
void encryptionManager.init();

const worker = new EmxIdleWorker({ logger, db: accountDb, encryptionManager, signalQueue });

// ---------------------------------------------------------------------------
// Lambda entry point: long-poller.handler
// ---------------------------------------------------------------------------

export async function handler(event: SQSEvent, _context: Context): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const failures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    const messageType = record.messageAttributes?.["messageType"]?.stringValue;

    if (messageType !== "emx_idle") {
      logger.error("Long-poller received unknown message type", { code: "long_poller.unknown_type", messageType, messageId: record.messageId });
      continue; // drop unknown messages — don't retry
    }

    let body: unknown;
    try {
      body = JSON.parse(record.body);
    } catch (e) {
      logger.error("Long-poller failed to parse message body", { code: "long_poller.parse_failed", messageId: record.messageId, error: e });
      continue; // drop malformed messages
    }

    const payload = body as EmxIdlePayload;
    if (!payload.accountId) {
      logger.error("Long-poller received emx_idle without accountId", { code: "long_poller.missing_account_id", messageId: record.messageId });
      continue; // drop malformed messages
    }

    logger.startInvocation(record.messageId);
    await worker.process(payload);
    // EmxIdleWorker always returns ok() — no failures to report
  }

  return { batchItemFailures: failures };
}
