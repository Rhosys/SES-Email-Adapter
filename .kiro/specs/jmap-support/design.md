# Technical Design

## Overview

A new JMAP server surface (`GET /.well-known/jmap`, `POST /jmap/api`, `POST /jmap/upload/{accountId}`, `GET /jmap/download/{accountId}/{blobId}/{name}`) registered alongside the existing REST API in the same single Lambda (`src/api/app.ts`), following the same `createApp`/`helpers.route`/`helpers.authz` pattern every other `*Api.ts` module already uses (ADR `003-single-lambda-per-project.md`). The entire JMAP surface is a read/write translation layer over existing DynamoDB data (`Account`, `Alias`, `Domain`, `Thread`, `Signal`, `Label`) — no new canonical storage for state/changes (derived from existing `updatedAt` fields, see below), plus a new shared `BlobService` covering both JMAP and REST attachment storage. Authentication reuses the existing Authress JWT verification unchanged; the one genuinely new mechanism is per-Method_Call authorization, because a single JMAP HTTP request can batch operations across multiple accounts and method types in ways the existing per-route `authz()` middleware cannot express. Push (`GET /jmap/eventsource`) is deferred to a follow-up — see "Push: deferred" below.

## Auth: OAuth2 via Authress, no new verification path, no proxy routes

JMAP clients authenticate with Authress-issued bearer tokens obtained via **Authorization Code + PKCE** (RFC 7636) — the flow RFC 8620 §3 recommends for public/non-confidential clients (no client secret storable on a desktop/mobile device), per RFC 8252 ("OAuth for Native Apps").

**Correction (per PR review):** an earlier draft of this section had our Lambda expose `GET /jmap/oauth/authorize` / `POST /jmap/oauth/token` as thin proxies to Authress. That's unnecessary and has been removed. Authress *is* already a full OAuth2 authorization server — nothing in OAuth2 requires the authorization server to be same-origin with the resource server (Google's own APIs point clients at `accounts.google.com`/`oauth2.googleapis.com`, not at the API's own domain). JMAP clients are configured/documented to hit Authress's real `/authorize` and `/token` endpoints directly, using the `jmap-client` Application's `client_id`. Our backend's only OAuth-related responsibilities are: (1) registering the `jmap-client` Authress Application (operational/dashboard step, not code), and (2) verifying the resulting bearer token.

Once a token is issued, `src/api/authress-auth.ts`'s `AuthressAuthService.verify()` validates it exactly as it validates web-app tokens today, because Authress tokens are equivalent regardless of which Application requested them. This yields `{userId}` — never `{accountId}` — matching the deliberate exclusion documented in `.kiro/specs/lambda-authorizer/design.md` (an authorizer response is cached per-token, so it must never encode request-specific data like accountId).

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
| `/accounts/{accountId}/attachments` | POST | path segment (existing REST convention) | New REST endpoint, shares `BlobService` with the JMAP blob routes above — see "Blob/attachment storage" below |

No `/jmap/oauth/*` routes — see the Auth section above. JMAP clients authenticate directly against Authress's own OAuth endpoints; our Lambda never sits in the middle of the handshake.

No `/jmap/eventsource` route in this pass — push is deferred, see "Push: deferred" below.

**Why `apiUrl` has no accountId segment:** RFC 8620's Session object is the only place route shapes are constrained at all — beyond the mandated URI template variables above, actual paths are our choice, since the client just follows what Session advertises. `uploadUrl`/`downloadUrl` are explicitly required to carry `{accountId}` (and `downloadUrl` also `{blobId}`, `{type}`, `{name}`); `apiUrl` and `eventSourceUrl` are explicitly *not* — they're single, session-wide endpoints designed to span every account a token can access in one call/stream. This lines up naturally with the existing multi-account-per-user model (Authress access records already let one user belong to several accounts) — `session.accounts` surfaces that directly, no extra routing needed.

## Data model mapping (`src/jmap/`, translation layer only — no new stored schema)

**Naming correction:** the product's actual conversation-grouping entity is called `Thread` (`src/types/index.ts:568`, backed by `ThreadDatabase`) — there is no separate "Arc" type in the codebase (an earlier draft of this design used "Arc" throughout, which doesn't exist; that was an error, now fixed). This is a genuinely convenient coincidence: the product's `Thread` and JMAP's `Thread` (RFC 8621 §3) are the same name for the same concept, so the mapping below is closer to "expose it directly" than "translate between two differently-named things." Also corrected: the actual `ThreadStatus` enum (`THREAD_STATUSES`) is `"active" | "archived" | "deleted" | "report_violation"` — there is no `"snoozed"` status in the current data model.

