# Implementation Plan: API Arc-to-Thread Migration

## Overview

This migration renames the backend from "arc" to "thread" terminology across four layers: database code interface, infrastructure (gsi2→gsi3 swap), processor/worker, and API surface. The work is sequenced so that the persistence boundary and infrastructure are migrated first, then the API surface is fixed, a parity gate validates full coverage, and only then are the legacy `/arcs` routes removed. Testing uses static Vitest example-based tests (table-driven `test.each`) throughout.

## Tasks

- [x] 1. Database layer — rename and persistence boundary
  - [x] 1.1 Rename `arc-database.ts` → `thread-database.ts`, class `ArcDatabase` → `ThreadDatabase`, methods and types to thread terminology
    - Rename the file `src/database/arc-database.ts` → `src/database/thread-database.ts`
    - Rename class `ArcDatabase` → `ThreadDatabase`
    - Rename exported type `UpdateArcFields` → `UpdateThreadFields`
    - Rename all methods per the design table (getArc→getThread, listArcs→listThreads, etc.)
    - Rename in-code `arcId` parameters/properties → `threadId` (code interface only)
    - Update all import sites across the codebase (processor, API, workers, tests)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 1.2 Implement threadId-only write and universal read fallback in the persistence boundary
    - On WRITE: store `threadId` attribute only (no `arcId`) at ALL write sites: `saveSignal`, `saveThread`, `unblockSignal`, `updateThread`, `updateSignalSendStatus`
    - On READ: resolve identifier as `record.threadId ?? record.arcId` on EVERY read/get/query path
    - Add private helpers: `resolveThreadId(record)` and `hydrateThreadObject(record)`
    - Ensure every read method populates `threadId` on returned objects before returning to callers
    - Retain the `ACCT#{accountId}#ARC#{id}` partition-key value format unchanged
    - Do NOT alter any `pk`, `sk`, `gsi1pk`, `gsi1sk` key attributes
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 10.6, 10.7, 10.8_

  - [x] 1.3 Eliminate GKEY pointer items and write `gsi3pk` on thread items in `saveThread`
    - Remove the code that writes separate `{ pk: GKEY#{accountId}#{key}, sk: "GKEY", arcId }` pointer rows
    - When `groupingKey` is present, write `gsi3pk = ACCT#{accountId}#GKEY#{groupingKey}` directly on the thread item
    - Implement `findThreadByGroupingKey` replacing `fastFindArcByAlternativeLookupKey` — queries `gsi3` with `gsi3pk = ACCT#{accountId}#GKEY#{groupingKey}`
    - _Requirements: 12.6, 12.10, 12.11, 12.12_

  - [x] 1.4 Write `gsi3pk` at signal write sites, replacing `gsi2pk`
    - In `createSignalRecord` (signal ingestion): write `gsi3pk = ACCT#{accountId}#MSGID#{msgId}` instead of `gsi2pk`
    - In `updateSignalSendStatus` (signal send): write `gsi3pk = ACCT#{accountId}#MSGID#{msgId}` instead of `gsi2pk`
    - Rename/reuse `buildGsi2pk` → `buildSignalGsi3pk` (output format unchanged)
    - Stop writing `gsi2pk` entirely
    - _Requirements: 12.4, 12.5, 12.7_

  - [x] 1.5 Migrate `findSignalByEmailMessageId` to query `gsi3` and resolve `threadId`
    - Change `IndexName` from `"gsi2"` to `"gsi3"` in the query
    - Change the key condition from `gsi2pk` to `gsi3pk`
    - Resolve the owning thread from the returned item via `record.threadId ?? record.arcId` (ALL projection returns full item)
    - Return type's `arcId?` field becomes `threadId?`
    - A miss returns `null` (best-effort)
    - _Requirements: 12.9, 14.1, 14.2_

  - [x] 1.6 Write tests for persistence boundary (Invariants 5, 6, 7, 8)
    - **Invariant 5**: `test.each` table verifying threadId-only write — mock DDB captures PutCommand/UpdateCommand, asserts `threadId` present, `arcId` absent, `pk` uses `ACCT#...#ARC#...` format
    - **Invariant 6**: `test.each` table covering four record shapes (`{threadId only}`, `{arcId only}`, `{both}`, `{neither}`) through `resolveThreadId`/`hydrateThreadObject`
    - **Invariant 7**: `test.each` verifying key attributes unchanged after boundary writes `threadId` and `gsi3pk`
    - **Invariant 8**: `test.each` verifying `gsi3pk` format at ingestion, send, and thread-save write sites; no `gsi2pk` present
    - **Validates: Requirements 9.1–9.10, 12.4–12.8**

  - [x] 1.7 Write tests for gsi3 read cutover (Invariants 9, 10)
    - **Invariant 9**: Mock DDB returns matching item (post-migration) and miss — assert query uses `IndexName: "gsi3"`, hit → resolved `threadId`, miss → `null`
    - **Invariant 10**: Mock DDB returns matching thread and miss — assert query uses `IndexName: "gsi3"` with `gsi3pk = ACCT#...#GKEY#...`, hit → full thread with `threadId`, miss → `null`
    - **Validates: Requirements 12.9, 12.10, 14.2**

