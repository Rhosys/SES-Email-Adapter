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
  getProviderToken: (connectionUserId: string, connectionId: string) => Promise<string>;
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
  // ProviderAdapter methods
  // ---------------------------------------------------------------------------

  async activate(token: string, _emx: ExternalMailExchange): Promise<Result<ActivationResult, ProviderActivationError>> {
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

      this.logger.info("Outlook exchange activated", { code: "emx.outlook.activated", emxId: _emx.id });
      return ok({
        syncCursor: deltaLink,
        expiresAt: sub.expirationDateTime,
        providerSubscriptionId: sub.id,
      });
    } catch (e) {
      this.logger.info("Outlook activation failed", { code: "emx.outlook.activation_failed", cause: e });
      return err({ kind: "provider_activation_failed", cause: e });
    }
  }

  async renew(token: string, emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>> {
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
      await this.db.updateExternalExchange(emx.accountId, emx.id, { expiresAt, nextSyncTime: expiresAt });

      this.logger.info("Outlook subscription renewed", { code: "emx.outlook.renewed", emxId: emx.id, expiresAt });
      return ok(undefined);
    } catch (e) {
      this.logger.error("Outlook renewal failed", { code: "emx.outlook.renewal_failed", emxId: emx.id, error: e });
      return err({ kind: "provider_renewal_failed", cause: e });
    }
  }

  async deactivate(token: string, emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
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

  async fetchMessage(token: string, providerMessageId: string, _emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>> {
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
  async sendMessage(token: string, rawMime: Uint8Array, emx: ExternalMailExchange): Promise<Result<SendResult, ProviderSendError>> {
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

    // 4. Process each notification in value[] where changeType === "created"
    const notifications = body.value ?? [];
    const messageEntries: Array<{ id: string; payload: unknown }> = [];

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

    // 5. Return 202 — Graph expects fast response
    return c.json({}, 202);
  }
}
