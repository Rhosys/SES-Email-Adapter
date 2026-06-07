# Implementation Plan: Prefixed Entity IDs

## Overview

Replace bare `randomUUID()` calls with a shared `generateId(prefix)` utility that produces `{prefix}{base58(UUIDv7)}{3 check chars}`. All entities get prefixed IDs including Signals. Signal IDs become `sgn-` prefixed; the DynamoDB table PK for inbound signals uses `ses-{sesMessageId}` (the `signalLookupId`) for dedup, while the signal's external `id` field and GSI SK use the `sgn-` ID. All GSI PKs include `ACCT#{accountId}#` for tenant isolation. Database methods that update/delete signals accept `signalLookupId` (the PK value) instead of `signalId`.

## Tasks

- [x] 1. Add dependencies and create the ID utility
  - [x] 1.1 Install `uuid` and `short-uuid` packages
    - Run `npm install uuid short-uuid` in `email-catcher/backend`
    - Check if `@types/short-uuid` is needed (may be bundled)
    - _Requirements: 7.1, 7.2_

  - [x] 1.2 Create `src/utils/id.ts` with `generateId(prefix)` function
    - Import `v7 as uuidv7` from `uuid`
    - Import `short` from `short-uuid`, create translator with `short.constants.flickrBase58`
    - Implement: generate UUIDv7 → encode to base58 → compute 3 check chars (SHA-256 of base58 body, filtered to flickrBase58 alphabet, first 3) → return `prefix + encoded + checkChars`
    - Export `generateId` as the single public API
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 1.3 Write unit tests for `generateId` (`tests/utils/id.spec.ts`)
    - **Format**: `it.each` over all 6 prefixes (`arc-`, `view-`, `rule-`, `tpl-`, `aud-`, `sgn-`) — ID starts with prefix, total length is prefix.length + 22 + 3, base58 body chars are all in flickrBase58 alphabet, check chars are all in flickrBase58 alphabet
    - **Uniqueness**: generate 1000 IDs with same prefix, assert all distinct
    - **Time ordering**: generate ID, wait 2ms, generate another — base58 body of first < base58 body of second (lexicographic)
    - **Check char correctness**: generate ID, extract base58 body, recompute check chars independently, assert match
    - **Check char sensitivity**: generate ID, flip one char in base58 body, recompute check chars, assert they differ from original
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. Update Signal type and database layer
  - [x] 2.1 Add `signalLookupId` and `sesMessageId` to the Signal type
    - In `src/types/index.ts` (or wherever Signal is defined): add `signalLookupId: string` field
    - Add `sesMessageId?: string` field (present only on inbound signals)
    - For inbound signals: `signalLookupId = "ses-{sesMessageId}"`, `sesMessageId = rawSesMessageId`
    - For user/system signals: `signalLookupId = signal.id` (the `sgn-` ID), no `sesMessageId`
    - The `id` field is always the `sgn-` prefixed ID
    - _Requirements: 4.3, 4.4, 4.5_

  - [x] 2.2 Rewrite `src/database/arc-database.ts` signal methods
    - Change `sigPk` helper to: `(accountId, signalLookupId) => ACCT#${accountId}#SIG#${signalLookupId}`
    - `getSignalByMessageId(accountId, sesMessageId)`: GET by pk=`ACCT#${accountId}#SIG#ses-${sesMessageId}`
    - `saveSignal(signal)`: PUT with pk=`ACCT#${accountId}#SIG#${signal.signalLookupId}`, gsi1sk=`${signal.id}`, gsi1pk based on status:
      - Has arcId → `ACCT#${accountId}#ARC#${signal.arcId}`
      - Quarantined → `ACCT#${accountId}#QUARANTINED`
      - Blocked → `ACCT#${accountId}#BLOCKED`
    - `listSignals(accountId, arcId, params)`: QUERY gsi1 WHERE gsi1pk=`ACCT#${accountId}#ARC#${arcId}`
    - `listPreArcSignals(accountId, "quarantined", params)`: QUERY gsi1 WHERE gsi1pk=`ACCT#${accountId}#QUARANTINED`
    - `updateSignalStatus(accountId, signalLookupId, status)`: UPDATE by pk, SET gsi1pk=`ACCT#${accountId}#BLOCKED`
    - `unblockSignal(accountId, signalLookupId, arcId)`: UPDATE by pk, SET gsi1pk=`ACCT#${accountId}#ARC#${arcId}`
    - `updateSignal(accountId, signalLookupId, fields)`: UPDATE by pk
    - `updateSignalSendStatus(accountId, signalLookupId, update)`: UPDATE by pk
    - `deleteSignal(accountId, signalLookupId)`: DELETE by pk
    - `addEmbeddingToCache(accountId, signalLookupId, modelId, vector)`: UPDATE by pk
    - `updateSignalRetention(accountId, signalLookupId, update)`: UPDATE by pk
    - Remove old `getSignal(accountId, id)` direct-get method (all lookups go through GSI or dedup path)
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.8, 6.1, 6.2, 6.3, 6.4_

  - [x] 2.3 Update `src/database/account-database.ts`
    - Import `generateId` from `../utils/id.js`
    - Replace `randomUUID()` in `createView` with `generateId("view-")`
    - Replace `randomUUID()` in `createRule` with `generateId("rule-")`
    - Replace `randomUUID()` in `createLabel` — use the label name as the key instead of a generated ID
    - Update `updateLabel` to reject `name` changes — only `color` and `icon` are mutable
    - _Requirements: 3.2, 3.3, 3.4_

  - [x] 2.4 Update `src/database/audit-database.ts`
    - Import `generateId` from `../utils/id.js`
    - Replace `randomUUID()` in `saveAuditEvent` with `generateId("aud-")`
    - _Requirements: 3.8_

