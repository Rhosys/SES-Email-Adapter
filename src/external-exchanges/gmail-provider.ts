import type { Context } from "hono";
import { DateTime } from "luxon";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";
import type { ExternalMailExchange } from "../types/index.js";
import type {
  ProviderAdapter,
  ActivationResult,
  RenewalResult,
  RawMimeResult,
  ProviderActivationError,
  ProviderRenewalError,
  ProviderDeactivationError,
  ProviderFetchError,
} from "./provider-adapter.js";
import { createVerifier } from "./jwks-verifier.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
import type { Logger } from "../logger.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB_TOPIC = "projects/numaeel-mail/topics/gmail-notifications";

interface GmailProviderDeps {
  db: AccountDatabase;
  signalQueue: SignalQueue;
  logger: Logger;
  getProviderToken: (accountId: string, connectionId: string) => Promise<string>;
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

  async renew(token: string, _emx: ExternalMailExchange): Promise<Result<RenewalResult, ProviderRenewalError>> {
    try {
      const response = await fetch(`${GMAIL_API}/watch`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ topicName: PUBSUB_TOPIC, labelIds: ["INBOX"] }),
      });
      if (!response.ok) {
        return err({ kind: "provider_renewal_failed", cause: await response.text() });
      }
      const data = await response.json() as { historyId: string; expiration: string };
      return ok({ expiresAt: DateTime.fromMillis(Number(data.expiration)).toISO()! });
    } catch (e) {
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

  async fetchMessage(token: string, providerMessageId: string): Promise<Result<RawMimeResult, ProviderFetchError>> {
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
        await this.signalQueue.send("emx_inbound", {
          source: "gmail",
          providerMessageId: added.message.id,
          emxId: emx.id,
          accountId: emx.accountId,
        });
      }
    }

    const newCursor = historyData.historyId ?? historyId;
    await this.db.updateExternalExchange(emx.accountId, emx.id, { syncCursor: newCursor });

    return c.json({}, 200);
  }
}
