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

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUBSUB_TOPIC = "projects/numaeel-mail/topics/gmail-notifications";

export class GmailAdapter implements ProviderAdapter {
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
}
