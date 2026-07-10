# Implementation Tasks

## Task 1: Add `jmap-kit` dependency and scaffold `src/jmap/` (R1, R4, R5, R6, R7)

- [ ] Add `jmap-kit` to `package.json` dependencies
- [ ] Create `src/jmap/` directory for translators + Core method dispatch
- [ ] Confirm `jmap-kit`'s exported Zod schemas cover Session, Mailbox, Thread, Email, Identity, EmailSubmission, and Blob upload/download/copy shapes; note any gaps found during integration
- [ ] Verify `npm run build` passes with the new dependency

**Validates:** Requirements 1, 4, 5, 6, 7

## Task 2: JMAP session discovery endpoint (R1)

- [ ] Add `GET /.well-known/jmap` route, registered before the global JWT middleware in `src/api/app.ts` (same placement as `WellKnownApi`)
- [ ] Build the Session object: `capabilities` (`urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail`, `urn:ietf:params:jmap:blob`), `accounts` map covering every Account the authenticated user has access to (query existing Authress access records), `primaryAccounts`, `username`, `apiUrl`, `uploadUrl` (with `{accountId}` template), `downloadUrl` (with `{accountId}`/`{blobId}`/`{type}`/`{name}` template), `state`
- [ ] Confirm against the RFC 8620 text whether `eventSourceUrl` is mandatory in the Session object even without push support (push is deferred, see Task 11 note below); if mandatory, include it pointing at a stub
- [ ] Return 401 for missing/invalid Authorization header
- [ ] Write tests: valid token → full Session object with correct template variables per URL; multi-account user → all accounts present; missing token → 401

**Validates:** Requirement 1

## Task 3: Authress Application registration and token verification reuse (R2)

- [ ] Register a new Authress Application (e.g. `jmap-client`) — operational/dashboard step, not code. Configure it with whatever redirect URIs the target JMAP clients need.
- [ ] Document Authress's actual `/authorize` and `/token` endpoint URLs (and the `jmap-client` `client_id`) for JMAP client configuration — **no proxy routes are built on our side**; this is a documentation/config task, not application code
- [ ] Confirm JMAP requests reuse `AuthressAuthService.verify()` unchanged (no new verification module) — add a test asserting a token issued via the `jmap-client` Application verifies identically to a web-app token
- [ ] Write tests: valid OAuth-issued token → `{userId}`; invalid/expired token → 401; no separate code path exists for JMAP vs. REST verification

**Validates:** Requirement 2

## Task 4: Per-Method-Call authorization (R3)

- [ ] Create `src/jmap/jmap-authz.ts` exporting `checkMethodCallAccess(access, userId, methodName, accountId)`
- [ ] Define the JMAP-method-name → Authress-permission-string mapping (e.g. `Email/get` → `threads:read`, `Mailbox/set` → `threads:write`, `EmailSubmission/set` → send permission)
- [ ] Wire the JMAP dispatcher (Task 5) to call `checkMethodCallAccess` for every Method_Call before executing it
- [ ] On a failed check, produce a JMAP-level `error` result for that Method_Call only; continue processing remaining Method_Calls in the same Request
- [ ] Write tests: single-account batch with one unauthorized call → that call errors, others succeed; multi-account batch where one accountId is unauthorized → only that account's calls error

**Validates:** Requirement 3

## Task 5: Core method-call dispatch (`POST /jmap/api`) (R1, R3)

- [ ] Add `POST /jmap/api` route parsing the JMAP `Request` envelope (`using`, `methodCalls`, `createdIds`)
- [ ] Implement the dispatch loop: for each Method_Call, run `jmap-authz` (Task 4), then invoke the matching translator (Tasks 6–9)
- [ ] Assemble the `Response` envelope (`methodResponses`, `createdIds`, `sessionState`)
- [ ] Write tests: well-formed multi-call batch → correct per-call responses in order; malformed request → RFC 8620 `RequestErrorProblemType` response

**Validates:** Requirements 1, 3

## Task 6: Mailbox translator (R4)

