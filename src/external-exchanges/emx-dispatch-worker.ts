import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { DateTime } from "luxon";
import { ok } from "../errors.js";
import type { Result } from "../errors.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";

interface EmxDispatchWorkerDeps {
  logger: Logger;
  db: AccountDatabase;
  sqsClient: SQSClient;
  queueUrl: string;
  adapters: Record<string, ProviderAdapter>;
  getProviderToken: (accountId: string, connectionId: string) => Promise<string>;
}

export class EmxDispatchWorker {
  private readonly logger: Logger;
  private readonly db: AccountDatabase;
  private readonly sqsClient: SQSClient;
  private readonly queueUrl: string;
  private readonly adapters: Record<string, ProviderAdapter>;
  private readonly getProviderToken: EmxDispatchWorkerDeps["getProviderToken"];

  constructor(deps: EmxDispatchWorkerDeps) {
    this.logger = deps.logger;
    this.db = deps.db;
    this.sqsClient = deps.sqsClient;
    this.queueUrl = deps.queueUrl;
    this.adapters = deps.adapters;
    this.getProviderToken = deps.getProviderToken;
  }

  async dispatch(): Promise<Result<void, never>> {
    const horizon = DateTime.utc().plus({ hours: 12 }).toISO()!;

    const expiringResult = await this.db.listExpiringExchanges(horizon);
    if (expiringResult.isErr()) {
      this.logger.error("emx_dispatch: failed to query expiring exchanges", { code: "emx.dispatch.query_failed", error: expiringResult.error });
      return ok(undefined);
    }

    const expiring = expiringResult.value;
    this.logger.info("emx_dispatch: processing expiring exchanges", { code: "emx.dispatch.start", count: expiring.length, horizon });

    for (const emx of expiring) {
      const adapter = this.adapters[emx.platform];
      if (!adapter) {
        this.logger.warn("emx_dispatch: no adapter for platform", { code: "emx.dispatch.no_adapter", platform: emx.platform, emxId: emx.id });
        continue;
      }

      let token: string;
      try {
        token = await this.getProviderToken(emx.accountId, emx.platform === "gmail" ? "google" : "microsoft");
      } catch (e) {
        this.logger.error("emx_dispatch: failed to get provider token", { code: "emx.dispatch.token_failed", emxId: emx.id, error: e });
        continue;
      }

      const renewResult = await adapter.renew(token, emx);
      if (renewResult.isErr()) {
        this.logger.error("emx_dispatch: renewal failed", { code: "emx.dispatch.renewal_failed", emxId: emx.id, platform: emx.platform, error: renewResult.error });
        continue;
      }

      const updateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, { expiresAt: renewResult.value.expiresAt });
      if (updateResult.isErr()) {
        this.logger.error("emx_dispatch: failed to update expiresAt", { code: "emx.dispatch.update_failed", emxId: emx.id, error: updateResult.error });
      }

      if (emx.platform === "gmail") {
        const historyResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${emx.syncCursor}&historyTypes=messageAdded`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (historyResp.ok) {
          const historyData = await historyResp.json() as { history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; historyId?: string };
          for (const entry of historyData.history ?? []) {
            for (const added of entry.messagesAdded ?? []) {
              await this.sqsClient.send(new SendMessageCommand({
                QueueUrl: this.queueUrl,
                MessageBody: JSON.stringify({ source: "gmail", providerMessageId: added.message.id, emxId: emx.id, accountId: emx.accountId }),
                MessageAttributes: { messageType: { DataType: "String", StringValue: "emx_inbound" } },
              }));
            }
          }
          if (historyData.historyId) {
            await this.db.updateExternalExchange(emx.accountId, emx.id, { syncCursor: historyData.historyId, lastSyncAt: DateTime.utc().toISO()! });
          }
        }
      } else if (emx.platform === "outlook" && emx.syncCursor) {
        let nextLink: string | null = emx.syncCursor;
        let latestDeltaLink = emx.syncCursor;
        while (nextLink) {
          const deltaResp = await fetch(nextLink, { headers: { "Authorization": `Bearer ${token}` } });
          if (!deltaResp.ok) break;
          const page = await deltaResp.json() as { value?: Array<{ id: string }>; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
          for (const msg of page.value ?? []) {
            await this.sqsClient.send(new SendMessageCommand({
              QueueUrl: this.queueUrl,
              MessageBody: JSON.stringify({ source: "outlook", providerMessageId: msg.id, emxId: emx.id, accountId: emx.accountId }),
              MessageAttributes: { messageType: { DataType: "String", StringValue: "emx_inbound" } },
            }));
          }
          nextLink = page["@odata.nextLink"] ?? null;
          if (page["@odata.deltaLink"]) latestDeltaLink = page["@odata.deltaLink"];
        }
        await this.db.updateExternalExchange(emx.accountId, emx.id, { syncCursor: latestDeltaLink, lastSyncAt: DateTime.utc().toISO()! });
      }

      this.logger.info("emx_dispatch: renewed successfully", { code: "emx.dispatch.renewed", emxId: emx.id, newExpiresAt: renewResult.value.expiresAt });
    }

    return ok(undefined);
  }
}
