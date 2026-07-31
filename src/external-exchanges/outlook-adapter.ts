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

export class OutlookAdapter implements ProviderAdapter {
  // TODO: activate() does two things:
  //
  // 1. Initial delta query to establish sync cursor:
  //    GET https://graph.microsoft.com/v1.0/users/me/mailFolders/inbox/messages/delta
  //    Paginate to final page → extract @odata.deltaLink (this becomes syncCursor)
  //
  // 2. Create Graph subscription:
  //    POST https://graph.microsoft.com/v1.0/subscriptions
  //    Body: {
  //      changeType: "created",
  //      notificationUrl: "https://api.email.rhosys.cloud/api/external-exchanges/outlook/target",
  //      resource: "me/mailFolders/inbox/messages",
  //      includeResourceData: true,               // REQUIRED for JWT verification tokens
  //      encryptionCertificate: <base64 pub PEM>, // REQUIRED when includeResourceData: true
  //      encryptionCertificateId: "numaeel-graph-v1",
  //      expirationDateTime: <now + 23h ISO 8601>, // REQUIRED, max 24h for messages with resource data
  //      clientState: <random 32 bytes base64url>
  //    }
  //    Response: { id: string, expirationDateTime: string }
  //
  // → ActivationResult { syncCursor: deltaLink, expiresAt: expirationDateTime, providerSubscriptionId: subscription.id }
  async activate(_token: string, _emx: ExternalMailExchange): Promise<Result<ActivationResult, ProviderActivationError>> {
    return err({ kind: "provider_activation_failed", cause: "outlook_not_configured" });
  }

  // TODO: renew() extends the subscription expiration:
  //    PATCH https://graph.microsoft.com/v1.0/subscriptions/{providerSubscriptionId}
  //    Body: { expirationDateTime: <now + 23h ISO 8601> }
  //    Response: { id: string, expirationDateTime: string }
  //    expirationDateTime is REQUIRED and max 24h for messages with includeResourceData: true
  //
  // → RenewalResult { expiresAt: new expirationDateTime }
  async renew(_token: string, _emx: ExternalMailExchange): Promise<Result<RenewalResult, ProviderRenewalError>> {
    return err({ kind: "provider_renewal_failed", cause: "outlook_not_configured" });
  }

  // TODO: deactivate() deletes the Graph subscription:
  //    DELETE https://graph.microsoft.com/v1.0/subscriptions/{providerSubscriptionId}
  //    Response: 204 No Content
  async deactivate(_token: string, _emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>> {
    return err({ kind: "provider_deactivation_failed", cause: "outlook_not_configured" });
  }

  // TODO: fetchMessage() gets raw MIME:
  //    GET https://graph.microsoft.com/v1.0/me/messages/{providerMessageId}/$value
  //    Response: raw MIME stream (application/octet-stream)
  //    Also need receivedAt: GET /me/messages/{id}?$select=receivedDateTime
  //
  // → RawMimeResult { rawMime: Uint8Array from stream, receivedAt: ISO from receivedDateTime }
  async fetchMessage(_token: string, _providerMessageId: string): Promise<Result<RawMimeResult, ProviderFetchError>> {
    return err({ kind: "provider_fetch_failed", cause: "outlook_not_configured" });
  }
}
