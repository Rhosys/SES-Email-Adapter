import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { ProcessorError } from "../errors.js";
import type { ProviderAdapter, ProviderFetchError } from "./provider-adapter.js";
import type { InboundSignalMessage } from "../processor/processor.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// emx_inbound SQS worker
//
// Processes a single email from an external provider: fetches raw MIME via the
// provider adapter, writes to S3, and feeds into the existing signal processor.
// ---------------------------------------------------------------------------

export interface EmxInboundPayload {
  source: "gmail" | "outlook";
  providerMessageId: string;
  emxId: string;
  accountId: string;
}

interface EmxInboundWorkerDeps {
  logger: Logger;
  s3Client: S3Client;
  emailBucket: string;
  adapters: Record<string, ProviderAdapter>;
  processRecord: (message: InboundSignalMessage, receiveCount: number) => Promise<Result<void, ProcessorError>>;
}

export class EmxInboundWorker {
  private readonly logger: Logger;
  private readonly s3Client: S3Client;
  private readonly emailBucket: string;
  private readonly adapters: Record<string, ProviderAdapter>;
  private readonly processRecord: EmxInboundWorkerDeps["processRecord"];

  constructor(deps: EmxInboundWorkerDeps) {
    this.logger = deps.logger;
    this.s3Client = deps.s3Client;
    this.emailBucket = deps.emailBucket;
    this.adapters = deps.adapters;
    this.processRecord = deps.processRecord;
  }

  async process(payload: EmxInboundPayload, sqsMessageId: string, receiveCount: number): Promise<Result<void, ProviderFetchError | ProcessorError>> {
    const { source, providerMessageId, emxId } = payload;
    const compositeMailMessageId = `${source}-${providerMessageId}`;
    const s3Key = `emails/${source}/${providerMessageId}`;

    // 1. Get provider adapter
    const adapter = this.adapters[source];
    if (!adapter) {
      this.logger.error("emx_inbound: unknown source platform", { code: "emx.inbound.unknown_source", source, emxId });
      return ok(undefined); // Drop — not retryable
    }

    // 2. Get token from Authress for the user's provider connection
    // TODO: Implement Authress delegated token fetch
    const token = "";

    // 3. Fetch raw MIME from provider
    const fetchResult = await adapter.fetchMessage(token, providerMessageId);
    if (fetchResult.isErr()) {
      const error = fetchResult.error;
      if (error.kind === "provider_token_expired") {
        this.logger.warn("emx_inbound: provider token expired, skipping", { code: "emx.inbound.token_expired", source, providerMessageId, emxId });
        return ok(undefined); // Drop — token refresh happens at sync time
      }
      this.logger.error("emx_inbound: fetch failed", { code: "emx.inbound.fetch_failed", source, providerMessageId, emxId, error });
      return err(error); // Retryable — will go back to SQS
    }

    // 4. Write raw MIME to S3
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.emailBucket,
      Key: s3Key,
      Body: fetchResult.value.rawMime,
      ContentType: "message/rfc822",
    }));

    // 5. Feed into existing signal processor
    const message: InboundSignalMessage = {
      s3Key,
      compositeMailMessageId,
      idempotencyKey: sqsMessageId,
      timestamp: fetchResult.value.receivedAt,
      destination: [], // External mail — recipient resolved from headers in processor
      dkimVerdict: "PASS", // External providers already validated authentication
      dmarcVerdict: "PASS",
    };

    return this.processRecord(message, receiveCount);
  }
}
