import type { Context } from "hono";
import { DateTime } from "luxon";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { ExternalMailExchange } from "../types/index.js";
import type {
  ProviderAdapter,
  ActivationResult,
  ActivationIdentity,
  RawMimeResult,
  SendResult,
  ProviderActivationError,
  ProviderRenewalError,
  ProviderDeactivationError,
  ProviderFetchError,
  ProviderSendError,
} from "./provider-adapter.js";
import { createVerifier } from "./jwks-verifier.js";
import { extractMsgId } from "../processor/message-id.js";
import { getClient as getAuthressClient } from "../api/authress-access.js";
import type { ExchangesDatabase } from "../database/exchanges-database.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
import type { Logger } from "../logger.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB_TOPIC = "projects/numaeel-mail/topics/gmail-notifications";

// Failure modes of resolving a fresh Google access token. `oauth_identity_missing` is a
// self-generated refusal (the exchange predates connection tracking and must be reconnected), so
// it carries a `reason`; `oauth_token_fetch_failed` wraps a thrown Authress error as `cause`.
type GetTokenError =
  | { kind: "oauth_identity_missing"; reason: string }
  | { kind: "oauth_token_fetch_failed"; cause: unknown };

interface GmailProviderDeps {
  db: ExchangesDatabase;
  signalQueue: SignalQueue;
  logger: Logger;
}

export class GmailProvider implements ProviderAdapter {
  private readonly verifier;
  private readonly db: ExchangesDatabase;
  private readonly signalQueue: SignalQueue;
  private readonly logger: Logger;

  constructor(deps: GmailProviderDeps) {
    this.db = deps.db;
    this.signalQueue = deps.signalQueue;
    this.logger = deps.logger;
    this.verifier = createVerifier({
      jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
      issuer: "accounts.google.com",
      audience: "https://api.email.rhosys.cloud",
    });
  }

  // ---------------------------------------------------------------------------
  // Token resolution — every method other than activate() needs a fresh token first
  // ---------------------------------------------------------------------------

  /**
   * Mints a fresh Google access token from the linked-identity coordinates. Takes only those
   * three fields (an `emx` satisfies the shape) — never the whole exchange, since nothing else
   * on it bears on the token. Owns the "no linked identity → must reconnect" refusal internally
   * so no caller has to re-check it; that branch is a definite, non-transient failure (ERROR),
   * while a thrown Authress fetch is logged WARN and its severity decided by the caller.
   */
  private async getToken(identity: { userId?: string; connectionId?: string; connectionUserId?: string }): Promise<Result<string, GetTokenError>> {
    if (!identity.userId || !identity.connectionId || !identity.connectionUserId) {
      const error = { kind: "oauth_identity_missing" as const, reason: "Exchange has no linked identity recorded — it predates connection tracking and must be reconnected by the user." };
      this.logger.error("Gmail token resolution failed — the exchange has no linked identity.", { code: "emx.gmail.oauth_identity_missing" }, error);
      return err(error);
    }
    try {
      const client = getAuthressClient();
      const response = await client.connections.getConnectionCredentials(identity.connectionId, identity.userId, identity.connectionUserId);
      return ok(response.data.accessToken);
    } catch (e) {
      const error = { kind: "oauth_token_fetch_failed" as const, cause: e };
      this.logger.warn("Gmail token resolution failed — Authress credential fetch threw.", { code: "emx.gmail.oauth_token_fetch_failed" }, error);
      return err(error);
    }
  }

  // ---------------------------------------------------------------------------
  // ProviderAdapter methods
  // ---------------------------------------------------------------------------

