import type { Context } from "hono";
import { DateTime } from "luxon";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { ExternalMailExchange } from "../types/index.js";
import type {
  ProviderAdapter,
  ActivationResult,
  RawMimeResult,
  SendResult,
  ProviderActivationError,
  ProviderRenewalError,
  ProviderDeactivationError,
  ProviderFetchError,
  ProviderSendError,
} from "./provider-adapter.js";
import { createVerifier } from "./jwks-verifier.js";
import { exchangeCredentials } from "./provider-adapter.js";
import { extractMsgId } from "../processor/message-id.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
import type { Logger } from "../logger.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB_TOPIC = "projects/numaeel-mail/topics/gmail-notifications";

interface GmailProviderDeps {
  db: AccountDatabase;
  signalQueue: SignalQueue;
  logger: Logger;
  getProviderToken: (userId: string, connectionId: string) => Promise<string>;
}

export class GmailProvider implements ProviderAdapter {
  private readonly verifier;
  private readonly db: AccountDatabase;
  private readonly signalQueue: SignalQueue;
  private readonly logger: Logger;
  private readonly getProviderToken: GmailProviderDeps["getProviderToken"];

  constructor(deps: GmailProviderDeps) {
    this.db = deps.db;
    this.signalQueue = deps.signalQueue;
    this.logger = deps.logger;
    this.getProviderToken = deps.getProviderToken;
    this.verifier = createVerifier({
      jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
      issuer: "accounts.google.com",
      audience: "https://api.email.rhosys.cloud",
    });
  }

  // ---------------------------------------------------------------------------
  // ProviderAdapter methods
  // ---------------------------------------------------------------------------

