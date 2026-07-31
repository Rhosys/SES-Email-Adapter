import { err } from "../errors.js";
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

export class GmailAdapter implements ProviderAdapter {
  // TODO: activate() calls Gmail users.watch():
  // POST https://gmail.googleapis.com/gmail/v1/users/me/watch
  // Body: { topicName: "projects/numaeel-mail/topics/gmail-notifications", labelIds: ["INBOX"] }
  // Response: { historyId: string, expiration: string (millis since epoch) }
  // → ActivationResult { syncCursor: historyId, expiresAt: ISO from expiration, providerSubscriptionId: "watch" }
  async activate(_token: string, _emx: ExternalMailExchange): Promise<Result<ActivationResult, ProviderActivationError>> {
    return err({ kind: "provider_activation_failed", cause: "gmail_not_configured" });
  }

  // TODO: renew() calls Gmail users.watch() again (same as activate):
  // POST https://gmail.googleapis.com/gmail/v1/users/me/watch
  // Gmail watch is idempotent — calling it again extends the expiration.
  // Response: { historyId: string, expiration: string (millis since epoch) }
  // → RenewalResult { expiresAt: ISO from expiration }
  async renew(_token: string, _emx: ExternalMailExchange): Promise<Result<RenewalResult, ProviderRenewalError>> {
    return err({ kind: "provider_renewal_failed", cause: "gmail_not_configured" });
  }

  // TODO: deactivate() calls Gmail users.stop():
  // POST https://gmail.googleapis.com/gmail/v1/users/me/stop
  // Response: 204 No Content
  async deactivate(_token: string, _emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    return err({ kind: "provider_deactivation_failed", cause: "gmail_not_configured" });
  }

  // TODO: fetchMessage() calls Gmail messages.get with format=raw:
  // GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{providerMessageId}?format=raw
  // Response: { id, raw: string (base64url-encoded MIME), internalDate: string (millis since epoch) }
  // → RawMimeResult { rawMime: base64url-decoded Uint8Array, receivedAt: ISO from internalDate }
  async fetchMessage(_token: string, _providerMessageId: string): Promise<Result<RawMimeResult, ProviderFetchError>> {
    return err({ kind: "provider_fetch_failed", cause: "gmail_not_configured" });
  }
}
