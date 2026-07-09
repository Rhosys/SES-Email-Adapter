# Requirements Document

## Introduction

Add a standards-compliant JMAP (JSON Meta Application Protocol) server surface — RFC 8620 (Core), RFC 8621 (Mail), and RFC 9404 (Blob Management) — alongside the existing REST + WebSocket API, so third-party JMAP clients (Apple Mail, future Thunderbird builds, JMAP libraries/tools) can read and send an account's mail directly. The JMAP surface is a read/write translation layer over the existing Account/Alias/Domain/Arc/Signal/Label data model — no new canonical storage, no new sync infrastructure. Authentication is OAuth2 (Authorization Code + PKCE) via the existing Authress identity provider; authorization is a new per-method-call layer because JMAP batches multiple operations (potentially across accounts) into a single HTTP request, which the existing one-check-per-route pattern cannot express. Pulling mail in from third-party services (Gmail, Outlook/Graph, other JMAP servers) is explicitly out of scope for this spec — see `TODO.md` for that deferred item.

## Glossary

- **JMAP_Session**: The discovery object returned by `GET /.well-known/jmap` (RFC 8620 §2) — advertises capabilities, the `accounts` map, `primaryAccounts`, and the `apiUrl`/`uploadUrl`/`downloadUrl`/`eventSourceUrl` endpoints.
- **Method_Call**: One `[name, args, methodCallId]` tuple inside a JMAP `Request`'s `methodCalls` array (RFC 8620 §3.2). A single HTTP request to `apiUrl` may contain multiple Method_Calls, each independently authorized.
- **Account**: The existing product `Account` entity (`src/types/index.ts`), exposed to JMAP as one entry in `JMAP_Session.accounts`. A user may have access to multiple Accounts (existing Authress access-record model).
- **Mailbox**: The JMAP Mail data type (RFC 8621 §2). Synthesized, not stored: one system Mailbox per `Arc.status` value plus one per `Label`.
- **Thread**: The JMAP Mail data type (RFC 8621 §3), backed 1:1 by the existing `Arc` entity (`ThreadDatabase`).
- **Email**: The JMAP Mail data type (RFC 8621 §4), backed by the existing `Signal<EmailSignalData>` entity.
- **EmailSubmission**: The JMAP Mail data type (RFC 8621 §7) for outbound sending, backed by the existing send/reply flow (`EmailService`, `ThreadsApi`).
- **Identity**: The JMAP Mail data type (RFC 8621 §6), backed by verified `Alias` + `Domain` pairs where `senderSetupComplete` is true.
- **Change_Log**: A new append-only DynamoDB log of `{accountId, dataType, objectId, changeType, sequence}` entries, one shared log per `accountId`+`dataType`, that backs JMAP `state` strings and `/changes` method responses.
- **State_Token**: The opaque string a JMAP client holds representing its last-known position in a Change_Log; sent back as `sinceState` on `/changes` calls.
- **AuthressAuthService**: The existing JWT verification service (`src/api/authress-auth.ts`) used by the REST API; reused unchanged for JMAP.
- **AccessService**: The existing Authress-backed permission-check service (`checkAccess`) wrapped by `AuthorizationMiddleware` (`src/api/authorization-middleware.ts`); reused per-Method_Call for JMAP instead of per-HTTP-route.

## Requirements

### Requirement 1: JMAP session discovery

**User Story:** As a JMAP client, I want to discover this server's capabilities and endpoints from a well-known URL, so that I can connect without out-of-band configuration beyond a hostname.

#### Acceptance Criteria

1. WHEN a client sends `GET /.well-known/jmap` with a valid Authress bearer token, THE server SHALL return a JMAP_Session object containing `capabilities`, `accounts`, `primaryAccounts`, `username`, `apiUrl`, `uploadUrl`, `downloadUrl`, `eventSourceUrl`, and `state`.
2. THE `accounts` map SHALL contain one entry for every Account the authenticated user has access to, per the existing Authress access-record model — not just a single account.
3. THE `capabilities` object SHALL advertise `urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail`, and `urn:ietf:params:jmap:blob`.
4. THE `uploadUrl` SHALL be a URI Template (RFC 6570) containing the variable `accountId`.
5. THE `downloadUrl` SHALL be a URI Template containing the variables `accountId`, `blobId`, `type`, and `name`.
6. THE `eventSourceUrl` SHALL be a URI Template containing the variables `types`, `closeafter`, and `ping`, and SHALL NOT contain an `accountId` variable.
7. THE `apiUrl` SHALL NOT contain any URI Template variables — it is a single fixed endpoint for the whole session, not scoped to one account per RFC 8620 §2.
8. IF the Authorization header is missing or the token fails verification, THEN THE server SHALL return 401 without a JMAP_Session body.

### Requirement 2: OAuth2 authentication, no API keys

**User Story:** As a security-conscious operator, I want JMAP clients to authenticate the same way the web app does, so that there is exactly one credential model to reason about and revoke.