  async activate(_emx: ExternalMailExchange, identity?: ActivationIdentity): Promise<Result<ActivationResult, ProviderActivationError>> {
    if (!identity) return err({ kind: "provider_activation_failed", cause: "Missing linked identity for activation" });
    const tokenResult = await this.getToken(identity);
    if (tokenResult.isErr()) return err({ kind: "provider_activation_failed", cause: tokenResult.error });
    const token = tokenResult.value;
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

      // Resolved here rather than trusted from the caller: the only mailbox identifier
      // available to a browser is the linked identity's provider-side user id (a numeric
      // subject for Google), not an address.
      const addressResult = await this.fetchMailboxAddress(token);
      if (addressResult.isErr()) return err({ kind: "provider_activation_failed", cause: addressResult.error });

      return ok({
        syncCursor: data.historyId,
        expiresAt: DateTime.fromMillis(Number(data.expiration)).toISO()!,
        providerSubscriptionId: "watch",
        emailAddress: addressResult.value,
      });
    } catch (e) {
      return err({ kind: "provider_activation_failed", cause: e });
    }
  }

  async renew(emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>> {
    const tokenResult = await this.getToken(emx);
    if (tokenResult.isErr()) {
      this.logger.error("Gmail renewal failed — could not resolve a token.", { code: "emx.gmail.renewal_failed", emxId: emx.id }, tokenResult.error);
      return err({ kind: "provider_renewal_failed", cause: tokenResult.error });
    }
    const token = tokenResult.value;
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
      const renewUpdateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, expiresAt, { expiresAt });
      if (renewUpdateResult.isErr()) { this.logger.warn("Failed to update Gmail exchange after renewal", { code: "emx.gmail.renewal_update_failed", emxId: emx.id, error: renewUpdateResult.error }); }

      return ok(undefined);
    } catch (e) {
      this.logger.error("Gmail renewal failed", { code: "emx.gmail.renewal_failed", emxId: emx.id, error: e });
      return err({ kind: "provider_renewal_failed", cause: e });
    }
  }

  async deactivate(emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    const tokenResult = await this.getToken(emx);
    if (tokenResult.isErr()) return err({ kind: "provider_deactivation_failed", cause: tokenResult.error });
    const token = tokenResult.value;
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

  async fetchMessage(providerMessageId: string, emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>> {
    const tokenResult = await this.getToken(emx);
    if (tokenResult.isErr()) return err({ kind: "provider_fetch_failed", cause: tokenResult.error });
    const token = tokenResult.value;
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

  /** Not part of ProviderAdapter — only `activate` needs it, to resolve the record's address. */
  private async fetchMailboxAddress(token: string): Promise<Result<string, ProviderFetchError>> {
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
  async sendMessage(rawMime: Uint8Array, emx: ExternalMailExchange): Promise<Result<SendResult, ProviderSendError>> {
    const tokenResult = await this.getToken(emx);
    if (tokenResult.isErr()) return err({ kind: "provider_send_failed", cause: tokenResult.error });
    const token = tokenResult.value;
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

    const allActiveResult = await this.db.listExchangesDue("9999-12-31T23:59:59Z");
    if (allActiveResult.isErr()) {
      this.logger.error("Gmail webhook: DB query failed", { code: "emx.gmail.db_error", error: allActiveResult.error });
      return c.json({}, 200);
    }

    const emx = allActiveResult.value.find(e => e.emailAddress === emailAddress && e.platform === "gmail");
    if (!emx) {
      this.logger.info("Gmail webhook: no active EMX for email", { code: "emx.gmail.no_emx", emailAddress });
      return c.json({}, 200);
    }

    const tokenResult = await this.getToken(emx);
    if (tokenResult.isErr()) {
      // getToken already logged the specific cause; the webhook swallows to 200 so Pub/Sub does
      // not redeliver a notification we cannot act on.
      return c.json({}, 200);
    }
    const token = tokenResult.value;

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
    // lastSyncAt reflects "last time a push notification was actually processed" — renew()
    // above only extends the watch subscription, it never observes mail, so this webhook is
    // the only place Gmail's sync activity is real. Set unconditionally (new-mail or not),
    // same as IMAP/JMAP polling — a health signal, not a "found something new" signal.
    const webhookUpdateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, emx.status, emx.nextSyncTime!, { syncCursor: newCursor, lastSyncAt: DateTime.utc().toISO()! });
    if (webhookUpdateResult.isErr()) { this.logger.warn("Failed to update Gmail sync cursor after webhook", { code: "emx.gmail.webhook_cursor_update_failed", emxId: emx.id, error: webhookUpdateResult.error }); }

    return c.json({}, 200);
  }
}
