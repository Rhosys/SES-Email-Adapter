# Requirements Document

## Introduction

Add a standards-compliant JMAP (JSON Meta Application Protocol) server surface — RFC 8620 (Core), RFC 8621 (Mail), and RFC 9404 (Blob Management) — alongside the existing REST + WebSocket API, so third-party JMAP clients (Apple Mail, future Thunderbird builds, JMAP libraries/tools) can read and send an account's mail directly. The JMAP surface is a read/write translation layer over the existing Account/Alias/Domain/Thread/Signal/Label data model — no new canonical storage, no new sync infrastructure. Authentication is OAuth2 (Authorization Code + PKCE) via the existing Authress identity provider, using Authress's own `/authorize`/`/token` endpoints directly (no proxy routes on our side); authorization is a new per-method-call layer because JMAP batches multiple operations (potentially across accounts) into a single HTTP request, which the existing one-check-per-route pattern cannot express. Pulling mail in from third-party services (Gmail, Outlook/Graph, other JMAP servers) is explicitly out of scope for this spec — see `TODO.md` for that deferred item.

## Glossary

- **JMAP_Session**: The discovery object returned by `GET /.well-known/jmap` (RFC 8620 §2) — advertises capabilities, the `accounts` map, `primaryAccounts`, and the `apiUrl`/`uploadUrl`/`downloadUrl`/`eventSourceUrl` endpoints.
- **Method_Call**: One `[name, args, methodCallId]` tuple inside a JMAP `Request`'s `methodCalls` array (RFC 8620 §3.2). A single HTTP request to `apiUrl` may contain multiple Method_Calls, each independently authorized.
- **Account**: The existing product `Account` entity (`src/types/index.ts`), exposed to JMAP as one entry in `JMAP_Session.accounts`. A user may have access to multiple Accounts (existing Authress access-record model).
- **Mailbox**: The JMAP Mail data type (RFC 8621 §2). Synthesized, not stored: one system Mailbox per `Thread.status` value plus one per `Label`.
- **Thread**: The JMAP Mail data type (RFC 8621 §3), backed 1:1 by the existing `Thread` entity (`ThreadDatabase`, `src/types/index.ts:568` — the product does not have a separate "Arc" entity; `Thread` is the actual type name).
- **Email**: The JMAP Mail data type (RFC 8621 §4), backed by the existing `Signal<EmailSignalData>` entity.
- **EmailSubmission**: The JMAP Mail data type (RFC 8621 §7) for outbound sending, backed by the existing draft→send flow (`DraftSendDispatcher`, the same state machine behind `POST /arcs/:arcId/signals/:id/send`: `draft` → `pending_send` → `sent`, with MX validation and an undo-window SQS delay).
- **Identity**: The JMAP Mail data type (RFC 8621 §6), backed by verified `Alias` + `Domain` pairs where `senderSetupComplete` is true.
- **State_Token**: The opaque string a JMAP client holds representing its last-known sync position for a data type; sent back as `sinceState` on `/changes` calls. Derived directly from `Thread.updatedAt`/`Signal.updatedAt` (see Requirement 8) — there is no separate change-log table.
- **BlobService**: A new shared service backing both JMAP's blob upload/download and the existing (not yet built) REST attachment-upload need (`TODO.md`), so the two don't end up with two parallel, hand-rolled attachment schemes.
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
4. THE server SHALL NOT expose proxy `/authorize`/`/token` endpoints of its own — JMAP clients are configured to use Authress's real OAuth endpoints directly, under the `jmap-client` Authress Application. Authress already is a full OAuth2 authorization server; nothing in OAuth2 requires it to be same-origin with the resource server (the same way Google's own APIs point clients at `accounts.google.com`, not the API's own domain).
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

