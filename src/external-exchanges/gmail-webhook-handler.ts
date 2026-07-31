import type { Context } from "hono";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { createVerifier } from "./jwks-verifier.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailWebhookDeps {
  db: AccountDatabase;
  logger: Logger;
  sqsClient: SQSClient;
  queueUrl: string;
  getProviderToken: (accountId: string, connectionId: string) => Promise<string>;
}

export class GmailWebhookHandler {
  private readonly verifier;
  private readonly db: AccountDatabase;
  private readonly logger: Logger;
  private readonly sqsClient: SQSClient;
  private readonly queueUrl: string;
  private readonly getProviderToken: GmailWebhookDeps["getProviderToken"];

  constructor(deps: GmailWebhookDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.sqsClient = deps.sqsClient;
    this.queueUrl = deps.queueUrl;
    this.getProviderToken = deps.getProviderToken;
    this.verifier = createVerifier({
      jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
      issuer: "accounts.google.com",
      audience: "https://api.email.rhosys.cloud",
    });
  }

  async handle(c: Context): Promise<Response> {
    const authHeader = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match?.[1]) {
      this.logger.warn("Gmail webhook: missing Authorization header", { code: "emx.gmail.missing_auth" });
      return c.json({ error: "Unauthorized" }, 401);
    }

    const verifyResult = await this.verifier.verify(match[1]);
    if (verifyResult.isErr()) {
      this.logger.warn("Gmail webhook: JWT verification failed", { code: "emx.gmail.jwt_failed", error: verifyResult.error });
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = await c.req.json() as { message?: { data?: string } };
    if (!body.message?.data) {
      this.logger.warn("Gmail webhook: missing message.data", { code: "emx.gmail.missing_data" });
      return c.json({ error: "Bad Request" }, 400);
    }

    let decoded: { emailAddress?: string; historyId?: string };
    try {
      decoded = JSON.parse(Buffer.from(body.message.data, "base64").toString()) as { emailAddress?: string; historyId?: string };
    } catch (e) {
      this.logger.warn("Gmail webhook: failed to decode message.data", { code: "emx.gmail.decode_failed", error: e });
      return c.json({ error: "Bad Request" }, 400);
    }

    if (!decoded.emailAddress || !decoded.historyId) {
      this.logger.warn("Gmail webhook: decoded data missing fields", { code: "emx.gmail.invalid_data", decoded });
      return c.json({ error: "Bad Request" }, 400);
    }

    const { emailAddress, historyId } = decoded;

    const allActiveResult = await this.db.listExpiringExchanges("9999-12-31T23:59:59Z");
    if (allActiveResult.isErr()) {
      this.logger.error("Gmail webhook: DB query failed", { code: "emx.gmail.db_error", error: allActiveResult.error });
      return c.json({}, 200);
    }

    const emx = allActiveResult.value.find(e => e.emailAddress === emailAddress && e.platform === "gmail");
    if (!emx) {
      this.logger.info("Gmail webhook: no active EMX for email", { code: "emx.gmail.no_emx", emailAddress });
      return c.json({}, 200);
    }

    let token: string;
    try {
      token = await this.getProviderToken(emx.accountId, "google");
    } catch (e) {
      this.logger.error("Gmail webhook: failed to get provider token", { code: "emx.gmail.token_failed", emxId: emx.id, error: e });
      return c.json({}, 200);
    }

    const historyUrl = `${GMAIL_API}/history?startHistoryId=${emx.syncCursor ?? historyId}&historyTypes=messageAdded`;
    const historyResp = await fetch(historyUrl, { headers: { "Authorization": `Bearer ${token}` } });

    if (!historyResp.ok) {
      this.logger.error("Gmail webhook: history.list failed", { code: "emx.gmail.history_failed", status: historyResp.status, emxId: emx.id });
      return c.json({}, 200);
    }

    const historyData = await historyResp.json() as {
      history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
      historyId?: string;
    };

    for (const entry of historyData.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        await this.sqsClient.send(new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify({
            source: "gmail",
            providerMessageId: added.message.id,
            emxId: emx.id,
            accountId: emx.accountId,
          }),
          MessageAttributes: { messageType: { DataType: "String", StringValue: "emx_inbound" } },
        }));
      }
    }

    const newCursor = historyData.historyId ?? historyId;
    await this.db.updateExternalExchange(emx.accountId, emx.id, { syncCursor: newCursor });

    return c.json({}, 200);
  }
}
