import type { Context } from "hono";
import { readFile } from "node:fs/promises";
import { createPublicKey, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
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
import { exchangeCredentials } from "./provider-adapter.js";
import { createVerifier } from "./jwks-verifier.js";
import { extractMsgId } from "../processor/message-id.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { SignalQueue } from "../messaging/signal-queue.js";
import type { Logger } from "../logger.js";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const WEBHOOK_URL = "https://api.email.rhosys.cloud/api/external-exchanges/outlook/target";
const SECRETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "secrets");
const CERT_ID = "numaeel-graph-v1";

// ---------------------------------------------------------------------------
// Graph notification types
// ---------------------------------------------------------------------------

interface GraphNotification {
  subscriptionId: string;
  changeType: string;
  resource: string;
  resourceData?: { id?: string; "@odata.id"?: string };
  encryptedContent?: unknown;
}

interface GraphNotificationBody {
  value?: GraphNotification[];
  validationTokens?: string[];
}

// ---------------------------------------------------------------------------
// Provider deps
// ---------------------------------------------------------------------------

interface OutlookProviderDeps {
  db: AccountDatabase;
  signalQueue: SignalQueue;
  logger: Logger;
  getProviderToken: (userId: string, connectionId: string, connectionUserId: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class OutlookProvider implements ProviderAdapter {
  private publicKeyBase64Cache: string | null = null;
  private readonly kms = new KMSClient({});
  private readonly verifier;
  private readonly db: AccountDatabase;
  private readonly signalQueue: SignalQueue;
  private readonly logger: Logger;
  private readonly getProviderToken: OutlookProviderDeps["getProviderToken"];
  private readonly azureAdClientId: string;

  constructor(deps: OutlookProviderDeps) {
    this.db = deps.db;
    this.signalQueue = deps.signalQueue;
    this.logger = deps.logger;
    this.getProviderToken = deps.getProviderToken;
    this.azureAdClientId = process.env["AZURE_AD_CLIENT_ID"] ?? "";
    this.verifier = createVerifier({
      jwksUrl: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      audience: this.azureAdClientId,
      additionalClaims: { azp: "0bf30f3b-4a52-48df-9a82-234910c4a086" },
    });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async getEncryptionCertificateBase64(): Promise<string> {
    if (this.publicKeyBase64Cache) return this.publicKeyBase64Cache;
    const encrypted = await readFile(join(SECRETS_DIR, "graph-encryption-key-v1.kms"));
    const result = await this.kms.send(new DecryptCommand({ CiphertextBlob: encrypted }));
    if (!result.Plaintext) throw new Error("KMS decryption returned no plaintext");
    const privateKeyPem = Buffer.from(result.Plaintext);
    const publicKey = createPublicKey(privateKeyPem);
    const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    this.publicKeyBase64Cache = Buffer.from(publicPem).toString("base64");
    return this.publicKeyBase64Cache;
  }

  // ---------------------------------------------------------------------------
  // Credential resolution — shared by every method below activate()
  // ---------------------------------------------------------------------------

  /**
   * Resolves a fresh access token for `emx`, from the identity coordinates recorded on it at
   * connect time. The one thing every ProviderAdapter method other than `activate` needs
   * before it can do anything else, so it lives here rather than being re-derived per call
   * site — the previous design left that to each caller, which is how `getConnectionCredentials`
   * ended up invoked with the wrong id in more than one place.
   */
  private async resolveToken(emx: ExternalMailExchange): Promise<Result<string, { cause: unknown }>> {
    const credentials = exchangeCredentials(emx);
    if (!credentials) return err({ cause: "Exchange has no linked identity recorded — it predates connection tracking and must be reconnected by the user." });
    try {
      return ok(await this.getProviderToken(credentials.userId, credentials.connectionId, credentials.connectionUserId));
    } catch (e) {
      return err({ cause: e });
    }
  }

  // ---------------------------------------------------------------------------
  // ProviderAdapter methods
  // ---------------------------------------------------------------------------

  async activate(_emx: ExternalMailExchange, identity?: ActivationIdentity): Promise<Result<ActivationResult, ProviderActivationError>> {
    if (!identity) return err({ kind: "provider_activation_failed", cause: "Missing linked identity for activation" });
    let token: string;
    try {
      token = await this.getProviderToken(identity.userId, identity.connectionId, identity.connectionUserId);
    } catch (e) {
      return err({ kind: "provider_activation_failed", cause: e });
    }
    try {
      let deltaLink = "";
      let nextLink: string | null = `${GRAPH_API}/me/mailFolders/inbox/messages/delta?$select=id`;
      while (nextLink) {
        const resp = await fetch(nextLink, { headers: { "Authorization": `Bearer ${token}` } });
        if (!resp.ok) {
          const cause = await resp.text();
          this.logger.info("Outlook activation failed", { code: "emx.outlook.activation_failed", cause });
          return err({ kind: "provider_activation_failed", cause });
        }
        const page = await resp.json() as { "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
        nextLink = page["@odata.nextLink"] ?? null;
        if (page["@odata.deltaLink"]) deltaLink = page["@odata.deltaLink"];
      }

      const encryptionCert = await this.getEncryptionCertificateBase64();
      const expirationDateTime = DateTime.utc().plus({ hours: 23 }).toISO()!;
      const clientState = randomBytes(32).toString("base64url");

      const subResp = await fetch(`${GRAPH_API}/subscriptions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          changeType: "created",
          notificationUrl: WEBHOOK_URL,
          resource: "me/mailFolders/inbox/messages",
          includeResourceData: true,
          encryptionCertificate: encryptionCert,
          encryptionCertificateId: CERT_ID,
          expirationDateTime,
          clientState,
        }),
      });
      if (!subResp.ok) {
        const cause = await subResp.text();
        this.logger.info("Outlook activation failed", { code: "emx.outlook.activation_failed", cause });
        return err({ kind: "provider_activation_failed", cause });
      }
      const sub = await subResp.json() as { id: string; expirationDateTime: string };

      // Resolved here rather than trusted from the caller: the only mailbox identifier
      // available to a browser is the linked identity's provider-side user id, not an address.
      const addressResult = await this.fetchMailboxAddress(token);
      if (addressResult.isErr()) return err({ kind: "provider_activation_failed", cause: addressResult.error });

      this.logger.info("Outlook exchange activated", { code: "emx.outlook.activated" });
      return ok({
        syncCursor: deltaLink,
        expiresAt: sub.expirationDateTime,
        providerSubscriptionId: sub.id,
        emailAddress: addressResult.value,
      });
    } catch (e) {
      this.logger.info("Outlook activation failed", { code: "emx.outlook.activation_failed", cause: e });
      return err({ kind: "provider_activation_failed", cause: e });
    }
  }

  async renew(emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>> {
    const tokenResult = await this.resolveToken(emx);
    if (tokenResult.isErr()) {
      this.logger.error("Outlook renewal failed", { code: "emx.outlook.renewal_failed", emxId: emx.id, cause: tokenResult.error.cause });
      return err({ kind: "provider_renewal_failed", cause: tokenResult.error.cause });
    }
    const token = tokenResult.value;
    try {
      const expirationDateTime = DateTime.utc().plus({ hours: 23 }).toISO()!;
      const response = await fetch(`${GRAPH_API}/subscriptions/${emx.providerSubscriptionId}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expirationDateTime }),
      });
      if (!response.ok) {
        const cause = await response.text();
        this.logger.error("Outlook renewal failed", { code: "emx.outlook.renewal_failed", emxId: emx.id, cause });
        return err({ kind: "provider_renewal_failed", cause });
      }
      const data = await response.json() as { expirationDateTime: string };
      const expiresAt = data.expirationDateTime;

      // Update subscription expiry and next sync time (same value for Outlook)
      const updateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, { expiresAt, nextSyncTime: expiresAt });
      if (updateResult.isErr()) { this.logger.warn("Failed to update Outlook exchange expiry", { code: "emx.outlook.update_expiry_failed", emxId: emx.id, error: updateResult.error }); }

      this.logger.info("Outlook subscription renewed", { code: "emx.outlook.renewed", emxId: emx.id, expiresAt });
      return ok(undefined);
    } catch (e) {
      this.logger.error("Outlook renewal failed", { code: "emx.outlook.renewal_failed", emxId: emx.id, error: e });
      return err({ kind: "provider_renewal_failed", cause: e });
    }
  }

