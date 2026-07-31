import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { DateTime } from "luxon";
import { ok } from "../errors.js";
import type { Result } from "../errors.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// emx_dispatch hourly handler
//
// Triggered by EventBridge every hour. Finds expiring EMX subscriptions,
// renews them, and performs catch-up sync. This is the ONLY place renewal
// happens — webhooks never renew.
// ---------------------------------------------------------------------------

interface EmxDispatchWorkerDeps {
  logger: Logger;
  db: AccountDatabase;
  sqsClient: SQSClient;
  queueUrl: string;
  adapters: Record<string, ProviderAdapter>;
}

export class EmxDispatchWorker {
  private readonly logger: Logger;
  private readonly db: AccountDatabase;
  private readonly sqsClient: SQSClient;
  private readonly queueUrl: string;
  private readonly adapters: Record<string, ProviderAdapter>;

  constructor(deps: EmxDispatchWorkerDeps) {
    this.logger = deps.logger;
    this.db = deps.db;
    this.sqsClient = deps.sqsClient;
    this.queueUrl = deps.queueUrl;
    this.adapters = deps.adapters;
  }

  async dispatch(): Promise<Result<void, never>> {
    const horizon = DateTime.utc().plus({ hours: 12 }).toISO()!;

    // 1. Query all active EMX expiring within 12 hours
    const expiringResult = await this.db.listExpiringExchanges(horizon);
    if (expiringResult.isErr()) {
      this.logger.error("emx_dispatch: failed to query expiring exchanges", { code: "emx.dispatch.query_failed", error: expiringResult.error });
      return ok(undefined); // Non-retryable from EventBridge — log and move on
    }

    const expiring = expiringResult.value;
    this.logger.info("emx_dispatch: processing expiring exchanges", { code: "emx.dispatch.start", count: expiring.length, horizon });

    for (const emx of expiring) {
      const adapter = this.adapters[emx.platform];
      if (!adapter) {
        this.logger.warn("emx_dispatch: no adapter for platform", { code: "emx.dispatch.no_adapter", platform: emx.platform, emxId: emx.id });
        continue;
      }

      // 2. Get token from Authress for the user's provider connection
      // TODO: Implement Authress delegated token fetch
      const token = "";

      // 3. Renew subscription
      // Gmail: calls watch() again → gets new expiration
      // Outlook: PATCH /subscriptions/{id} → extends expirationDateTime
      const renewResult = await adapter.renew(token, emx);
      if (renewResult.isErr()) {
        this.logger.error("emx_dispatch: renewal failed", { code: "emx.dispatch.renewal_failed", emxId: emx.id, platform: emx.platform, error: renewResult.error });
        // TODO: Track consecutive failures — after 3, consider deactivation
        continue;
      }

      // 4. Update expiresAt on EMX record
      const updateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, { expiresAt: renewResult.value.expiresAt });
      if (updateResult.isErr()) {
        this.logger.error("emx_dispatch: failed to update expiresAt", { code: "emx.dispatch.update_failed", emxId: emx.id, error: updateResult.error });
      }

      // 5. Full sync — catch-up for any missed notifications
      // TODO: Implement when Authress token fetch is available
      //
      // Gmail: GET history.list(startHistoryId=emx.syncCursor, historyTypes=messageAdded)
      // Outlook: GET {emx.syncCursor} (the deltaLink URL)
      //
      // For each new message found:
      //   await this.sqsClient.send(new SendMessageCommand({
      //     QueueUrl: this.queueUrl,
      //     MessageBody: JSON.stringify({ source: emx.platform, providerMessageId: msg.id, emxId: emx.id, accountId: emx.accountId }),
      //     MessageAttributes: { messageType: { DataType: "String", StringValue: "emx_inbound" } },
      //   }));
      //
      // Update syncCursor:
      //   await this.db.updateExternalExchange(emx.accountId, emx.id, { syncCursor: newCursor, lastSyncAt: DateTime.utc().toISO()! });

      this.logger.info("emx_dispatch: renewed successfully", { code: "emx.dispatch.renewed", emxId: emx.id, newExpiresAt: renewResult.value.expiresAt });
    }

    return ok(undefined);
  }
}