1. THE server SHALL synthesize one system Mailbox per `ThreadStatus` value (`src/types/index.ts` `THREAD_STATUSES`: `active`, `archived`, `deleted`, `report_violation`): `active` → a Mailbox with `role: "inbox"`, `archived` → `role: "archive"`, `deleted` → `role: "trash"`, `report_violation` → `role: "junk"`. There is no `"snoozed"` Thread status in the current data model; if one is added later this requirement extends the same way.
2. THE server SHALL synthesize one additional Mailbox per account `Label`, with no standard `role`.
3. THE server SHALL compute Mailbox properties (`id, name, parentId, role, sortOrder, totalEmails, unreadEmails, totalThreads, unreadThreads, isSubscribed, myRights`) at read time from existing Thread/Label data — no new stored Mailbox schema.
4. THE server SHALL populate `Email.mailboxIds` with the set of every Mailbox (status-derived and label-derived) that Email's Thread currently belongs to, consistent with JMAP's documented multi-membership ("Gmail-style label") mailbox model.
5. THE server SHALL NOT require the Mailbox-synthesis strategy chosen here to remain fixed forever — since Mailboxes are a read-time projection, a future strategy change SHALL only require rewriting the translation functions (`Mailbox/get`, `Mailbox/changes`, `Email.mailboxIds` computation), not a data migration.

### Requirement 5: Thread and Email mapping

**User Story:** As a JMAP client, I want JMAP Threads and Emails to reflect this product's existing Thread/Signal conversation model, so that conversations group the same way they do in the product's own UI.

Note: this product's `Thread` entity (`src/types/index.ts:568`, backed by `ThreadDatabase`) already has the same name and the same purpose as the JMAP `Thread` data type (RFC 8621 §3) — this is a direct 1:1 mapping, not a translation between two differently-named concepts.

#### Acceptance Criteria

1. THE server SHALL map each existing `Thread` 1:1 to a JMAP `Thread`, with JMAP `Thread.emailIds` populated from the ordered `Signal` ids belonging to that product `Thread`.
2. THE server SHALL map each existing `Signal<EmailSignalData>` to a JMAP `Email`, populating `id, blobId, threadId, mailboxIds, keywords, size, receivedAt, headers, messageId, inReplyTo, references, sender, from, to, cc, bcc, replyTo, subject, sentAt, bodyStructure, bodyValues, textBody, htmlBody, attachments, hasAttachment, preview` from the Signal's existing fields.
3. THE server SHALL compute `Email.keywords` (e.g. `$seen`, `$flagged`) from the Signal's existing label/read-state fields at read time.
4. THE server SHALL NOT introduce a new grouping algorithm for threading — the existing Thread's `groupingKey` already satisfies JMAP's Thread requirements.

### Requirement 6: EmailSubmission and Identity

**User Story:** As a JMAP client, I want to send and reply to mail through JMAP using the same verified sending identities the product already manages, so that outbound mail follows the same domain-verification rules as the web app.

#### Acceptance Criteria

1. THE server SHALL expose one JMAP `Identity` per verified `Alias`+`Domain` pair where `Domain.senderSetupComplete` is true.
2. THE server SHALL NOT expose an `Identity` for a domain whose Tier 2 (sender) setup is incomplete, consistent with the existing reply-composer's domain-dropdown gating.
3. WHEN a JMAP client creates a draft `Email` (a `Signal` with `source: "user"`, `keywords` including `$draft`), THE server SHALL create it exactly as the existing compose/draft flow already does — same Signal fields, same `status: "draft"` — not a parallel draft representation.
4. WHEN a JMAP client issues an `EmailSubmission/set` create call referencing that draft Email's id, THE server SHALL invoke the exact same internal send logic already implemented for `POST /arcs/:arcId/signals/:id/send` — the same MX-validation step, the same `DraftSendDispatcher.dispatch()` call with the same undo-window SQS delay, and the same `draft` → `pending_send` → `sent` state machine (`.kiro/specs/draft-send-flow/design.md`) — not a new or parallel outbound-sending code path.
5. THE server SHALL surface `EmailSubmission` state (`sendInitiatedAt`, `sesMessageId`, `sendFailureReason`) from the same Signal fields the existing send flow already writes, per Requirement 8's Email `/changes` mechanism.