#### Acceptance Criteria

1. THE server SHALL accept only Authress-issued bearer tokens obtained via OAuth2 Authorization Code + PKCE (RFC 7636) — no API keys, no app-passwords, no Basic auth credential scheme.
2. THE server SHALL reuse the existing AuthressAuthService.verify() method unchanged for JMAP token verification — no new token-verification code path SHALL be introduced.
3. WHEN a token verifies successfully, THE server SHALL treat the resulting `userId` as identifying the authenticated user, not a single account, consistent with the existing REST API's auth model.
4. THE server SHALL expose `GET /jmap/oauth/authorize` and `POST /jmap/oauth/token` endpoints that delegate to Authress's existing hosted OAuth flow (mirroring how the web app already delegates login to Authress), rather than implementing a new authorization server from scratch.
5. IF a JMAP client presents any credential other than a valid Authress bearer token, THEN THE server SHALL reject the request with 401.

### Requirement 3: Per-method-call authorization

**User Story:** As an account owner, I want every JMAP operation checked against my actual permissions on the specific account it targets, so that a single HTTP request cannot bypass authorization by batching calls across accounts.

#### Acceptance Criteria

1. WHEN `POST /jmap/api` receives a Request containing one or more Method_Calls, THE server SHALL authorize each Method_Call individually before executing it, using the `accountId` present in that Method_Call's own arguments — not a single accountId derived from the HTTP request's URL path.
2. THE server SHALL map each JMAP method name (e.g. `Email/get`, `Mailbox/set`, `EmailSubmission/set`) to an existing Authress permission string already used by the REST API (e.g. `threads:read`, `threads:write`).
3. THE server SHALL call the existing AccessService.checkAccess(userId, resourceUri, permission) primitive for each Method_Call's authorization check — the same primitive AuthorizationMiddleware already wraps for REST routes.
4. IF a Method_Call's authorization check fails, THEN THE server SHALL return a JMAP-level `error` result for that Method_Call only (per RFC 8620 §3.5.1), and SHALL continue processing the remaining Method_Calls in the same Request.
5. THE server SHALL NOT reject an entire HTTP request with a single top-level 403 when only some Method_Calls within it fail authorization.

### Requirement 4: Mailbox mapping

**User Story:** As a JMAP client, I want to see Mailboxes that reflect how this product actually organizes mail (status + labels), so that I can browse and file mail without the server forcing a folder model it doesn't otherwise use.

#### Acceptance Criteria

1. THE server SHALL synthesize one system Mailbox per `Arc.status` value: `active` → a Mailbox with `role: "inbox"`, `archived` → `role: "archive"`, `snoozed` → a Mailbox with no standard role, `deleted` → `role: "trash"`.
2. THE server SHALL synthesize one additional Mailbox per account `Label`, with no standard `role`.
3. THE server SHALL compute Mailbox properties (`id, name, parentId, role, sortOrder, totalEmails, unreadEmails, totalThreads, unreadThreads, isSubscribed, myRights`) at read time from existing Arc/Label data — no new stored Mailbox schema.
4. THE server SHALL populate `Email.mailboxIds` with the set of every Mailbox (status-derived and label-derived) that Email's Arc currently belongs to, consistent with JMAP's documented multi-membership ("Gmail-style label") mailbox model.
5. THE server SHALL NOT require the Mailbox-synthesis strategy chosen here to remain fixed forever — since Mailboxes are a read-time projection, a future strategy change SHALL only require rewriting the translation functions (`Mailbox/get`, `Mailbox/changes`, `Email.mailboxIds` computation), not a data migration.

### Requirement 5: Thread and Email mapping

**User Story:** As a JMAP client, I want Threads and Emails to reflect this product's existing Arc/Signal conversation model, so that conversations group the same way they do in the product's own UI.

#### Acceptance Criteria

1. THE server SHALL map each existing `Arc` 1:1 to a JMAP `Thread`, with `Thread.emailIds` populated from the ordered `Signal` ids belonging to that Arc.
2. THE server SHALL map each existing `Signal<EmailSignalData>` to a JMAP `Email`, populating `id, blobId, threadId, mailboxIds, keywords, size, receivedAt, headers, messageId, inReplyTo, references, sender, from, to, cc, bcc, replyTo, subject, sentAt, bodyStructure, bodyValues, textBody, htmlBody, attachments, hasAttachment, preview` from the Signal's existing fields.
3. THE server SHALL compute `Email.keywords` (e.g. `$seen`, `$flagged`) from the Signal's existing label/read-state fields at read time.
4. THE server SHALL NOT introduce a new grouping algorithm for threading — the existing Arc grouping key already satisfies JMAP's Thread requirements.

### Requirement 6: EmailSubmission and Identity

**User Story:** As a JMAP client, I want to send and reply to mail through JMAP using the same verified sending identities the product already manages, so that outbound mail follows the same domain-verification rules as the web app.

#### Acceptance Criteria

