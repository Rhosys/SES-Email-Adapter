# Implementation Tasks

## Task 1: Add `jmap-kit` dependency and scaffold `src/jmap/` (R1, R4, R5, R6, R7)

- [ ] Add `jmap-kit` to `package.json` dependencies
- [ ] Create `src/jmap/` directory for translators + Core method dispatch
- [ ] Confirm `jmap-kit`'s exported Zod schemas cover Session, Mailbox, Thread, Email, Identity, EmailSubmission, and Blob upload/download/copy shapes; note any gaps found during integration
- [ ] Verify `npm run build` passes with the new dependency

**Validates:** Requirements 1, 4, 5, 6, 7

## Task 2: JMAP session discovery endpoint (R1)

- [ ] Add `GET /.well-known/jmap` route, registered before the global JWT middleware in `src/api/app.ts` (same placement as `WellKnownApi`)
- [ ] Build the Session object: `capabilities` (`urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail`, `urn:ietf:params:jmap:blob`), `accounts` map covering every Account the authenticated user has access to (query existing Authress access records), `primaryAccounts`, `username`, `apiUrl`, `uploadUrl` (with `{accountId}` template), `downloadUrl` (with `{accountId}`/`{blobId}`/`{type}`/`{name}` template), `eventSourceUrl` (with `{types}`/`{closeafter}`/`{ping}` template), `state`
- [ ] Return 401 for missing/invalid Authorization header
- [ ] Write tests: valid token → full Session object with correct template variables per URL; multi-account user → all accounts present; missing token → 401

**Validates:** Requirement 1

## Task 3: OAuth2 endpoints and token verification reuse (R2)

- [ ] Register a new Authress Application (e.g. `jmap-client`) for client-visibility/audit — operational/dashboard step, not code
- [ ] Add `GET /jmap/oauth/authorize` — redirect to Authress's hosted login flow
- [ ] Add `POST /jmap/oauth/token` — proxy the authorization-code exchange to Authress
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

- [ ] Implement `Mailbox/get`, `Mailbox/changes`, `Mailbox/query` computing Mailboxes at read time from `Arc.status` (system Mailboxes: `active`→inbox, `archived`→archive, `snoozed`→none, `deleted`→trash) plus one per account `Label`
- [ ] Compute `totalEmails`/`unreadEmails`/`totalThreads`/`unreadThreads` per Mailbox from existing Arc/Signal data
- [ ] Ensure `Email.mailboxIds` (Task 7) reflects every Mailbox (status-derived + label-derived) an Email's Arc currently belongs to
- [ ] Write tests: system Mailboxes present with correct roles; label Mailboxes present; an Email in an active Arc with two Labels appears in three Mailboxes

**Validates:** Requirement 4

## Task 7: Thread and Email translators (R5)

- [ ] Implement `Thread/get`, `Thread/changes` mapping `Arc` → `Thread` (`emailIds` = ordered Signal ids)
- [ ] Implement `Email/get`, `Email/changes`, `Email/query` mapping `Signal<EmailSignalData>` → `Email`, computing `keywords` from label/read-state fields
- [ ] Write tests: Arc with N signals → Thread with N ordered emailIds; Email property values match source Signal fields; `$seen`/`$flagged` keywords reflect state correctly

**Validates:** Requirement 5

## Task 8: EmailSubmission and Identity translators (R6)

- [ ] Implement `Identity/get` returning one Identity per verified Alias+Domain pair (`senderSetupComplete: true`), excluding incomplete Tier 2 domains
- [ ] Implement `EmailSubmission/set` create, routing through the existing `EmailService`/`ThreadsApi` send flow
- [ ] Write tests: domain with incomplete sender setup → no Identity exposed; EmailSubmission create → existing send flow invoked with correct arguments; sent message appears in the correct Thread/Email data afterward

**Validates:** Requirement 6

## Task 9: Blob upload/download (R7)

- [ ] Add `POST /jmap/upload/{accountId}` — accept binary body, store via existing `s3Client`/`emailBucket`, return `BlobUploadResponse`
- [ ] Add `GET /jmap/download/{accountId}/{blobId}/{name}` (with `type` query param) — serve via existing CDN plumbing already used by `ThreadsApi`
- [ ] Apply the same per-call authorization check from Task 4 to both endpoints
- [ ] Write tests: upload → valid blobId returned; download with correct accountId/blobId → bytes returned; download with wrong accountId → authorization failure

**Validates:** Requirement 7

## Task 10: Change Log and `/changes` support (R8)

- [ ] Add Change_Log entries `{accountId, dataType, objectId, changeType, sequence}` at existing `ThreadDatabase`/`AccountDatabase` mutation points for Signal/Arc/Label create/update/destroy
- [ ] Add atomic per-`accountId`+`dataType` sequence counter (DynamoDB `UpdateCommand` with `ADD`)
- [ ] Add a GSI supporting "entries for accountId+dataType with sequence > N"
- [ ] Implement `Foo/changes(sinceState)` for Mailbox/Thread/Email: query the log, collapse per-`objectId` net effect, return `created`/`updated`/`destroyed` + `newState`
- [ ] Add TTL to Change_Log entries; return `cannotCalculateChanges` when `sinceState` predates the oldest retained entry
- [ ] Write tests: single change → correct delta; create-then-update same object → net `created`; update-then-destroy → net `destroyed`; `sinceState` older than retention window → `cannotCalculateChanges`

**Validates:** Requirement 8

## Task 11: Push via EventSource (R9)

- [ ] Add `GET /jmap/eventsource` accepting `types`, `closeafter`, `ping` query params
- [ ] Reuse the existing `WsConnection` infrastructure to deliver `StateChange` events covering every account the session can access
- [ ] Write tests: change in one account → StateChange delivered to a connected session with access to that account; session without access to an account → no StateChange for it

**Validates:** Requirement 9

## Task 12: Multi-client verification (R10)

- [ ] Write an integration test: two independent OAuth tokens for the same account, both issue `/changes` calls with different `sinceState` values → each gets its own correct delta
- [ ] Write a test: two concurrent `Set` calls on the same object with stale `ifInState` → losing call receives `stateMismatch`
- [ ] Write a test: two simultaneous `/jmap/eventsource` connections for the same account → both receive the same StateChange events

**Validates:** Requirement 10

## Task 13: Terraform routes (R1, R2, R7, R9)

- [ ] Add the new `/jmap/*` and `/.well-known/jmap` routes to the existing API Gateway in `deploy/api.tf` (same Lambda, no new infra)
- [ ] Verify no changes needed to `aws_apigatewayv2_authorizer` resources — JMAP auth happens inside the Hono app like REST auth does, not at the API Gateway authorizer layer

**Validates:** Requirements 1, 2, 7, 9

## Task 14: Documentation cleanup

- [ ] Update `TODO.md`: replace the existing "JMAP support" bullet with a pointer to this spec directory
- [ ] Add a new one-line `TODO.md` bullet noting external mail ingestion (Gmail/Outlook/other-JMAP pull sync) is deferred to its own future spec
- [ ] Run `npm run openapi` (or equivalent) if the JMAP routes need representation in generated docs, per existing repo convention

**Validates:** Completion cleanup