### Requirement 7: Shared blob/attachment storage (JMAP + REST)

**User Story:** As a JMAP client, I want to upload and download attachments using standard JMAP blob endpoints, so that attachment handling works the same way any RFC 8620/9404-compliant client expects. As the product's own web/mobile client, I want the same underlying storage used for compose-time attachment uploads, so we don't end up maintaining two parallel, hand-rolled attachment schemes.

Per PR review: `TODO.md` already has an unbuilt REST feature for this ("User attachment upload for outbound signals... `POST /accounts/:accountId/attachments` → presigned S3 PUT URL + `attachmentId`"). This requirement folds that into the same shared design rather than building JMAP's blob handling in isolation.

#### Acceptance Criteria

1. THE server SHALL implement a shared `BlobService` (`src/jmap/` or a new `src/blob/`) that both the JMAP blob endpoints and a new REST `POST /accounts/:accountId/attachments` endpoint call — one blob/attachment identifier scheme, one S3 bucket/prefix layout, one download path, used by both.
2. THE server SHALL expose `POST /jmap/upload/{accountId}` accepting a binary body directly (per RFC 8620 — JMAP's upload contract is bytes-through-the-server, not a presigned redirect) and returning `BlobUploadResponse` (`accountId, blobId, type, size`), storing via `BlobService`.
3. THE server SHALL expose `GET /jmap/download/{accountId}/{blobId}/{name}` with `type` as a query parameter, returning the blob's bytes via `BlobService`, reusing the existing `s3Client`/`emailBucket`/CDN plumbing already used by `ThreadsApi`.
4. THE server SHALL expose `POST /accounts/{accountId}/attachments` returning a presigned S3 PUT URL plus an identifier from the *same* `BlobService` id scheme as `blobId` above — satisfying the existing REST/UI need (drafts referencing an uploaded attachment) without a second, incompatible storage layout.
5. THE server SHALL reject an upload or download whose `accountId` fails the same per-call authorization check described in Requirement 3 (for the JMAP endpoints) or the existing REST authz pattern (for the new REST endpoint).
6. THE server SHALL apply TTL-based cleanup for unreferenced uploads, matching the existing `TODO.md` description of the REST feature this requirement absorbs.

### Requirement 8: State and incremental changes (derived from existing timestamps, no new log)

**User Story:** As a JMAP client, I want to fetch only what changed since my last sync, so that repeated syncs are cheap and I don't have to refetch the whole account every time.

Per PR review, this does **not** need a new parallel change-log table — `Thread` and `Signal` already carry the timestamps needed, once one small gap is closed (Requirement 8.2 below).

#### Acceptance Criteria

1. THE server SHALL derive Mailbox/Thread changes from the existing `Thread.updatedAt` field, queried per account, ordered by `updatedAt` — requiring one new GSI on `ThreadDatabase` (the existing `LASTACT#{status}#{lastSignalAt}#{id}` index is scoped per-status and ordered by `lastSignalAt`, not a flat per-account `updatedAt` ordering across all statuses).
2. THE server SHALL add an `updatedAt` field to `Signal`/`SignalBase` (`src/types/index.ts`) — currently absent, even though label reassignment and the draft→send state machine both mutate a Signal after creation — and bump it at those existing mutation points, plus add an analogous per-account `updatedAt`-ordered GSI for Signal, to derive Email changes the same way.
3. THE `state` string returned by `Foo/get` and the `oldState`/`newState` returned by `Foo/changes` SHALL be derived from the latest `updatedAt` value for that account+type (e.g. the timestamp itself, or timestamp+id for tie-breaking); its format SHALL be treated as opaque by clients (only equality/ordering matters, never parsed).
4. WHEN a client calls `Foo/changes(sinceState)`, THE server SHALL query Thread/Signal data for that account with `updatedAt > sinceState` and return the matching ids as `created` (if `createdAt` also falls after `sinceState`) or `updated` (otherwise), plus `newState`.
5. THE server SHALL NOT maintain a destroy/tombstone log. Justification: the only true removal of a Thread/Signal is DynamoDB TTL expiry, which only occurs after the account's configured retention window (months to years) — not a normal, fast-moving product action (`Thread.status: "deleted"` is a soft status, itself just another `updatedAt` bump, not a removal). A client's `sinceState` window is realistically always far shorter than a retention window. Stale references are instead handled reactively: THE server SHALL return an id in `Foo/get`'s `notFound` array when a client asks for an id that no longer exists, which is the mechanism RFC 8620 already defines for exactly this case — the `destroyed` array in `/changes` responses SHALL simply be empty in the current design; this is a deliberate simplification, not an oversight.
6. IF `sinceState` predates the oldest queryable data for that `accountId`+`dataType` (e.g. after the retention window has fully rolled past it), THEN THE server SHALL return a `cannotCalculateChanges` error, and the client SHALL perform a full resync — this is an explicitly supported, non-error-in-spirit outcome, not a failure state.

### Requirement 9: Push notifications — deferred, not part of this spec

Per PR review, JMAP push is deferred to a follow-up. It is not built in this pass. Reasoning: RFC 8620 §7.3's `eventSourceUrl` is Server-Sent-Events over plain HTTP — a fundamentally different transport from the API Gateway WebSocket connections this codebase already has wired up (an earlier draft of this spec incorrectly claimed the two could share infrastructure). Building genuine SSE would require new Lambda response-streaming infrastructure not used anywhere in this codebase today; the alternative, RFC 8887 "JMAP over WebSocket," would genuinely reuse the existing WebSocket infrastructure but is a distinct, larger protocol extension in its own right. JMAP push is optional — a client without it functions correctly by polling `Foo/changes` on an interval (Requirement 8), so there is no functional gap in v1, only an efficiency one. **Open implementation detail, not resolved here:** RFC 8620's Session object schema lists `eventSourceUrl` alongside `apiUrl`/`uploadUrl`/`downloadUrl` — whether it's strictly mandatory to include even when push isn't implemented, versus omittable, needs to be confirmed against the RFC text during Task 2 (session discovery) implementation; if mandatory, the field can point at a stub that accepts connections but never emits events, or returns a clear not-yet-supported response. Revisit building real push once there's a concrete need (a specific target client, real usage data) to justify the SSE-vs-WebSocket-over-JMAP tradeoff.

### Requirement 10: Multiple concurrent JMAP clients per account

**User Story:** As a user with more than one device, I want to connect multiple JMAP clients (e.g. phone and laptop) to the same account at the same time, so that each device stays independently in sync without interfering with the others.

#### Acceptance Criteria

1. THE server SHALL allow any number of distinct OAuth2 tokens — one per client login — to hold concurrent, independent access to the same account, using the existing Authress multi-session model (no new session-limiting mechanism).
2. THE server SHALL NOT track per-client sync position server-side — each client SHALL be responsible for remembering its own `sinceState` locally, per Requirement 8.
3. WHEN two clients attempt to modify the same object concurrently, THE server SHALL rely on JMAP Core's own `ifInState` optimistic-concurrency check on `Set` calls to detect the conflict and return `stateMismatch` to the losing caller — no additional locking mechanism SHALL be introduced.

(Push-specific multi-client behavior is not applicable — push is deferred per Requirement 9.)

## Out of Scope

Pulling mail in from third-party email services (Gmail, Outlook/Graph, other JMAP servers) via OAuth-connected sync connectors is explicitly out of scope for this spec. It is tracked as a deferred one-line item in `TODO.md` and will receive its own requirements/design/tasks spec when prioritized.