  async activate(token: string, _emx: ExternalMailExchange): Promise<Result<ActivationResult, ProviderActivationError>> {
    try {
      const response = await fetch(`${GMAIL_API}/watch`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ topicName: PUBSUB_TOPIC, labelIds: ["INBOX"] }),
      });
      if (!response.ok) {
        return err({ kind: "provider_activation_failed", cause: await response.text() });
      }
      const data = await response.json() as { historyId: string; expiration: string };
      return ok({
        syncCursor: data.historyId,
        expiresAt: DateTime.fromMillis(Number(data.expiration)).toISO()!,
        providerSubscriptionId: "watch",
      });
    } catch (e) {
      return err({ kind: "provider_activation_failed", cause: e });
    }
  }

  async renew(token: string, emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>> {
    try {
      const response = await fetch(`${GMAIL_API}/watch`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ topicName: PUBSUB_TOPIC, labelIds: ["INBOX"] }),
      });
      if (!response.ok) {
        const cause = await response.text();
        this.logger.error("Gmail renewal failed", { code: "emx.gmail.renewal_failed", emxId: emx.id, cause });
        return err({ kind: "provider_renewal_failed", cause });
      }
      const data = await response.json() as { historyId: string; expiration: string };
      const expiresAt = DateTime.fromMillis(Number(data.expiration)).toISO()!;

      // Update subscription expiry and next sync time (same value for Gmail)
      await this.db.updateExternalExchange(emx.accountId, emx.id, { expiresAt, nextSyncTime: expiresAt });

      return ok(undefined);
    } catch (e) {
      this.logger.error("Gmail renewal failed", { code: "emx.gmail.renewal_failed", emxId: emx.id, error: e });
      return err({ kind: "provider_renewal_failed", cause: e });
    }
  }

  async deactivate(token: string, _emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    try {
      const response = await fetch(`${GMAIL_API}/stop`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 204) {
        return err({ kind: "provider_deactivation_failed", cause: await response.text() });
      }
      return ok(undefined);
    } catch (e) {
      return err({ kind: "provider_deactivation_failed", cause: e });
    }
  }

  async fetchMessage(token: string, providerMessageId: string, _emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>> {
    try {
      const response = await fetch(`${GMAIL_API}/messages/${providerMessageId}?format=raw`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (response.status === 401) {
        return err({ kind: "provider_token_expired" });
      }
      if (!response.ok) {
        return err({ kind: "provider_fetch_failed", cause: await response.text() });
      }
      const data = await response.json() as { raw: string; internalDate: string };
      const rawMime = Buffer.from(data.raw, "base64url");
      return ok({
        rawMime: new Uint8Array(rawMime),
        receivedAt: DateTime.fromMillis(Number(data.internalDate)).toISO()!,
      });
    } catch (e) {
      return err({ kind: "provider_fetch_failed", cause: e });
    }
  }

  async fetchMailboxAddress(token: string): Promise<Result<string, ProviderFetchError>> {
    try {
      const response = await fetch(`${GMAIL_API}/profile`, { headers: { "Authorization": `Bearer ${token}` } });
      if (response.status === 401) return err({ kind: "provider_token_expired" });
      if (!response.ok) return err({ kind: "provider_fetch_failed", cause: await response.text() });
      const data = await response.json() as { emailAddress?: string };
      if (!data.emailAddress) return err({ kind: "provider_fetch_failed", cause: "Gmail profile carried no emailAddress" });
      return ok(data.emailAddress);
    } catch (e) {
      return err({ kind: "provider_fetch_failed", cause: e });
    }
  }

  /**
   * Sends through the user's own Gmail account, which is the only way mail from a
   * @gmail.com address passes SPF/DKIM/DMARC at the recipient. Gmail files the sent copy
   * in the user's Sent folder for us.
   *
   * Requires the `gmail.send` scope on the linked connection; a connection linked before
   * sending existed only carries read scopes and comes back 403.
   */
  async sendMessage(token: string, rawMime: Uint8Array, emx: ExternalMailExchange): Promise<Result<SendResult, ProviderSendError>> {
    try {
      const response = await fetch(`${GMAIL_API}/messages/send`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: Buffer.from(rawMime).toString("base64url") }),
      });

      if (response.status === 401) return err({ kind: "provider_token_expired" });
      if (!response.ok) {
        const cause = await response.text();
        if (response.status === 403) {
          this.logger.error("Gmail send rejected — connection is missing the gmail.send scope. The user must re-link their Google identity to grant it.", { code: "emx.gmail.send_scope_missing", emxId: emx.id, cause });
          return err({ kind: "provider_send_scope_missing", cause });
        }
        // 4xx other than auth is the message itself being refused; 5xx is worth another attempt.
        if (response.status < 500) {
          this.logger.warn("Gmail send rejected", { code: "emx.gmail.send_rejected", emxId: emx.id, status: response.status, cause });
          return err({ kind: "provider_send_rejected", cause });
        }
        return err({ kind: "provider_send_failed", cause });
      }

      const data = await response.json() as { id: string };
      const messageId = await this.fetchRfcMessageId(token, data.id);

      this.logger.info("Gmail send succeeded", { code: "emx.gmail.send_success", emxId: emx.id, providerMessageId: data.id });
      return ok({ providerMessageId: data.id, ...(messageId ? { messageId } : {}) });
    } catch (e) {
      return err({ kind: "provider_send_failed", cause: e });
    }
  }

  /**
   * Reads back the RFC 5322 Message-ID Gmail assigned. Gmail overwrites any Message-ID we
   * supply, and the send response only carries Gmail's own internal id — but replies quote
   * the RFC one in In-Reply-To, so it is what the GSI3 thread lookup has to be keyed on.
   * Best-effort: a failure here costs reply threading, not the send.
   */
  private async fetchRfcMessageId(token: string, providerMessageId: string): Promise<string | null> {
    try {
      const response = await fetch(`${GMAIL_API}/messages/${providerMessageId}?format=metadata&metadataHeaders=Message-ID`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!response.ok) return null;
      const data = await response.json() as { payload?: { headers?: Array<{ name: string; value: string }> } };
      const header = data.payload?.headers?.find(h => h.name.toLowerCase() === "message-id");
      return header ? extractMsgId(header.value) : null;
    } catch (e) {
      this.logger.info("Gmail: could not read back sent Message-ID — reply threading for this message will fall back to subject matching", { code: "emx.gmail.send_msgid_lookup_failed", providerMessageId, error: e });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook handler
  // ---------------------------------------------------------------------------

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

    const credentials = exchangeCredentials(emx);
    if (!credentials) {
      this.logger.error("Gmail webhook: exchange has no linked identity recorded, so its provider credentials cannot be fetched. It predates connection tracking and must be reconnected by the user.", { code: "emx.gmail.no_connection", emxId: emx.id });
      return c.json({}, 200);
    }

    let token: string;
    try {
      token = await this.getProviderToken(credentials.userId, credentials.connectionId);
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

    // Collect all new message IDs and enqueue as a batch
    const messageIds: string[] = [];
    for (const entry of historyData.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        messageIds.push(added.message.id);
      }
    }

    const entries = messageIds.map((msgId, i) => ({
      id: `gmail-${i}`,
      payload: { source: "gmail", providerMessageId: msgId, emxId: emx.id, accountId: emx.accountId },
    }));
    const batchResult = await this.signalQueue.sendBatch("emx_inbound", entries);
    if (batchResult.isErr()) {
      this.logger.error("Gmail webhook: failed to enqueue emx_inbound batch", { code: "emx.gmail.batch_failed", emxId: emx.id, count: entries.length, error: batchResult.error });
      return c.json({ error: "Internal Server Error" }, 500);
    }

    const newCursor = historyData.historyId ?? historyId;
    await this.db.updateExternalExchange(emx.accountId, emx.id, { syncCursor: newCursor });

    return c.json({}, 200);
  }
}
