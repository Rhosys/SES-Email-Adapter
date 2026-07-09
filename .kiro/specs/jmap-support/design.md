# Technical Design

## Overview

A new JMAP server surface (`GET /.well-known/jmap`, `POST /jmap/api`, `POST /jmap/upload/{accountId}`, `GET /jmap/download/{accountId}/{blobId}/{name}`, `GET /jmap/eventsource`) registered alongside the existing REST API in the same single Lambda (`src/api/app.ts`), following the same `createApp`/`helpers.route`/`helpers.authz` pattern every other `*Api.ts` module already uses (ADR `003-single-lambda-per-project.md`). The entire JMAP surface is a read/write translation layer over existing DynamoDB data (`Account`, `Alias`, `Domain`, `Arc`, `Signal`, `Label`) — no new canonical storage except a small append-only change log needed for `/changes`. Authentication reuses the existing Authress JWT verification unchanged; the one genuinely new mechanism is per-Method_Call authorization, because a single JMAP HTTP request can batch operations across multiple accounts and method types in ways the existing per-route `authz()` middleware cannot express.

## Auth: OAuth2 via Authress, no new verification path

JMAP clients authenticate with Authress-issued bearer tokens obtained via **Authorization Code + PKCE** (RFC 7636) — the flow RFC 8620 §3 recommends for public/non-confidential clients (no client secret storable on a desktop/mobile device), per RFC 8252 ("OAuth for Native Apps").

```
GET  /jmap/oauth/authorize   → redirects to Authress's existing hosted login UI
POST /jmap/oauth/token       → exchanges the authorization code for an Authress token
```

These are thin proxies to Authress's existing OAuth flow (the same one `@authress/login` already drives for the web app), registered under a distinct Authress Application (e.g. `jmap-client`) purely for client-visibility/audit in the Authress dashboard — **not** a second verification code path. Once a token is issued, `src/api/authress-auth.ts`'s `AuthressAuthService.verify()` validates it exactly as it validates web-app tokens today, because Authress tokens are equivalent regardless of which Application requested them. This yields `{userId}` — never `{accountId}` — matching the deliberate exclusion documented in `.kiro/specs/lambda-authorizer/design.md` (an authorizer response is cached per-token, so it must never encode request-specific data like accountId).