- [x] 3. Update signal creation sites
  - [x] 3.1 Update `src/processor/processor.ts` — inbound signal creation
    - In `buildSignal`: set `id = generateId("sgn-")` and `signalLookupId = "ses-" + sesMessageId`
    - For draft signals (auto-reply): set `id = generateId("sgn-")` and `signalLookupId = id` (same value)
    - Replace `randomUUID()` for arc creation with `generateId("arc-")`
    - Alias creation: remove `id: randomUUID()` — address is the natural key
    - Update all calls to signal DB methods to pass `signalLookupId` instead of `id`
    - _Requirements: 3.1, 3.6, 3.10, 4.1, 4.2, 4.3, 4.4_

  - [x] 3.2 Update `src/api/app.ts` — draft signals, arcs, templates
    - Import `generateId` from `../utils/id.js`
    - Draft signal creation: set `id = generateId("sgn-")` and `signalLookupId = id`
    - Arc creation: `generateId("arc-")`
    - Template creation (2 sites): `generateId("tpl-")`
    - Alias creation: remove `id: randomUUID()` — address is the natural key
    - Forwarding address: remove `id: existing?.id ?? randomUUID()` — address is the natural key
    - Do NOT change forwarding address `token: randomUUID()`
    - Update all calls to signal DB methods to pass `signal.signalLookupId`
    - _Requirements: 3.1, 3.5, 3.6, 3.7, 3.10, 3.13, 4.8_

  - [x] 3.3 Update `src/notifier/feedback-processor.ts`
    - Deliverability signal: set `id = generateId("sgn-")` and `signalLookupId = id`
    - _Requirements: 3.10_

  - [x] 3.4 Update `src/processor/system-signal-creator.ts`
    - System signal: set `id = generateId("sgn-")` and `signalLookupId = id`
    - _Requirements: 3.10_

  - [x] 3.5 Update `src/jobs/reindex/reindex-dispatcher.ts`
    - Replace `const jobId = randomUUID()` with `const jobId = logger.invocationId`
    - The dispatcher's Lambda invocation ID is the natural correlation key for all segments
    - Ensure `logger` is available in the dispatcher (pass via constructor or import)
    - _Requirements: 3.9_