- [ ] Implement `Mailbox/get`, `Mailbox/changes`, `Mailbox/query` computing Mailboxes at read time from `Thread.status` (`THREAD_STATUSES`: system Mailboxes `active`→inbox, `archived`→archive, `deleted`→trash, `report_violation`→junk) plus one per account `Label`
- [ ] Compute `totalEmails`/`unreadEmails`/`totalThreads`/`unreadThreads` per Mailbox from existing Thread/Signal data
- [ ] Ensure `Email.mailboxIds` (Task 7) reflects every Mailbox (status-derived + label-derived) an Email's Thread currently belongs to
- [ ] Write tests: system Mailboxes present with correct roles; label Mailboxes present; an Email in an active Thread with two Labels appears in three Mailboxes

**Validates:** Requirement 4

## Task 7: Thread and Email translators (R5)

- [ ] Implement `Thread/get`, `Thread/changes` mapping the existing `Thread` entity directly to JMAP `Thread` (`emailIds` = ordered Signal ids via `Signal.threadId`) — same name both sides, no translation needed beyond field selection
- [ ] Implement `Email/get`, `Email/changes`, `Email/query` mapping `Signal<EmailSignalData>` → `Email`, computing `keywords` from label/read-state fields
- [ ] Write tests: Thread with N signals → JMAP Thread with N ordered emailIds; Email property values match source Signal fields; `$seen`/`$flagged` keywords reflect state correctly

**Validates:** Requirement 5

## Task 8: EmailSubmission and Identity translators (R6)

