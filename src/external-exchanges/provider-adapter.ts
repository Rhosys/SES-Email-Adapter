import type { Result } from "../errors.js"
import type { ExternalMailExchange } from "../types/index.js"

// ---------------------------------------------------------------------------
// Provider adapter errors — discriminated by `kind` field
// ---------------------------------------------------------------------------

export type ProviderActivationError = { kind: "provider_activation_failed"; cause: unknown }
export type ProviderRenewalError = { kind: "provider_renewal_failed"; cause: unknown }
export type ProviderDeactivationError = { kind: "provider_deactivation_failed"; cause: unknown }
export type ProviderFetchError =
  | { kind: "provider_fetch_failed"; cause: unknown }
  | { kind: "provider_message_not_found" }
  | { kind: "provider_token_expired" }

// ---------------------------------------------------------------------------
// Provider adapter result types
// ---------------------------------------------------------------------------

export interface ActivationResult {
  syncCursor: string
  expiresAt: string
  providerSubscriptionId: string
}

export interface RawMimeResult {
  rawMime: Uint8Array
  receivedAt: string
}

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  activate(token: string, emx: ExternalMailExchange): Promise<Result<ActivationResult, ProviderActivationError>>
  renew(token: string, emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>>
  deactivate(token: string, emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>>
  fetchMessage(token: string, providerMessageId: string, emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>>
}