- [x] 4. Update callers that pass signal IDs to DB methods
  - [x] 4.1 Grep for all calls to `updateSignalStatus`, `unblockSignal`, `updateSignal`, `updateSignalSendStatus`, `deleteSignal`, `addEmbeddingToCache`, `updateSignalRetention`
    - Each caller must pass `signalLookupId` (from the signal object) instead of `signal.id`
    - If the caller only has a `sgn-` ID without the signal object, it must fetch via GSI first
    - _Requirements: 4.8_

  - [x] 4.2 Remove any code that parses signal IDs by `SES#`/`USR#`/`SYS#` prefix
    - Grep for `startsWith("SES#")`, `startsWith("USR#")`, `startsWith("SYS#")`, `split("#")`
    - Signal source discrimination now uses the `source` field (`"email"`, `"user"`, `"system"`)
    - _Requirements: 4.3_

  - [x] 4.3 Update the `getSignal` call sites in the API
    - The old `getSignal(accountId, signalId)` did a direct table get by ID
    - New pattern: if we have the arcId, query GSI `ACCT#{accountId}#ARC#{arcId}` with gsi1sk = signalId
    - If we don't have the arcId (rare), query across known GSI PK patterns (arc, quarantined, blocked)
    - _Requirements: 4.6, 4.8_

- [x] 5. Write backfill script
  - [x] 5.1 Create `scripts/backfill-signal-keys.ts`
    - Scan the signals table
    - For each signal with old-format ID (`SES#*`, `USR#*`, `SYS#*`):
      - Generate a new `sgn-` ID, store as `id`
      - Set `signalLookupId` based on source: `ses-{messageId}` for SES signals (extract from old `SES#` prefix), or the new `sgn-` ID for USR/SYS
      - Update `gsi1sk` to the new `sgn-` ID
      - Update `gsi1pk` to include `ACCT#{accountId}#` prefix
      - Store old ID in `legacyId` for traceability
    - Log progress, handle pagination, idempotent (skip signals that already have `sgn-` IDs)
    - _Requirements: 5.5, 6.6_

- [x] 6. Verify and fix tests
  - [x] 6.1 Run `npm run check` and fix any test failures
    - Tests asserting UUID format → update to accept prefixed format
    - Tests asserting `SES#`/`USR#`/`SYS#` signal ID prefixes → update to `sgn-`
    - Tests asserting `gsi1pk = ARCSIG#...` → update to `ACCT#...#ARC#...`
    - Tests asserting `gsi1pk = QUARANTINED#...` → update to `ACCT#...#QUARANTINED`
    - Tests asserting `gsi1pk = BLOCKED#...` → update to `ACCT#...#BLOCKED`
    - Tests asserting `gsi1sk = RECV#...` → update to just the signal ID
    - Tests passing `signalId` to DB methods → pass `signalLookupId`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 7. Final checkpoint
  - Run `npm run check` — all types check, all tests pass
  - Grep: no remaining `ARCSIG#` in code
  - Grep: no remaining `SES#${` or `USR#${` or `SYS#${` used as signal `id` values
  - Grep: no remaining `RECV#` in GSI SK construction
  - Grep: no remaining bare `randomUUID()` for entity IDs (only forwarding address token + logger container ID remain)
  - Grep: no remaining `QUARANTINED#${accountId}` without `ACCT#` prefix
  - Grep: no remaining `BLOCKED#${accountId}` without `ACCT#` prefix

## Notes

- The `uuid` package v12+ is ESM-only, which matches this project
- `short-uuid` uses flickrBase58 as a built-in constant (`short.constants.flickrBase58`)
- UUIDv7 time-ordering means the `sgn-` ID sorts chronologically — GSI SK can be just the ID
- The 3 check characters provide ~17 bits of error detection (58^3 ≈ 195,000 combinations)
- For user/system signals, `signalLookupId === id` — the distinction only matters for inbound SES signals
- The backfill script handles migration of existing signals — new code writes the new format immediately
- `hasSignals` is unchanged — it queries arcs (`gsi1pk = ACCT#{accountId}`, `gsi1sk begins_with LASTACT#`)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["3.1", "3.2", "3.3", "3.4", "3.5"] },
    { "id": 4, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 5, "tasks": ["5.1"] },
    { "id": 6, "tasks": ["6.1"] }
  ]
}
```
