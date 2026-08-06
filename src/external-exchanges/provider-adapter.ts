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

export type ProviderSendError =
  | { kind: "provider_send_failed"; cause: unknown }
  | { kind: "provider_token_expired" }
  // The connection was linked without the provider's send scope (gmail.send / Mail.Send).
  // Not retryable — the user has to re-link the identity and re-consent.
  | { kind: "provider_send_scope_missing"; cause: unknown }
  // The message was rejected on its own terms (bad recipient, size, provider policy).
  // Retrying the identical payload will fail identically.
  | { kind: "provider_send_rejected"; cause: unknown }

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

export interface SendResult {
  /** Provider-assigned id for the sent message (Gmail message id, Graph request id). */
  providerMessageId: string
  /** RFC 5322 Message-ID of the sent message, when the provider discloses it. */
  messageId?: string
}

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  activate(token: string, emx: ExternalMailExchange): Promise<Result<ActivationResult, ProviderActivationError>>
  renew(token: string, emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>>
  deactivate(token: string, emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>>
  fetchMessage(token: string, providerMessageId: string, emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>>
  /**
   * Sends a fully-formed RFC 5322 message through the provider on the mailbox owner's behalf.
   *
   * Optional: only providers with a send API implement it (Gmail, Outlook). IMAP and JMAP
   * exchanges are receive-only here — IMAP has no send channel at all (that's SMTP) and JMAP
   * submission is a separate protocol surface. The send router treats an absent method as
   * "this exchange cannot send" and fails the send rather than silently falling back to SES,
   * which would emit unaligned mail from a domain we are not authorized for.
   */
  sendMessage?(token: string, rawMime: Uint8Array, emx: ExternalMailExchange): Promise<Result<SendResult, ProviderSendError>>
  /**
   * Asks the provider which mailbox this token belongs to.
   *
   * The address has to come from the provider, not from the client: the only mailbox
   * identifier an OAuth login exposes to the browser is the linked identity's provider-side
   * user id, which for Google is a numeric subject, not an email address. Everything
   * downstream is keyed on the real address — the alias, the alias→exchange link that routes
   * outbound mail, and the Gmail webhook's mailbox match — so a guess that happens to look
   * like an id silently breaks all three.
   *
   * Optional: IMAP and JMAP already know their own address from the configured username.
   */
  fetchMailboxAddress?(token: string): Promise<Result<string, ProviderFetchError>>
}