  async deactivate(emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    const tokenResult = await this.resolveToken(emx);
    if (tokenResult.isErr()) return err({ kind: "provider_deactivation_failed", cause: tokenResult.error.cause });
    const token = tokenResult.value;
    try {
      const response = await fetch(`${GRAPH_API}/subscriptions/${emx.providerSubscriptionId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 204) {
        const cause = await response.text();
        this.logger.info("Outlook deactivation failed", { code: "emx.outlook.deactivation_failed", cause });
        return err({ kind: "provider_deactivation_failed", cause });
      }
      this.logger.info("Outlook deactivated", { code: "emx.outlook.deactivated" });
      return ok(undefined);
    } catch (e) {
      this.logger.info("Outlook deactivation failed", { code: "emx.outlook.deactivation_failed", cause: e });
      return err({ kind: "provider_deactivation_failed", cause: e });
    }
  }

  async fetchMessage(providerMessageId: string, emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>> {
    const tokenResult = await this.resolveToken(emx);
    if (tokenResult.isErr()) return err({ kind: "provider_fetch_failed", cause: tokenResult.error.cause });
    const token = tokenResult.value;
    try {
      const metaResp = await fetch(`${GRAPH_API}/me/messages/${providerMessageId}?$select=receivedDateTime`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (metaResp.status === 401) return err({ kind: "provider_token_expired" });
      if (!metaResp.ok) return err({ kind: "provider_fetch_failed", cause: await metaResp.text() });
      const meta = await metaResp.json() as { receivedDateTime: string };

      const mimeResp = await fetch(`${GRAPH_API}/me/messages/${providerMessageId}/$value`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!mimeResp.ok) return err({ kind: "provider_fetch_failed", cause: await mimeResp.text() });
      const rawMime = new Uint8Array(await mimeResp.arrayBuffer());

      return ok({ rawMime, receivedAt: meta.receivedDateTime });
    } catch (e) {
      return err({ kind: "provider_fetch_failed", cause: e });
    }
  }

  /** Not part of ProviderAdapter — only `activate` needs it, to resolve the record's address. */
  private async fetchMailboxAddress(token: string): Promise<Result<string, ProviderFetchError>> {
    try {
      const response = await fetch(`${GRAPH_API}/me?$select=mail,userPrincipalName`, { headers: { "Authorization": `Bearer ${token}` } });
      if (response.status === 401) return err({ kind: "provider_token_expired" });
      if (!response.ok) return err({ kind: "provider_fetch_failed", cause: await response.text() });
      const data = await response.json() as { mail?: string | null; userPrincipalName?: string };
      // `mail` is the routable SMTP address; userPrincipalName is the sign-in name, which is
      // usually the same but is the only value present on some account types.
      const address = data.mail ?? data.userPrincipalName;
      if (!address) return err({ kind: "provider_fetch_failed", cause: "Graph user carried neither mail nor userPrincipalName" });
      return ok(address);
    } catch (e) {
      return err({ kind: "provider_fetch_failed", cause: e });
    }
  }

  /**
   * Sends through the user's own mailbox, which is the only way mail from their Outlook
   * address passes DMARC at the recipient. Graph files the sent copy in Sent Items.
   *
   * Two calls rather than the single-shot `/me/sendMail`: creating the draft first returns
   * `internetMessageId`, the RFC 5322 Message-ID that inbound replies will quote in
   * In-Reply-To. `/me/sendMail` returns an empty 202 and would leave us unable to thread
   * replies to what we just sent.
   *
   * Requires the `Mail.Send` scope on the linked connection.
   */
  async sendMessage(rawMime: Uint8Array, emx: ExternalMailExchange): Promise<Result<SendResult, ProviderSendError>> {
    const tokenResult = await this.resolveToken(emx);
    if (tokenResult.isErr()) return err({ kind: "provider_send_failed", cause: tokenResult.error.cause });
    const token = tokenResult.value;
    try {
      // Graph accepts a full MIME message as the request body when the content type says so.
      const createResp = await fetch(`${GRAPH_API}/me/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "text/plain" },
        body: Buffer.from(rawMime).toString("base64"),
      });