1. THE server SHALL expose one JMAP `Identity` per verified `Alias`+`Domain` pair where `Domain.senderSetupComplete` is true.
2. THE server SHALL NOT expose an `Identity` for a domain whose Tier 2 (sender) setup is incomplete, consistent with the existing reply-composer's domain-dropdown gating.
3. WHEN a JMAP client issues an `EmailSubmission/set` create call, THE server SHALL route it through the existing send/reply flow (`EmailService`, `ThreadsApi` send handler) rather than a new outbound-sending code path.

### Requirement 7: Blob upload and download

**User Story:** As a JMAP client, I want to upload and download attachments using standard JMAP blob endpoints, so that attachment handling works the same way any RFC 8620/9404-compliant client expects.

#### Acceptance Criteria

1. THE server SHALL expose `POST /jmap/upload/{accountId}` accepting a binary body and returning `BlobUploadResponse` (`accountId, blobId, type, size`).
2. THE server SHALL expose `GET /jmap/download/{accountId}/{blobId}/{name}` with `type` as a query parameter, returning the blob's bytes.
3. THE server SHALL implement both endpoints on top of the existing `s3Client`/`emailBucket`/CDN plumbing already used by `ThreadsApi`, not a new storage path.
4. THE server SHALL reject an upload or download whose `accountId` fails the same per-call authorization check described in Requirement 3.

### Requirement 8: State and incremental changes

**User Story:** As a JMAP client, I want to fetch only what changed since my last sync, so that repeated syncs are cheap and I don't have to refetch the whole account every time.

#### Acceptance Criteria

1. THE server SHALL maintain a Change_Log entry `{accountId, dataType, objectId, changeType, sequence}` for every create/update/destroy of a Mailbox, Thread, or Email, written at the existing `ThreadDatabase`/`AccountDatabase` mutation points.
2. THE server SHALL generate `sequence` via an atomic per-`accountId`+`dataType` counter — one shared counter and one shared log per account+type, not one per client.
3. THE `state` string returned by `Foo/get` and the `oldState`/`newState` returned by `Foo/changes` SHALL be the sequence number rendered as a string; its format SHALL be treated as opaque by clients (only equality/ordering matters, never parsed).
4. WHEN a client calls `Foo/changes(sinceState)`, THE server SHALL query the Change_Log for entries with `sequence > sinceState` for that `accountId`+`dataType`, collapse multiple log rows for the same `objectId` to their net effect, and return the result as `created`/`updated`/`destroyed` id lists plus `newState`.
5. IF `sinceState` predates the oldest retained Change_Log entry for that `accountId`+`dataType`, THEN THE server SHALL return a `cannotCalculateChanges` error, and the client SHALL perform a full resync — this is an explicitly supported, non-error-in-spirit outcome, not a failure state.
6. Change_Log entries SHALL carry a TTL; retention duration SHALL be chosen so that clients following typical poll/reconnect cadences rarely hit Requirement 8.5.

### Requirement 9: Push notifications

**User Story:** As a JMAP client, I want to be notified in near-real-time when account data changes, so that I don't have to poll `/changes` on a fixed interval.

#### Acceptance Criteria

1. THE server SHALL expose `GET /jmap/eventsource` implementing RFC 8620 §7.3 push, accepting `types`, `closeafter`, and `ping` query parameters.
2. THE server SHALL deliver `StateChange` events whose `changed` map covers every account the connecting session has access to, not a single hardcoded account.
3. THE server SHALL reuse the existing WebSocket connection infrastructure (`WsConnection` entity, `src/types/index.ts`) already used for the product's own real-time signal push, rather than building a second, parallel push mechanism.

### Requirement 10: Multiple concurrent JMAP clients per account

**User Story:** As a user with more than one device, I want to connect multiple JMAP clients (e.g. phone and laptop) to the same account at the same time, so that each device stays independently in sync without interfering with the others.

#### Acceptance Criteria

1. THE server SHALL allow any number of distinct OAuth2 tokens — one per client login — to hold concurrent, independent access to the same account, using the existing Authress multi-session model (no new session-limiting mechanism).
2. THE server SHALL NOT track per-client sync position server-side — each client SHALL be responsible for remembering its own `sinceState` locally, per Requirement 8.
3. THE server SHALL support multiple simultaneous push connections (Requirement 9) for the same account, consistent with the existing `WsConnection` model already supporting a set of connections per account, not a singleton.
4. WHEN two clients attempt to modify the same object concurrently, THE server SHALL rely on JMAP Core's own `ifInState` optimistic-concurrency check on `Set` calls to detect the conflict and return `stateMismatch` to the losing caller — no additional locking mechanism SHALL be introduced.

## Out of Scope

Pulling mail in from third-party email services (Gmail, Outlook/Graph, other JMAP servers) via OAuth-connected sync connectors is explicitly out of scope for this spec. It is tracked as a deferred one-line item in `TODO.md` and will receive its own requirements/design/tasks spec when prioritized.
