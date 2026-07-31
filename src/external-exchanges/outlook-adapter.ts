import { readFile } from "node:fs/promises";
import { createPublicKey, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
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
import { DateTime } from "luxon";

const GRAPH_API = "https://graph.microsoft.com/v1.0";
const WEBHOOK_URL = "https://api.email.rhosys.cloud/api/external-exchanges/outlook/target";
const SECRETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "secrets");
const CERT_ID = "numaeel-graph-v1";

export class OutlookAdapter implements ProviderAdapter {
  private publicKeyBase64Cache: string | null = null;
  private readonly kms = new KMSClient({});

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

  async activate(token: string, _emx: ExternalMailExchange): Promise<Result<ActivationResult, ProviderActivationError>> {
    try {
      let deltaLink = "";
      let nextLink: string | null = `${GRAPH_API}/me/mailFolders/inbox/messages/delta?$select=id`;
      while (nextLink) {
        const resp = await fetch(nextLink, { headers: { "Authorization": `Bearer ${token}` } });
        if (!resp.ok) return err({ kind: "provider_activation_failed", cause: await resp.text() });
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
      if (!subResp.ok) return err({ kind: "provider_activation_failed", cause: await subResp.text() });
      const sub = await subResp.json() as { id: string; expirationDateTime: string };

      return ok({
        syncCursor: deltaLink,
        expiresAt: sub.expirationDateTime,
        providerSubscriptionId: sub.id,
      });
    } catch (e) {
      return err({ kind: "provider_activation_failed", cause: e });
    }
  }

  async renew(token: string, emx: ExternalMailExchange): Promise<Result<RenewalResult, ProviderRenewalError>> {
    try {
      const expirationDateTime = DateTime.utc().plus({ hours: 23 }).toISO()!;
      const response = await fetch(`${GRAPH_API}/subscriptions/${emx.providerSubscriptionId}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expirationDateTime }),
      });
      if (!response.ok) return err({ kind: "provider_renewal_failed", cause: await response.text() });
      const data = await response.json() as { expirationDateTime: string };
      return ok({ expiresAt: data.expirationDateTime });
    } catch (e) {
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
        return err({ kind: "provider_deactivation_failed", cause: await response.text() });
      }
      return ok(undefined);
    } catch (e) {
      return err({ kind: "provider_deactivation_failed", cause: e });
    }
  }

  async fetchMessage(token: string, providerMessageId: string): Promise<Result<RawMimeResult, ProviderFetchError>> {
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
}