      if (createResp.status === 401) return err({ kind: "provider_token_expired" });
      if (!createResp.ok) {
        const cause = await createResp.text();
        if (createResp.status === 403) {
          this.logger.error("Outlook send rejected — connection is missing the Mail.Send scope. The user must re-link their Microsoft identity to grant it.", { code: "emx.outlook.send_scope_missing", emxId: emx.id, cause });
          return err({ kind: "provider_send_scope_missing", cause });
        }
        if (createResp.status < 500) {
          this.logger.warn("Outlook draft creation rejected", { code: "emx.outlook.send_rejected", emxId: emx.id, status: createResp.status, cause });
          return err({ kind: "provider_send_rejected", cause });
        }
        return err({ kind: "provider_send_failed", cause });
      }

      const draft = await createResp.json() as { id: string; internetMessageId?: string };

      const sendResp = await fetch(`${GRAPH_API}/me/messages/${draft.id}/send`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
      });

      if (!sendResp.ok && sendResp.status !== 202 && sendResp.status !== 204) {
        const cause = await sendResp.text();
        if (sendResp.status === 401) return err({ kind: "provider_token_expired" });
        if (sendResp.status === 403) {
          this.logger.error("Outlook send rejected — connection is missing the Mail.Send scope. The user must re-link their Microsoft identity to grant it.", { code: "emx.outlook.send_scope_missing", emxId: emx.id, cause });
          return err({ kind: "provider_send_scope_missing", cause });
        }
        if (sendResp.status < 500) {
          this.logger.warn("Outlook send rejected", { code: "emx.outlook.send_rejected", emxId: emx.id, status: sendResp.status, cause });
          return err({ kind: "provider_send_rejected", cause });
        }
        return err({ kind: "provider_send_failed", cause });
      }

      const messageId = draft.internetMessageId ? extractMsgId(draft.internetMessageId) : null;
      this.logger.info("Outlook send succeeded", { code: "emx.outlook.send_success", emxId: emx.id, providerMessageId: draft.id });
      return ok({ providerMessageId: draft.id, ...(messageId ? { messageId } : {}) });
    } catch (e) {
      return err({ kind: "provider_send_failed", cause: e });
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook handler
  // ---------------------------------------------------------------------------

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

    // 4. Process each notification in value[] where changeType === "created". Graph batches
    // notifications for delivery efficiency at the delivery-worker level, not per-subscription —
    // a single call's value[] can legitimately carry notifications for several different
    // subscriptions (mailboxes) if their changes landed around the same time, so nothing below
    // may assume there's only one exchange involved.
    const notifications = body.value ?? [];
    const messageEntries: Array<{ id: string; payload: unknown }> = [];
    const touchedExchanges = new Map<string, { accountId: string; id: string }>();

    for (const notification of notifications) {
      if (notification.changeType !== "created") continue;

      const resourceParts = notification.resource.split("/");
      const providerMessageId = notification.resourceData?.id ?? resourceParts[resourceParts.length - 1];

      if (!providerMessageId) {
        this.logger.warn("Outlook webhook: cannot extract message ID", { code: "emx.outlook.no_message_id", resource: notification.resource });
        continue;
      }

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

      touchedExchanges.set(emx.id, { accountId: emx.accountId, id: emx.id });
      messageEntries.push({
        id: `outlook-${messageEntries.length}`,
        payload: { source: "outlook", providerMessageId, emxId: emx.id, accountId: emx.accountId },
      });
    }

    const batchResult = await this.signalQueue.sendBatch("emx_inbound", messageEntries);
    if (batchResult.isErr()) {
      this.logger.error("Outlook webhook: failed to enqueue emx_inbound batch", { code: "emx.outlook.batch_failed", count: messageEntries.length, error: batchResult.error });
      return c.json({ error: "Internal Server Error" }, 500);
    }

    // lastSyncAt reflects "last time a push notification was actually processed" — renew()
    // only extends the subscription, it never observes mail, so this webhook is the only place
    // Outlook's sync activity is real. Set unconditionally, same as IMAP/JMAP polling, for every
    // distinct exchange this call touched — writes are independent, so run them concurrently
    // rather than one at a time.
    const now = DateTime.utc().toISO()!;
    await Promise.all(Array.from(touchedExchanges.values(), async (emx) => {
      const syncUpdateResult = await this.db.updateExternalExchange(emx.accountId, emx.id, { lastSyncAt: now });
      if (syncUpdateResult.isErr()) { this.logger.warn("Failed to update Outlook lastSyncAt after webhook", { code: "emx.outlook.webhook_sync_update_failed", emxId: emx.id, error: syncUpdateResult.error }); }
    }));

    // 5. Return 202 — Graph expects fast response
    return c.json({}, 202);
  }
}