- [x] 2. Infrastructure — add `gsi3` to `deploy/storage.tf`
  - [x] 2.1 Add `gsi3pk` attribute and `gsi3` global secondary index to the signals table
    - Add `attribute { name = "gsi3pk" type = "S" }` to `aws_dynamodb_table.signals`
    - Add `global_secondary_index { name = "gsi3" projection_type = "ALL" hash_key = "gsi3pk" }` block
    - Do NOT touch `gsi1`, key schema, TTL, PITR, deletion protection, streams, or replica settings
    - This is deployed FIRST (before gsi2 removal) — DynamoDB allows one GSI add/delete per UpdateTable
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2, 12.3_

- [x] 3. Infrastructure — remove `gsi2` from `deploy/storage.tf` (separate apply)
  - [x] 3.1 Remove the `gsi2` global secondary index and `gsi2pk` attribute declaration
    - Remove the `global_secondary_index` block for `gsi2`
    - Remove the `attribute { name = "gsi2pk" type = "S" }` declaration
    - This is a SEPARATE apply from the gsi3 addition (DynamoDB constraint)
    - _Requirements: 11.1, 11.6, 11.7, 12.13, 12.14_

- [x] 4. Processor and worker — update to thread terminology and gsi3pk writes
  - [x] 4.1 Update `processor.ts` — rename `arcId` → `threadId` in code, use `findThreadByGroupingKey` for Tier 1
    - Replace all in-code `signal.arcId` / `arc.id` references with `signal.threadId` / `thread.id`
    - Tier 1 caller: change from `fastFindArcByAlternativeLookupKey` to `findThreadByGroupingKey`
    - Tier 1.5 caller: `findSignalByEmailMessageId` already migrated in task 1.5 — update the resolved field from `arcId` to `threadId`
    - Ensure `createSignalRecord` passes data for `gsi3pk` write (message-id value)
    - _Requirements: 10.4, 10.10, 12.4, 14.1_

  - [x] 4.2 Update `draft-send-worker.ts` — rename `arcId` → `threadId`, pass message-id for `gsi3pk`
    - Rename all in-code `arcId` references to `threadId`
    - Pass the resolved `threadId` and message-id to `updateSignalSendStatus` so the boundary writes `gsi3pk`
    - _Requirements: 10.4, 10.10, 12.5_

- [x] 5. Checkpoint — DB layer, infra, and processor compile and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. API surface — transforms, schemas, error codes
  - [x] 6.1 Rename transforms: `toApiArc` → `toApiThread`, fix `toApiSignal` to emit `threadId` only
    - `toApiThread`: return `threadId` field (from `thread.id`), remove `arcId` line
    - `toApiSignal`: emit `threadId: signal.threadId ?? null` (always present; null when unassigned), remove any `arcId` field
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 7.4_

  - [x] 6.2 Rename schemas and request types to thread terminology
    - `Arc` z-schema → `Thread` (with `.openapi("Thread")`), drop `arcId` property, keep `threadId`
    - `ArcStatus` → `ThreadStatus`, `ArcUrgency` → `ThreadUrgency`
    - `ListArcsResponse` → `ListThreadsResponse` with `{ threads: z.array(Thread), pagination }` envelope
    - `SignalBase`: remove `arcId` property, make `threadId` nullable-but-present
    - `UpdateArcRequest` → `UpdateThreadRequest`
    - _Requirements: 1.1, 1.3, 2.6, 7.3, 8.2_

  - [x] 6.3 Rename error codes: `ARC_NOT_FOUND` → `THREAD_NOT_FOUND`, `SIGNAL_ARC_MISMATCH` → `SIGNAL_THREAD_MISMATCH`
    - Update the `ErrorCode` enum values
    - Update human-readable titles: `"Arc not found"` → `"Thread not found"`, `"Signal does not belong to this arc"` → `"Signal does not belong to this thread"`
    - Update all call sites in `threadsApi.ts` and the new `signalsApi.ts`
    - _Requirements: 7.6, 15.1, 15.2, 15.3_

  - [x] 6.4 Write tests for API transforms and error codes (Invariants 1, 2, 3, 4, 11)
    - **Invariant 1**: `test.each` verifying list responses use `threads` key + `pagination`, no `arcs` key
    - **Invariant 2**: `test.each` verifying `toApiThread` output has `threadId`, no `arcId`
    - **Invariant 3**: `test.each` verifying `toApiSignal` output has `threadId` (or null), no `arcId`
    - **Invariant 4**: `test.each` verifying quarantine-approval body has `thread` with `threadId`, no `arc` key
    - **Invariant 11**: Single test iterating all `ErrorCode` enum values asserting none contains substring `ARC`
    - **Validates: Requirements 1.1–1.4, 2.1–2.5, 6.1–6.3, 15.1–15.4**