**Known compatibility caveat, accepted as a tradeoff:** several real-world JMAP clients (e.g. Apple Mail's native JMAP support) currently prefer Basic auth with an app-specific password over a live OAuth2 redirect, because generic/self-hosted JMAP servers aren't hardcoded into OS mail-app OAuth integrations the way Google/Microsoft/iCloud are. Going OAuth2-only trades broad day-one compatibility for a single, consistent credential model. Revisit if a specific target client turns out not to support it.

## Authorization: per-Method-Call, not per-route

Every REST route uses `helpers.authz(permission, resourceUri)` (`src/api/app.ts:131-139`, `src/api/authorization-middleware.ts`) — one `AccessService.checkAccess()` call per HTTP route match, with `accountId` extracted from a single URL path segment. JMAP's `POST /jmap/api` doesn't fit that shape: one HTTP request carries a `methodCalls` array, and each entry can name a *different* `accountId` in its own JSON args, and a different method entirely (`Email/get` vs. `Mailbox/set` vs. `EmailSubmission/set`).

New module `src/jmap/jmap-authz.ts`:

```typescript
async function checkMethodCallAccess(
  access: AccessService,
  userId: string,
  methodName: string,   // e.g. "Email/get"
  accountId: string,
): Promise<Result<void, AuthError>>
```

`JmapApi`'s dispatcher calls this once per Method_Call, *before* executing it, mapping the JMAP method name to the closest existing REST permission string (e.g. `Email/get` → `threads:read`, `Mailbox/set` → `threads:write`, `EmailSubmission/set` → the existing send permission). On failure, the dispatcher does **not** fail the whole HTTP request — it emits a JMAP-level `error` result for that Method_Call only (RFC 8620 §3.5.1 explicitly supports per-call errors within an otherwise-successful batch response) and continues processing the rest of `methodCalls`.

## Routes

All under `/jmap`, except the RFC-mandated well-known path:

| Route | Method | accountId placement | Notes |
|---|---|---|---|
| `/.well-known/jmap` | GET | n/a | Session object; registered before the global JWT middleware like `WellKnownApi`, since JMAP session discovery has its own auth story |
| `/jmap/api` | POST | **inside each Method_Call's JSON args**, never in the URL | Core `Request`/`Response`; RFC 8620 mandates no URI template variables on `apiUrl` — one flat endpoint serves every account a token can see |
| `/jmap/upload/{accountId}` | POST | path segment, **required by spec** | Blob upload; wraps existing `s3Client`/`emailBucket` |
| `/jmap/download/{accountId}/{blobId}/{name}` | GET | path segments, **required by spec** (`type` in query) | Blob download; wraps existing CDN plumbing already used by `ThreadsApi` |
| `/jmap/eventsource` | GET | **not present** — spec mandates `types`/`closeafter`/`ping` instead | Push; one stream reports changes across every account the session can see |
| `/jmap/oauth/authorize`, `/jmap/oauth/token` | GET / POST | n/a | OAuth2 proxy to Authress, see Auth section |

**Why `apiUrl` has no accountId segment:** RFC 8620's Session object is the only place route shapes are constrained at all — beyond the mandated URI template variables above, actual paths are our choice, since the client just follows what Session advertises. `uploadUrl`/`downloadUrl` are explicitly required to carry `{accountId}` (and `downloadUrl` also `{blobId}`, `{type}`, `{name}`); `apiUrl` and `eventSourceUrl` are explicitly *not* — they're single, session-wide endpoints designed to span every account a token can access in one call/stream. This lines up naturally with the existing multi-account-per-user model (Authress access records already let one user belong to several accounts) — `session.accounts` surfaces that directly, no extra routing needed.

## Data model mapping (`src/jmap/`, translation layer only — no new stored schema)

| JMAP object | Backed by | Notes |
|---|---|---|
| `Mailbox` | Synthetic, computed at read time | System Mailboxes from `Arc.status` (`active`→`role:"inbox"`, `archived`→`role:"archive"`, `snoozed`→no standard role, `deleted`→`role:"trash"`) + one per `Label` (`src/types/index.ts` `Label`). RFC 8621 explicitly discusses Gmail-style multi-membership labeling as valid — this is that pattern, not a hack. |
| `Thread` | Existing `Arc` (`ThreadDatabase`) | Already the product's "browsing unit"; `emailIds` = ordered `Signal` ids in the arc. No new grouping logic. |
| `Email` | Existing `Signal<EmailSignalData>` (`src/types/index.ts:452-469`) | `keywords` (`$seen`, `$flagged`, etc.) computed from `labels`/read-state fields at read time. |
| `EmailSubmission` | Existing send/reply flow (`EmailService`, `ThreadsApi` send handler) | `EmailSubmission/set` creates route through the same path the REST reply composer already uses. |
| `Identity` | Verified `Alias` + `Domain` with `senderSetupComplete: true` (`src/types/index.ts:756-774`) | Mirrors the existing reply-composer "From" domain-dropdown gating (greyed out until Tier 2 sender setup is complete). |

**Migration risk if the Mailbox strategy needs to change later:** low. Since Mailbox/Thread/Email are all read-time projections over the same canonical Arc/Signal/Label data the REST API already projects differently, changing the synthesis strategy only means rewriting `Mailbox/get`, `Mailbox/changes`, and `Email.mailboxIds` — no data migration. Worst case, JMAP `state` tokens reset and clients do a fresh initial sync, which is an explicitly supported, cheap protocol operation.

## State and changes: an append-only Change Log, not a bare counter

A bare monotonic counter alone cannot answer `Foo/changes(sinceState)` — it tells you *that* N changes happened, not *what* changed between two states. The mechanism needs a log behind the counter:

1. **Change_Log entries**: `{accountId, dataType: "Mailbox"|"Thread"|"Email", objectId, changeType: "created"|"updated"|"destroyed", sequence}`, written at the existing `ThreadDatabase`/`AccountDatabase` mutation points whenever a Signal, Arc, or Label changes. Structurally the same append-only-log shape as the existing audit log (`AuditApi`, `AUDIT#` keys, GSI by timestamp, "every action logged with before/after state" — ADR `009-log-context-entity-objects.md`), just scoped to JMAP's three data types instead of human-readable actions.
2. **Sequence generation**: one atomic DynamoDB counter (`UpdateCommand` with `ADD`) per `accountId`+`dataType`, incremented at write time. This is the only part that's "just a counter" — its sole job is minting ordering numbers for the log.
3. **State strings**: the JMAP `state` handed to clients is the sequence number as text — opaque to the client, only compared for equality/ordering, never parsed.
4. **`/changes` resolution**: query the log's GSI for `accountId`+`dataType` entries with `sequence > sinceState`, collapse multiple rows for the same `objectId` to their net effect (created-then-updated → still `created`; updated-then-destroyed → `destroyed`), return `newState` = current max sequence.
5. **Retention**: log entries carry a TTL. If `sinceState` predates the oldest retained entry, return `cannotCalculateChanges` — spec-legal, the client does a full resync.

**Why one shared log per account+type, not one per client:** the change history is a property of the *data*, not of any individual client's view of it. The server maintains one shared timeline per account+type; each client independently remembers its own `sinceState` bookmark into that timeline, never tracked server-side. This is also why concurrent multi-client access (below) needs no special-casing here — the log only cares about writers, not how many readers exist.

## Multiple JMAP clients per account

Confirmed to work with nothing beyond what's already described above:
- **Auth**: each client does its own OAuth2 login and gets its own independent token — the existing Authress multi-session model already supports this (same primitive behind the planned "Active sessions" UI — device, browser, last seen, revoke individually).
- **Sync**: covered by the Change_Log design above — N clients, N independent `sinceState` bookmarks, one shared log.
- **Push**: the existing `WsConnection` entity (`src/types/index.ts:350-356`) already stores connections as a set keyed by `accountId`, not a singleton.
- **Concurrent writes**: JMAP Core's own `ifInState` optimistic-concurrency check on `Set` calls (RFC 8620) detects conflicting concurrent edits and returns `stateMismatch` — built into the protocol, nothing new to add.

## Dependency: `jmap-kit`

Verified directly against npm registry metadata and published exports, not taken on description alone: MIT license, v1.0.3 (published 2026-03-09), actively released, implements JMAP Core (RFC 8620) + Mail (RFC 8621) + Blob Management (RFC 9404) in one package — the last of which lines up exactly with the upload/download/copy endpoints above.

Built on **Zod** (`zod`, `@standard-schema/spec`, `p-limit`, `url-template`) rather than bare TypeScript interfaces. This repo's entire REST API already validates and documents every route with Zod via `@hono/zod-openapi` — a Zod-based JMAP library means its schemas serve double duty as both compile-time types (`z.infer<>`) and runtime request-body validation directly inside `createRoute()`/`helpers.route()`, the same pattern every other route already follows. Its own dependencies are small, focused, widely-used packages, reasonable to take on directly.

Being a younger project (first published March 2026) is an acknowledged tradeoff versus a longer-established package, but it's the most complete single option and its Zod foundation fits how this codebase already builds APIs.

## Files to add/touch

- `src/api/jmap-app.ts` or a `JmapApi` class registered in `src/api/app.ts` alongside the other `*Api` registrations — reuses the existing JWT Bearer middleware as-is
- `src/jmap/jmap-authz.ts` — per-Method-Call authorization (see above)
- `src/jmap/` — Mailbox/Thread/Email/Identity/EmailSubmission translators + Core method dispatch, built on `jmap-kit`'s Zod schemas/types
- `src/database/account-database.ts` / `src/database/thread-database.ts` — append-only Change_Log writes at existing mutation points, plus the per-account+type sequence counter
- `package.json` — add `jmap-kit` as a dependency
- `deploy/api.tf` — new routes on the existing API Gateway (same Lambda, no new infra)

## Out of Scope

External mail ingestion (pulling mail from Gmail/Outlook/other JMAP servers via OAuth-connected sync connectors) is a separate, materially larger subsystem — new `ExternalMailConnection` entity, KMS-encrypted OAuth tokens, per-provider sync adapters, polling infrastructure. Deferred to its own future spec; tracked as a one-line `TODO.md` item only.