| JMAP object | Backed by | Notes |
|---|---|---|
| `Mailbox` | Synthetic, computed at read time | System Mailboxes from `Thread.status` (`active`→`role:"inbox"`, `archived`→`role:"archive"`, `deleted`→`role:"trash"`, `report_violation`→`role:"junk"`) + one per `Label` (`src/types/index.ts` `Label`). RFC 8621 explicitly discusses Gmail-style multi-membership labeling as valid — this is that pattern, not a hack. |
| `Thread` | Existing `Thread` (`ThreadDatabase`) — direct 1:1, same name both sides | Already the product's "browsing unit"; `emailIds` = ordered `Signal` ids belonging to that Thread (via `Signal.threadId`). No new grouping logic — reuses the existing `groupingKey`. |
| `Email` | Existing `Signal<EmailSignalData>` (`src/types/index.ts:452-469`) | `keywords` (`$seen`, `$flagged`, etc.) computed from `labels`/read-state fields at read time. |
| `EmailSubmission` | Existing draft→send flow (`DraftSendDispatcher`, `.kiro/specs/draft-send-flow/`) | See "EmailSubmission" section below — this is the same `draft`→`pending_send`→`sent` state machine already behind `POST /arcs/:arcId/signals/:id/send`, not a new path. |
| `Identity` | Verified `Alias` + `Domain` with `senderSetupComplete: true` (`src/types/index.ts:756-774`) | Mirrors the existing reply-composer "From" domain-dropdown gating (greyed out until Tier 2 sender setup is complete). |

**Migration risk if the Mailbox strategy needs to change later:** low. Since Mailbox/Thread/Email are all read-time projections over the same canonical Thread/Signal/Label data the REST API already projects differently, changing the synthesis strategy only means rewriting `Mailbox/get`, `Mailbox/changes`, and `Email.mailboxIds` — no data migration. Worst case, JMAP `state` tokens reset and clients do a fresh initial sync, which is an explicitly supported, cheap protocol operation.

## EmailSubmission: reuses the existing draft→send state machine exactly

Per PR review — this product already has a Draft/Compose/Send pattern (`.kiro/specs/draft-send-flow/`), and EmailSubmission should flow through almost the exact same thing rather than a generically-described "existing send flow":

1. **Compose (JMAP side):** a JMAP client creates a draft `Email` via `Email/set` create with `keywords: {"$draft": true}`. This SHALL create a `Signal` with `source: "user"`, `status: "draft"` — the exact same Signal shape the REST compose UI already creates, not a parallel draft representation.
2. **Send (JMAP side):** an `EmailSubmission/set` create call referencing that draft Email's id SHALL invoke the *exact same* internal logic already implemented behind `POST /arcs/:arcId/signals/:id/send`: MX resolution (`dns/promises`), computing `undoWindowSeconds`, `DraftSendDispatcher.dispatch()` with an SQS delay, and the `draft` → `pending_send` → `sent` state machine (including bounce-back handling via `FeedbackProcessor`/deliverability signals). JMAP is just a second caller into the same dispatcher — no new outbound-sending code path.
3. **State surfacing:** `EmailSubmission`'s `sendAt`/`undoStatus`/`deliveryStatus` are computed from the same Signal fields the existing flow already writes (`sendInitiatedAt`, `sesMessageId`, `sendFailureReason`), which also feed the `/changes` mechanism above like any other Signal mutation.

## State and changes: derived from existing `updatedAt` fields, no new log

Per PR review ("we already have signals, how is that different?") — a separate parallel Change_Log table is unnecessary. `Thread` already has `updatedAt`; the mechanism can be built almost entirely on data that already exists, with one small gap to close:

1. **Thread (and Mailbox, which is derived from Thread):** `Thread.updatedAt` (`src/types/index.ts:579`) already gets bumped on every status/label/urgency mutation. The gap: the existing `ThreadDatabase` GSI1 is `LASTACT#{status}#{lastSignalAt}#{id}` — scoped per-status, ordered by `lastSignalAt`, not a flat per-account ordering by `updatedAt`. **New work:** add one GSI on `ThreadDatabase` keyed `ACCT#{accountId}` → ordered by `updatedAt`, so `Thread/changes(sinceState)` can query "every Thread in this account with `updatedAt > sinceState`" directly.
2. **Email (Signal):** `Signal`/`SignalBase` (`src/types/index.ts:503-523`) currently has **no `updatedAt` field at all** — only `createdAt` — even though label reassignment and the draft→send state machine both mutate a Signal after creation. **New work:** add `updatedAt` to `SignalBase`, bump it at those existing mutation points (rule-assigned label writes, `DraftSendDispatcher`'s status transitions), and add an analogous per-account `updatedAt`-ordered GSI for Signal (the existing Signal GSI1 is scoped by thread/quarantine/blocked partitioning, not a flat per-account ordering either).
3. **State tokens:** the JMAP `state` handed to clients is derived from the latest `updatedAt` for that account+type (the timestamp itself, or timestamp+id as a tiebreaker) — opaque to the client, only compared for equality/ordering, never parsed.
4. **`/changes` resolution:** query the new GSI for `accountId` with `updatedAt > sinceState`; an id is `created` if its `createdAt` also falls after `sinceState`, otherwise `updated`. Return `newState` = the latest `updatedAt` seen.
5. **No destroy/tombstone log.** The only true removal of a Thread/Signal is DynamoDB TTL expiry, which only happens after the account's retention window (months to years) — a slow background process, not a normal user action (`Thread.status: "deleted"` is a soft status, itself just another `updatedAt` bump, not a removal). A client's `sinceState` window is realistically always far shorter than a retention window, so proactively tracking destroys isn't worth a dedicated log. Instead: `Foo/get`'s `notFound` array — which RFC 8620 already defines for exactly this case — handles it reactively, whenever a client asks to refetch an id that's since expired. `Foo/changes`'s `destroyed` array is simply empty in this design; that's a deliberate simplification, not an oversight.
6. **`cannotCalculateChanges`:** returned if `sinceState` predates the oldest data still queryable for that account+type (in practice, once the retention window has rolled past it) — spec-legal, the client does a full resync.

This is real, if modest, new work (one GSI on `ThreadDatabase`, one new field + one GSI for `Signal`) — meaningfully less than a whole parallel log with its own write-site instrumentation, and it reuses data that's already being written for other reasons rather than duplicating it.

**Why this needs no per-client bookkeeping:** the change history is a property of the *data* (its `updatedAt` values), not of any individual client's view of it. Each client independently remembers its own `sinceState` bookmark; the server never tracks per-client sync position. This is also why concurrent multi-client access (below) needs no special-casing here.

## Push: deferred, not built in this pass

Per PR review, `/jmap/eventsource` is **not implemented** here. RFC 8620 §7.3's `eventSourceUrl` is Server-Sent-Events over plain HTTP — a fundamentally different transport from the API Gateway WebSocket connections this codebase already has wired up (`handler.ts`'s `handleWebSocket`/`$connect`/`$disconnect`, using a `deviceStore`/`Device` abstraction for connection tracking — note this is the actual live mechanism; an earlier draft of this design incorrectly cited a separate, apparently-unused `WsConnection` type in `account-database.ts` instead). Building real SSE would require Lambda response-streaming infrastructure not used anywhere in this codebase today. The alternative, RFC 8887 "JMAP over WebSocket," genuinely would reuse the existing WebSocket infrastructure (same connection type), but is a distinct, larger protocol extension in its own right — not "free" reuse.

JMAP push is optional; clients without it work correctly by polling `Foo/changes` (above) on an interval — no functional gap, only an efficiency one for v1. Whether the Session object's `eventSourceUrl` field is strictly mandatory even without push support, versus omittable, needs confirming against the RFC text during implementation (Task 2); if mandatory, point it at a stub. Revisit building real push once there's a concrete target client or usage data to justify the SSE-vs-JMAP-over-WebSocket tradeoff.

## Blob/attachment storage: one shared `BlobService`, not two parallel schemes

Per PR review — `TODO.md` already has an unbuilt REST feature for compose-time attachment uploads ("`POST /accounts/:accountId/attachments` → presigned S3 PUT URL + `attachmentId`"). Rather than building JMAP's blob handling in isolation and reconciling later, this spec now includes a shared `BlobService` both surfaces call:

- **Shared:** one blob/attachment identifier scheme, one S3 bucket/prefix layout, one download path/CDN config, one TTL-cleanup mechanism for unreferenced uploads.
- **Not shared (can't be — different protocols):** the upload *transport*. JMAP's RFC 8620 contract requires the client to `POST` bytes directly to `uploadUrl` (through our Lambda); the REST feature's design explicitly wants a presigned S3 PUT URL (bytes go straight from the client to S3, bypassing Lambda entirely, to avoid payload-size/timeout limits on larger attachments). Both still write into the same `BlobService`-managed storage:
  - `POST /jmap/upload/{accountId}` → binary body → `BlobService.storeBlob(bytes)` → `BlobUploadResponse`.
  - `POST /accounts/{accountId}/attachments` → `BlobService.createPresignedUpload()` → presigned PUT URL + id (same id scheme as `blobId` above).
  - Downloads (`GET /jmap/download/...` and any REST download path) both resolve through the same `BlobService.getDownloadUrl(id)`/CDN plumbing already used by `ThreadsApi`.
  - Draft `Signal.attachments` (`Attachment { filename, mimeType, sizeBytes, s3Key }`, `src/types/index.ts:384-389`) references the shared id/`s3Key` scheme regardless of which surface (JMAP or REST compose UI) uploaded it.

## Multiple JMAP clients per account

Confirmed to work with nothing beyond what's already described above:
- **Auth**: each client does its own OAuth2 login and gets its own independent token — the existing Authress multi-session model already supports this (same primitive behind the planned "Active sessions" UI — device, browser, last seen, revoke individually).
- **Sync**: covered by the `updatedAt`-derived state design above — N clients, N independent `sinceState` bookmarks, one shared source of truth (the data itself), no server-side per-client tracking.
- **Concurrent writes**: JMAP Core's own `ifInState` optimistic-concurrency check on `Set` calls (RFC 8620) detects conflicting concurrent edits and returns `stateMismatch` — built into the protocol, nothing new to add.
- **Push**: not applicable — deferred (see above). Multiple clients each simply poll `Foo/changes` independently until push is built.

## Dependency: `jmap-kit`

Verified directly against npm registry metadata and published exports, not taken on description alone: MIT license, v1.0.3 (published 2026-03-09), actively released, implements JMAP Core (RFC 8620) + Mail (RFC 8621) + Blob Management (RFC 9404) in one package — the last of which lines up exactly with the upload/download/copy endpoints above.

Built on **Zod** (`zod`, `@standard-schema/spec`, `p-limit`, `url-template`) rather than bare TypeScript interfaces. This repo's entire REST API already validates and documents every route with Zod via `@hono/zod-openapi` — a Zod-based JMAP library means its schemas serve double duty as both compile-time types (`z.infer<>`) and runtime request-body validation directly inside `createRoute()`/`helpers.route()`, the same pattern every other route already follows. Its own dependencies are small, focused, widely-used packages, reasonable to take on directly.

Being a younger project (first published March 2026) is an acknowledged tradeoff versus a longer-established package, but it's the most complete single option and its Zod foundation fits how this codebase already builds APIs.

## Files to add/touch

- `src/api/jmap-app.ts` or a `JmapApi` class registered in `src/api/app.ts` alongside the other `*Api` registrations — reuses the existing JWT Bearer middleware as-is
- `src/jmap/jmap-authz.ts` — per-Method-Call authorization (see above)
- `src/jmap/` — Mailbox/Thread/Email/Identity/EmailSubmission translators + Core method dispatch, built on `jmap-kit`'s Zod schemas/types
- `src/types/index.ts` — add `updatedAt` to `SignalBase`
- `src/database/thread-database.ts` — new per-account `updatedAt`-ordered GSI; bump `Signal.updatedAt` at existing label/status mutation points
- `src/blob/` (new) — shared `BlobService` used by both `POST /jmap/upload/{accountId}` and the new `POST /accounts/{accountId}/attachments`
- `src/api/attachments-api.ts` (new, or added to an existing `*Api.ts`) — the REST attachment-upload endpoint, using `BlobService`
- `package.json` — add `jmap-kit` as a dependency
- `deploy/api.tf` — new routes on the existing API Gateway (same Lambda, no new infra)

## Out of Scope

- **External mail ingestion** (pulling mail from Gmail/Outlook/other JMAP servers via OAuth-connected sync connectors) is a separate, materially larger subsystem — new `ExternalMailConnection` entity, KMS-encrypted OAuth tokens, per-provider sync adapters, polling infrastructure. Deferred to its own future spec; tracked as a one-line `TODO.md` item only.
- **JMAP push** (`/jmap/eventsource`) is deferred per the "Push: deferred" section above — not built in this pass.
