import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { ProcessorError } from "../errors.js";
import type { ProviderAdapter, ProviderFetchError } from "./provider-adapter.js";
import type { InboundSignalMessage } from "../processor/processor.js";
import type { Logger } from "../logger.js";
import type { EmailContentStore } from "../content-store.js";
import type { AccountDatabase } from "../database/account-database.js";

export interface EmxInboundPayload {
  source: "gmail" | "outlook" | "imap" | "jmap";
  providerMessageId: string;
  emxId: string;
  accountId: string;
}

export interface EmxProcessor {
  processInbound(msg: InboundSignalMessage, receiveCount: number): Promise<Result<void, { kind: string; [key: string]: unknown }>>;
}

interface EmxInboundWorkerDeps {
  logger: Logger;
  emailContentStore: EmailContentStore;
  adapters: Record<string, ProviderAdapter>;
  accountDb: AccountDatabase;
  processor: EmxProcessor;
  getProviderToken: (accountId: string, connectionId: string) => Promise<string>;
}

export class EmxInboundWorker {
  private readonly logger: Logger;
  private readonly emailContentStore: EmailContentStore;
  private readonly adapters: Record<string, ProviderAdapter>;
  private readonly accountDb: AccountDatabase;
  private readonly processor: EmxProcessor;
  private readonly getProviderToken: EmxInboundWorkerDeps["getProviderToken"];

  constructor(deps: EmxInboundWorkerDeps) {
    this.logger = deps.logger;
    this.emailContentStore = deps.emailContentStore;
    this.adapters = deps.adapters;
    this.accountDb = deps.accountDb;
    this.processor = deps.processor;
    this.getProviderToken = deps.getProviderToken;
  }

  async process(payload: EmxInboundPayload, sqsMessageId: string, receiveCount: number): Promise<Result<void, ProviderFetchError | ProcessorError>> {
    const { source, providerMessageId, emxId, accountId } = payload;
    this.logger.info("emx_inbound: processing message", { code: "emx.inbound.start", source, providerMessageId, emxId, accountId });
    // IMAP/JMAP UIDs are only unique within a single mailbox — use emxId as namespace to prevent cross-exchange collisions
    const namespace = source === "imap" || source === "jmap" ? emxId : source;
    const compositeMailMessageId = `${namespace}-${providerMessageId}`;
    const s3Key = `emails/${namespace}/${providerMessageId}`;

    const adapter = this.adapters[source];
    if (!adapter) {
      this.logger.error("emx_inbound: unknown source platform", { code: "emx.inbound.unknown_source", source, emxId });
      return ok(undefined);
    }

    let token: string;
    if (source === "imap" || source === "jmap") {
      token = "";
    } else {
      try {
        token = await this.getProviderToken(accountId, source === "gmail" ? "google" : "microsoft");
      } catch (e) {
        this.logger.error("emx_inbound: failed to get provider token", { code: "emx.inbound.token_failed", source, emxId, error: e });
        return err({ kind: "provider_fetch_failed", cause: e });
      }
    }

    const emxResult = await this.accountDb.getExternalExchange(accountId, emxId);
    if (emxResult.isErr()) {
      this.logger.error("emx_inbound: failed to load EMX record", { code: "emx.inbound.emx_load_failed", source, emxId, error: emxResult.error });
      return err({ kind: "provider_fetch_failed", cause: emxResult.error });
    }
    const emx = emxResult.value;
    if (!emx) {
      this.logger.error("emx_inbound: EMX not found", { code: "emx.inbound.emx_not_found", source, emxId });
      return err({ kind: "provider_fetch_failed", cause: "EMX not found" });
    }

    const fetchResult = await adapter.fetchMessage(token, providerMessageId, emx);
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
      expectedAccountId: accountId,
      s3Key,
      compositeMailMessageId,
      idempotencyKey: sqsMessageId,
      timestamp: fetchResult.value.receivedAt,
      destination: [emx.emailAddress],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };

    const processResult = await this.processor.processInbound(message, receiveCount);
    if (processResult.isErr() && processResult.error.kind === "no_account_for_recipient") {
      this.logger.error("EMX inbound message dropped — no alias found for recipient. The alias should have been created during exchange activation.", {
        code: "emx.inbound.no_account_for_recipient",
        source,
        providerMessageId,
        emxId,
        accountId,
        emailAddress: emx.emailAddress,
        recipientAddress: processResult.error.recipientAddress,
        destination: processResult.error.destination,
        compositeMailMessageId: processResult.error.compositeMailMessageId,
        expectedAccountId: processResult.error.expectedAccountId,
        s3Key,
        sqsMessageId,
      });
      return ok(undefined);
    }
    if (processResult.isErr()) return err(processResult.error as ProcessorError);
    this.logger.info("emx_inbound: processed successfully", { code: "emx.inbound.processed", source, providerMessageId, emxId, accountId });
    return ok(undefined);
  }
}
