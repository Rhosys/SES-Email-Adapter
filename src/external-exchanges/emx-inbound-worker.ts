import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { ProcessorError } from "../errors.js";
import type { ProviderAdapter, ProviderFetchError } from "./provider-adapter.js";
import type { InboundSignalMessage } from "../processor/processor.js";
import type { Logger } from "../logger.js";
import type { EmailContentStore } from "../content-store.js";

export interface EmxInboundPayload {
  source: "gmail" | "outlook";
  providerMessageId: string;
  emxId: string;
  accountId: string;
}

interface EmxInboundWorkerDeps {
  logger: Logger;
  emailContentStore: EmailContentStore;
  adapters: Record<string, ProviderAdapter>;
  processRecord: (message: InboundSignalMessage, receiveCount: number) => Promise<Result<void, ProcessorError>>;
  getProviderToken: (accountId: string, connectionId: string) => Promise<string>;
}

export class EmxInboundWorker {
  private readonly logger: Logger;
  private readonly emailContentStore: EmailContentStore;
  private readonly adapters: Record<string, ProviderAdapter>;
  private readonly processRecord: EmxInboundWorkerDeps["processRecord"];
  private readonly getProviderToken: EmxInboundWorkerDeps["getProviderToken"];

  constructor(deps: EmxInboundWorkerDeps) {
    this.logger = deps.logger;
    this.emailContentStore = deps.emailContentStore;
    this.adapters = deps.adapters;
    this.processRecord = deps.processRecord;
    this.getProviderToken = deps.getProviderToken;
  }

  async process(payload: EmxInboundPayload, sqsMessageId: string, receiveCount: number): Promise<Result<void, ProviderFetchError | ProcessorError>> {
    const { source, providerMessageId, emxId, accountId } = payload;
    const compositeMailMessageId = `${source}-${providerMessageId}`;
    const s3Key = `emails/${source}/${providerMessageId}`;

    const adapter = this.adapters[source];
    if (!adapter) {
      this.logger.error("emx_inbound: unknown source platform", { code: "emx.inbound.unknown_source", source, emxId });
      return ok(undefined);
    }

    let token: string;
    try {
      token = await this.getProviderToken(accountId, source === "gmail" ? "google" : "microsoft");
    } catch (e) {
      this.logger.error("emx_inbound: failed to get provider token", { code: "emx.inbound.token_failed", source, emxId, error: e });
      return err({ kind: "provider_fetch_failed", cause: e });
    }

    const fetchResult = await adapter.fetchMessage(token, providerMessageId);
    if (fetchResult.isErr()) {
      const error = fetchResult.error;
      if (error.kind === "provider_token_expired") {
        this.logger.warn("emx_inbound: provider token expired, skipping", { code: "emx.inbound.token_expired", source, providerMessageId, emxId });
        return ok(undefined);
      }
      this.logger.error("emx_inbound: fetch failed", { code: "emx.inbound.fetch_failed", source, providerMessageId, emxId, error });
      return err(error);
    }

    await this.emailContentStore.putObject(s3Key, fetchResult.value.rawMime, "message/rfc822");

    const message: InboundSignalMessage = {
      s3Key,
      compositeMailMessageId,
      idempotencyKey: sqsMessageId,
      timestamp: fetchResult.value.receivedAt,
      destination: [],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };

    return this.processRecord(message, receiveCount);
  }
}