- [x] 7. API surface — route module reorganization
  - [x] 7.1 Fix `ThreadsApi` — threads envelope, renamed DB calls, `threadId` only in responses
    - List handlers: page under `"threads"` key instead of `"arcs"`
    - Constructor: `arcDb: ArcDatabase` → `threadDb: ThreadDatabase`
    - Use renamed DB methods (`getThread`, `listThreads`, etc.)
    - Use `toApiThread`, `THREAD_NOT_FOUND`, `SIGNAL_THREAD_MISMATCH`
    - Rename `ListArcsParams` → `ListThreadsParams`
    - Confirm all nine thread operations are present (Req 3.1–3.9)
    - _Requirements: 1.1, 1.2, 1.4, 2.1, 2.2, 2.7, 3.1–3.9, 7.1, 7.5, 7.6_

  - [x] 7.2 Create `signalsApi.ts` — relocate Signals_Routes from `arcsApi.ts`
    - Create new file `src/api/signalsApi.ts` with `SignalsApi` class
    - Relocate all seven Signals_Routes: GET list, GET single, GET raw, PATCH, DELETE, POST quarantineResponse, POST reprocess
    - Move `SignalReprocessor` type into `signalsApi.ts`
    - Fix quarantine-response body: `{ arc: toApiArc(...) }` → `{ thread: toApiThread(...) }` (Req 6.1–6.3)
    - Use `ThreadDatabase` and thread-named methods
    - _Requirements: 5.1–5.8, 6.1, 6.2, 6.3_

- [x] 8. Parity gate — verify all operations before removal
  - [x] 8.1 Verify all nine thread operations (Req 3) and all seven Signals_Routes (Req 5) are registered and functional
    - Confirm thread routes: list, get, patch, list-signals, create-draft, replace-draft, send, unsubscribe, RSVP
    - Confirm signal routes: GET list, GET single, GET raw, PATCH, DELETE, POST quarantineResponse, POST reprocess
    - Run existing test suite to confirm parity — all must pass BEFORE proceeding to removal
    - _Requirements: 3.1–3.10, 5.1–5.8_

- [x] 9. Removal — delete ArcsApi and legacy `/arcs` routes
  - [x] 9.1 Delete `arcsApi.ts` and remove ArcsApi registration from `app.ts`
    - Delete `src/api/arcsApi.ts`
    - Remove `import { ArcsApi }` and `new ArcsApi(...).register(...)` from `app.ts`
    - Add `import { SignalsApi }` and `new SignalsApi(...).register(app, helpers)` to `app.ts`
    - Update `AppDeps`: `arcDb: ArcDatabase` → `threadDb: ThreadDatabase`
    - Update re-exports if any (`SignalReprocessor` from `signalsApi.js`, `ListThreadsParams` from `threadsApi.js`)
    - No route path may contain the `arcs` segment after this
    - _Requirements: 4.1, 4.2, 4.3, 7.2_

- [x] 10. OpenAPI and test suite
  - [x] 10.1 Regenerate OpenAPI document and assert correctness
    - Run `npm run openapi` — must complete successfully
    - Assert: thread paths present under `/accounts/{accountId}/threads`
    - Assert: no `Arc` component schema, no `Arcs` tag, no `arcId` anywhere
    - Assert: no path beginning with `/accounts/{accountId}/arcs`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 10.2 Update `tests/api/api.spec.ts` — migrate to thread surface
    - Update all test requests from `/arcs` paths to `/threads` paths
    - Assert `threads` envelope key in list responses
    - Assert `threadId` present and `arcId` absent in thread and signal payloads
    - Update mocks: `ArcDatabase` → `ThreadDatabase`, `arcDb` → `threadDb`
    - Rename any `Arc`-flavored test helpers or fixtures
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [x] 10.3 Record optional backfill as OUT OF SCOPE in `TODO.md`
    - Add a note to `backend/TODO.md` that the one-off `gsi3pk` backfill of historical signal items is optional and out of scope
    - _Requirements: 12.15, 14.6_

- [x] 11. Final checkpoint — full suite green
  - Run `npm run test` — full type-check + test suite must pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- The parity gate (task 8) is a HARD sequencing gate — removal (task 9) MUST NOT proceed until it passes
- Infrastructure tasks 2 and 3 are separate applies due to DynamoDB's one-GSI-add/delete-per-UpdateTable constraint
- No backfill tasks are included (out of scope, tracked in TODO.md)
- Testing uses static Vitest `test.each` table-driven assertions only — no fast-check, no property-based testing, no random generation

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["1.5", "2.1"] },
    { "id": 3, "tasks": ["1.6", "1.7", "3.1"] },
    { "id": 4, "tasks": ["4.1", "4.2"] },
    { "id": 5, "tasks": ["6.1", "6.2", "6.3"] },
    { "id": 6, "tasks": ["6.4", "7.1", "7.2"] },
    { "id": 7, "tasks": ["8.1"] },
    { "id": 8, "tasks": ["9.1"] },
    { "id": 9, "tasks": ["10.1", "10.2", "10.3"] }
  ]
}
```