- [ ] Implement `Identity/get` returning one Identity per verified Alias+Domain pair (`senderSetupComplete: true`), excluding incomplete Tier 2 domains
- [ ] Implement `Email/set` create for drafts (`keywords: {"$draft": true}`) — creates a `Signal` with `source: "user"`, `status: "draft"`, identical in shape to what the existing compose UI creates
- [ ] Implement `EmailSubmission/set` create by calling the *exact same* internal function the REST `POST /arcs/:arcId/signals/:id/send` handler calls — same MX-validation step, same `DraftSendDispatcher.dispatch()` invocation with the same undo-window SQS delay, same `draft`→`pending_send`→`sent` state machine (`.kiro/specs/draft-send-flow/`)
- [ ] Surface `EmailSubmission` state from the same Signal fields the existing flow writes (`sendInitiatedAt`, `sesMessageId`, `sendFailureReason`)
- [ ] Write tests: domain with incomplete sender setup → no Identity exposed; EmailSubmission create → same dispatcher invoked as the REST send endpoint (assert via the same test doubles/mocks the `draft-send-flow` spec's own tests use, not a new mock); sent message appears in the correct Thread/Email data afterward, including bounce-back via deliverability signals

**Validates:** Requirement 6

## Task 9: Shared `BlobService` + JMAP blob endpoints + REST attachment upload (R7)

Per PR review, this task now covers both JMAP's blob endpoints and the previously-separate, still-unbuilt `TODO.md` REST attachment-upload feature, sharing one service:

- [ ] Create `src/blob/blob-service.ts` (`BlobService`): one blob/attachment id scheme, one S3 bucket/prefix layout, storage + retrieval + TTL cleanup for unreferenced uploads — used by both surfaces below
- [ ] Add `POST /jmap/upload/{accountId}` — accept binary body directly (per RFC 8620's upload contract), call `BlobService.storeBlob()`, return `BlobUploadResponse`
- [ ] Add `GET /jmap/download/{accountId}/{blobId}/{name}` (with `type` query param) — serve via `BlobService`/existing CDN plumbing already used by `ThreadsApi`
- [ ] Add `POST /accounts/{accountId}/attachments` (new REST endpoint, resolves the existing `TODO.md` item) — call `BlobService.createPresignedUpload()`, return a presigned S3 PUT URL + id from the same scheme as `blobId` above
- [ ] Wire draft `Signal.attachments` (`Attachment.s3Key`) to reference the shared id scheme regardless of which surface uploaded it
- [ ] Apply the same per-call authorization check from Task 4 to the JMAP endpoints; existing REST authz pattern for the new attachments endpoint
- [ ] Write tests: JMAP upload → valid blobId returned; REST presigned upload → client can PUT directly to S3 with the returned URL; download via either surface → bytes returned; download with wrong accountId → authorization failure; unreferenced upload past TTL → cleaned up

**Validates:** Requirement 7

## Task 10: `/changes` support derived from existing `updatedAt` fields, no new log (R8)

Per PR review, this replaces the originally-planned parallel Change_Log table with a design built on data that already exists:

- [ ] Add `updatedAt` field to `SignalBase` (`src/types/index.ts`) — currently absent
- [ ] Bump `Signal.updatedAt` at the existing mutation points that currently change a Signal post-creation (rule-assigned label writes, `DraftSendDispatcher`'s status transitions)
- [ ] Add a new GSI on `ThreadDatabase` keyed `ACCT#{accountId}`, ordered by `updatedAt` (the existing GSI1 `LASTACT#{status}#{lastSignalAt}#{id}` is scoped per-status and ordered by `lastSignalAt` — not sufficient for "every Thread in this account changed since X" across all statuses)
- [ ] Add an analogous per-account `updatedAt`-ordered GSI for Signal
- [ ] Implement `Foo/changes(sinceState)` for Mailbox/Thread/Email: query the relevant GSI for `updatedAt > sinceState`, classify each id as `created` (if `createdAt` also falls after `sinceState`) or `updated`, return `newState` = latest `updatedAt` seen
- [ ] Leave `destroyed` always empty — no tombstone log (see design.md for why: the only true removal is DynamoDB TTL expiry, a slow background process far outside typical sync windows; stale references are instead caught reactively via `Foo/get`'s `notFound`)
- [ ] Implement `Foo/get`'s `notFound` array for ids that no longer resolve
- [ ] Return `cannotCalculateChanges` when `sinceState` predates the oldest data still queryable for that account+type
- [ ] Write tests: single Thread update → correct delta; Signal label change → correctly detected once `updatedAt` is wired up; `Foo/get` on an expired id → appears in `notFound`; `sinceState` older than retained data → `cannotCalculateChanges`

**Validates:** Requirement 8

## Task 11: Push — deferred, not part of this implementation pass (R9)

Per PR review, `/jmap/eventsource` is not built here. No tasks in this pass. When revisited: decide between RFC 8887 "JMAP over WebSocket" (reuses the existing API Gateway WebSocket + `handleWebSocket`/`deviceStore` infrastructure, but is a distinct larger protocol extension) versus real RFC 8620 §7.3 SSE (the textbook mechanism, but needs new Lambda response-streaming infrastructure not used anywhere in this codebase today) — see design.md's "Push: deferred" section for the tradeoff.

**Validates:** Requirement 9 (deferred)

## Task 12: Multi-client verification (R10)

- [ ] Write an integration test: two independent OAuth tokens for the same account, both issue `/changes` calls with different `sinceState` values → each gets its own correct delta
- [ ] Write a test: two concurrent `Set` calls on the same object with stale `ifInState` → losing call receives `stateMismatch`
- [ ] (Push-based multi-connection test deferred along with Task 11)

**Validates:** Requirement 10

## Task 13: Terraform routes (R1, R2, R7)

- [ ] Add the new `/jmap/*`, `/.well-known/jmap`, and `/accounts/{accountId}/attachments` routes to the existing API Gateway in `deploy/api.tf` (same Lambda, no new infra)
- [ ] Verify no changes needed to `aws_apigatewayv2_authorizer` resources — JMAP auth happens inside the Hono app like REST auth does, not at the API Gateway authorizer layer

**Validates:** Requirements 1, 2, 7

## Task 14: Documentation cleanup

- [ ] Update `TODO.md`: replace the existing "JMAP support" bullet with a pointer to this spec directory
- [ ] Update `TODO.md`'s existing "User attachment upload for outbound signals" bullet to note it's now covered by this spec's shared `BlobService` (Task 9), rather than leaving it as a separate, disconnected backlog item
- [ ] Add a new one-line `TODO.md` bullet noting external mail ingestion (Gmail/Outlook/other-JMAP pull sync) is deferred to its own future spec
- [ ] Add a new one-line `TODO.md` bullet noting JMAP push (`/jmap/eventsource`) is deferred, tracked separately from this spec's completion
- [ ] Run `npm run openapi` (or equivalent) if the JMAP routes need representation in generated docs, per existing repo convention

**Validates:** Completion cleanup
