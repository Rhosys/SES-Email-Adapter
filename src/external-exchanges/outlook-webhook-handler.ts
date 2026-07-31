import type { Context } from "hono";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { createVerifier } from "./jwks-verifier.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Outlook Graph webhook handler
//
// Receives change notifications from Microsoft Graph when a connected Outlook
// account gets new mail. The handler validates JWT tokens (because we use
// includeResourceData: true), looks up the EMX by subscriptionId, and enqueues
// each new message as an emx_inbound SQS message.
//
// Outlook Graph has a 3-second deadline — handler must only validate + enqueue.
// Encrypted resource data (encryptedContent) is DISCARDED — we always fetch via API.
// ---------------------------------------------------------------------------

interface GraphNotification {
  subscriptionId: string;
  changeType: string;
  resource: string;
  resourceData?: { id?: string; "@odata.id"?: string };
  encryptedContent?: unknown; // Discarded — always fetch via API
}

interface GraphNotificationBody {
  value?: GraphNotification[];
  validationTokens?: string[];
}

interface OutlookWebhookDeps {
  db: AccountDatabase;
  logger: Logger;
  sqsClient: SQSClient;
  queueUrl: string;
  azureAdClientId: string; // audience for JWT verification
}

export class OutlookWebhookHandler {
  private readonly verifier;
  private readonly db: AccountDatabase;
  private readonly logger: Logger;
  private readonly sqsClient: SQSClient;
  private readonly queueUrl: string;

  constructor(deps: OutlookWebhookDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.sqsClient = deps.sqsClient;
    this.queueUrl = deps.queueUrl;
    this.verifier = createVerifier({
      // Microsoft's OIDC discovery → JWKS
      jwksUrl: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      audience: deps.azureAdClientId,
      additionalClaims: { azp: "0bf30f3b-4a52-48df-9a82-234910c4a086" },
    });
  }

  async handle(c: Context): Promise<Response> {
    // 1. Graph validation handshake — echo validationToken as text/plain
    const validationToken = c.req.query("validationToken");
    if (validationToken) {
      return c.text(validationToken, 200);
    }

    // 2. Parse notification body
    const body = (await c.req.json()) as GraphNotificationBody;

    // 3. Validate validationTokens[] JWTs (present because includeResourceData: true)
    if (body.validationTokens && body.validationTokens.length > 0) {
      for (const token of body.validationTokens) {
        const result = await this.verifier.verify(token);
        if (result.isErr()) {
          this.logger.warn("Outlook webhook: JWT validation failed", { code: "emx.outlook.jwt_failed", error: result.error });
          return c.json({ error: "Unauthorized" }, 401);
        }
      }
    }

    // 4. Process each notification in value[] where changeType === "created"
    const notifications = body.value ?? [];
    for (const notification of notifications) {
      if (notification.changeType !== "created") continue;

      // Extract providerMessageId from resourceData.id or resource path
      // Resource path examples: "me/messages/{id}", "me/mailFolders/inbox/messages/{id}"
      const resourceParts = notification.resource.split("/");
      const providerMessageId = notification.resourceData?.id ?? resourceParts[resourceParts.length - 1];

      if (!providerMessageId) {
        this.logger.warn("Outlook webhook: cannot extract message ID", { code: "emx.outlook.no_message_id", resource: notification.resource });
        continue;
      }

      // Look up EMX by subscriptionId
      const emxResult = await this.db.findExternalExchangeBySubscriptionId(notification.subscriptionId);
      if (emxResult.isErr()) {
        this.logger.error("Outlook webhook: DB lookup failed", { code: "emx.outlook.db_error", error: emxResult.error });
        continue;
      }

      const emx = emxResult.value;
      if (!emx) {
        this.logger.info("Outlook webhook: no EMX for subscription", { code: "emx.outlook.no_emx", subscriptionId: notification.subscriptionId });
        continue;
      }

      // Enqueue SQS emx_inbound
      await this.sqsClient.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({
          source: "outlook",
          providerMessageId,
          emxId: emx.id,
          accountId: emx.accountId,
        }),
        MessageAttributes: {
          messageType: { DataType: "String", StringValue: "emx_inbound" },
        },
      }));

      this.logger.info("Outlook webhook: enqueued emx_inbound", { code: "emx.outlook.enqueued", providerMessageId, emxId: emx.id });
    }

    // 5. Return 202 — Graph expects fast response
    return c.json({}, 202);
  }
}
