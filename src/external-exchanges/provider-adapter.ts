import type { Result } from "../errors.js"
import type { ExternalMailExchange } from "../types/index.js"

// ---------------------------------------------------------------------------
// Polling interval — how far in the future the next sync is scheduled.
// Force-loads on page open/refresh bypass this; it only governs background polling.
// ---------------------------------------------------------------------------
export const POLL_INTERVAL_MINUTES = 60;

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
  /** Opaque provider-issued cursor (Gmail historyId, Outlook deltaLink, JMAP queryState). */
  syncCursor?: string
  /** Structured sync-progress state for platforms whose cursor isn't a single opaque token (IMAP). */
  syncState?: Record<string, unknown>
  expiresAt: string
  providerSubscriptionId: string
  /**
   * The mailbox address, verified by the adapter itself — resolved from the provider for
   * OAuth platforms (Gmail, Outlook), read off the caller-supplied config for IMAP/JMAP. Never
   * trust a caller-supplied address instead: for OAuth in particular, the only mailbox
   * identifier available to a browser is the linked identity's provider-side user id (a
   * numeric subject for Google), and accepting a claimed address would let a caller point an
   * exchange — and the alias that routes its outbound mail — at a mailbox it does not own.
   */
  emailAddress: string
}

/**
 * Coordinates needed to obtain provider credentials for a *new* connection, before an
 * exchange record exists to read them back from. Only OAuth adapters (Gmail, Outlook) use
 * this; IMAP/JMAP authenticate with the config the caller supplied directly.
 */
export interface ActivationIdentity {
  userId: string
  connectionId: string
  connectionUserId: string
}

export interface RawMimeResult {
  rawMime: Uint8Array
  receivedAt: string
}

/**
 * The linked-identity coordinates a provider token lookup needs, read off an exchange record.
 *
 * Returns null when the exchange predates connection tracking (or is IMAP/JMAP, which has no
 * linked identity at all). Callers treat null as "this exchange cannot be used until the user
 * reconnects it" — there is deliberately no fallback to deriving the connection from the
 * platform, because a derived value is a guess about someone else's configuration.
 */
export function exchangeCredentials(emx: ExternalMailExchange): { userId: string; connectionId: string; connectionUserId: string } | null {
  if (!emx.userId || !emx.connectionId || !emx.connectionUserId) return null
  return { userId: emx.userId, connectionId: emx.connectionId, connectionUserId: emx.connectionUserId }
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
  /**
   * Verifies the mailbox is reachable and returns what the exchange record needs to store.
   *
   * Credential resolution is the adapter's job, not the caller's: this is the same call every
   * later renew/fetch/send makes, so it is the honest test of whether the connection will
   * work. `identity` supplies the coordinates for that first credential fetch — the exchange
   * doesn't exist yet, so there is nothing on it to read them back from. IMAP/JMAP ignore it;
   * they authenticate from the config already on `emx`.
   */
  activate(emx: ExternalMailExchange, identity?: ActivationIdentity): Promise<Result<ActivationResult, ProviderActivationError>>
  /** Every method past `activate` resolves its own credentials from `emx` — see `exchangeCredentials`. */
  renew(emx: ExternalMailExchange): Promise<Result<void, ProviderRenewalError>>
  deactivate(emx: ExternalMailExchange): Promise<Result<void, ProviderDeactivationError>>
  fetchMessage(providerMessageId: string, emx: ExternalMailExchange): Promise<Result<RawMimeResult, ProviderFetchError>>
  /**
   * Sends a fully-formed RFC 5322 message through the provider on the mailbox owner's behalf.
   *
   * Optional: only providers with a send API implement it (Gmail, Outlook). IMAP and JMAP
   * exchanges are receive-only here — IMAP has no send channel at all (that's SMTP) and JMAP
   * submission is a separate protocol surface. The send router treats an absent method as
   * "this exchange cannot send" and fails the send rather than silently falling back to SES,
   * which would emit unaligned mail from a domain we are not authorized for.
   */
  sendMessage?(rawMime: Uint8Array, emx: ExternalMailExchange): Promise<Result<SendResult, ProviderSendError>>
}
