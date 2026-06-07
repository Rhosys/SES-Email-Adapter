# Implementation Plan: DynamoDB Storage Optimization

## Overview

Four targeted optimizations to the email-catcher backend's DynamoDB storage layer: batch arc writes in the processor, eliminate redundant reads via `ReturnValues: ALL_NEW`, re-key domains by name, and add search observability logging. All changes are confined to `src/database/` and `src/processor/` with no infrastructure modifications.

## Tasks

- [x] 1. Add `stripDdbKeys` utility and update shared exports
  - [x] 1.1 Implement `stripDdbKeys` in `src/database/shared.ts`
    - Add the `DDB_INTERNAL_KEYS` constant (`pk`, `sk`, `gsi1pk`, `gsi1sk`)
    - Implement `stripDdbKeys<T>` generic function that removes all four keys from an object
    - Export the function
    - _Requirements: 2.9_

  - [x] 1.2 Write property test for `stripDdbKeys`
    - **Property 3: Key stripping removes all DynamoDB internal attributes**
    - Generate arbitrary objects with random domain fields plus random subsets of `pk`/`sk`/`gsi1pk`/`gsi1sk`
    - Verify output contains all domain fields and none of the internal key attributes
    - **Validates: Requirements 2.9**

- [x] 2. Refactor `ArcDatabase` mutation methods to use `ReturnValues: ALL_NEW`
  - [x] 2.1 Refactor `updateArc` to use `ReturnValues: "ALL_NEW"` and `stripDdbKeys`
    - Add `ReturnValues: "ALL_NEW"` to the UpdateCommand
    - Return `stripDdbKeys(result.Attributes)` instead of issuing a follow-up `getArc` call
    - Remove the pre-fetch `getArc` call for gsi1sk reconstruction — compute gsi1sk from the update params directly
    - _Requirements: 2.1, 2.9_

  - [x] 2.2 Refactor `updateSignal` to use `ReturnValues: "ALL_NEW"` and `stripDdbKeys`
    - Add `ReturnValues: "ALL_NEW"` to the UpdateCommand
    - Return `stripDdbKeys(result.Attributes)` instead of issuing a follow-up `getSignal` call
    - _Requirements: 2.2, 2.9_

  - [x] 2.3 Refactor `blockSignal` to use `ReturnValues: "ALL_NEW"` and `stripDdbKeys`
    - Add `ReturnValues: "ALL_NEW"` to the UpdateCommand
    - Return `stripDdbKeys(result.Attributes)` instead of issuing a follow-up `getSignal` call
    - _Requirements: 2.8, 2.9_

  - [x] 2.4 Write unit tests for `ArcDatabase` ReturnValues refactoring
    - Mock DynamoDB client and verify UpdateCommand params include `ReturnValues: "ALL_NEW"`
    - Verify no subsequent GetCommand is issued after each update method
    - Verify returned objects have no `pk`/`sk`/`gsi1pk`/`gsi1sk` keys
    - _Requirements: 2.1, 2.2, 2.8, 2.9_

- [x] 3. Refactor `AccountDatabase` mutation methods to use `ReturnValues: ALL_NEW`
  - [x] 3.1 Refactor `updateAccount` to use `ReturnValues: "ALL_NEW"` and `stripDdbKeys`
    - Add `ReturnValues: "ALL_NEW"` to the UpdateCommand
    - Return `stripDdbKeys(result.Attributes)` instead of issuing a follow-up `getAccount` call
    - _Requirements: 2.7, 2.9_

  - [x] 3.2 Refactor `updateView` to use `ReturnValues: "ALL_NEW"` and `stripDdbKeys`
    - Add `ReturnValues: "ALL_NEW"` to the UpdateCommand
    - Return `stripDdbKeys(result.Attributes)` instead of issuing a follow-up `getView` call
    - _Requirements: 2.3, 2.9_

  - [x] 3.3 Refactor `updateLabel` to use `ReturnValues: "ALL_NEW"` and `stripDdbKeys`
    - Add `ReturnValues: "ALL_NEW"` to the UpdateCommand
    - Return `stripDdbKeys(result.Attributes)` instead of issuing a follow-up `listLabels` + find call
    - _Requirements: 2.4, 2.9_

  - [x] 3.4 Refactor `updateRule` to use `ReturnValues: "ALL_NEW"` and `stripDdbKeys`
    - Add `ReturnValues: "ALL_NEW"` to the UpdateCommand
    - Return `stripDdbKeys(result.Attributes)` instead of issuing a follow-up GetCommand
    - _Requirements: 2.5, 2.9_

  - [x] 3.5 Refactor `updateTemplate` to use `ReturnValues: "ALL_NEW"` and `stripDdbKeys`
    - Add `ReturnValues: "ALL_NEW"` to the UpdateCommand
    - Return `stripDdbKeys(result.Attributes)` instead of issuing a follow-up `getTemplate` call
    - _Requirements: 2.6, 2.9_

  - [x] 3.6 Write unit tests for `AccountDatabase` ReturnValues refactoring
    - Mock DynamoDB client and verify UpdateCommand params include `ReturnValues: "ALL_NEW"`
    - Verify no subsequent GetCommand is issued after each update method
    - Verify returned objects have no `pk`/`sk`/`gsi1pk`/`gsi1sk` keys
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.9_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Re-key domains by name
  - [x] 5.1 Refactor `createDomain` to use domain name as SK and ID
    - Change SK from `DOMAIN#${uuid}` to `DOMAIN#${domainName}`
    - Set `id` field to the domain name itself instead of a UUID
    - _Requirements: 3.1, 3.2_

  - [x] 5.2 Refactor `getDomainByName` to use direct GetCommand
    - Replace the `listDomains` + filter approach with a single `GetCommand` using `sk: DOMAIN#${domainName}`
    - Apply `stripDdbKeys` to the returned item
    - _Requirements: 3.3_

  - [x] 5.3 Update `getDomain` and `deleteDomain` to use domain name as key
    - `getDomain(accountId, id)` already uses `DOMAIN#${id}` — since `id` is now the domain name, this works unchanged
    - Verify `deleteDomain` uses `DOMAIN#${id}` correctly with the new naming
    - _Requirements: 3.4, 3.5_

  - [x] 5.4 Verify API route compatibility with domain name as `:id` parameter
    - Confirm routes use `/domains/:id` where `:id` is now the domain name (e.g. `example.com`)
    - Ensure no URL encoding issues with dots in the path parameter
    - _Requirements: 3.6, 3.7_

  - [x] 5.5 Write property test for domain re-key round-trip
    - **Property 4: Domain re-key round-trip**
    - Generate random accountId (uuid) and domainName (valid domain string)
    - Exercise create → getDomainByName → delete → getDomainByName cycle
    - Verify create/lookup returns domain, delete/lookup returns null
    - **Validates: Requirements 3.1, 3.3, 3.4, 3.5**

- [x] 6. Batch arc writes in processor
  - [x] 6.1 Remove intermediate `saveArc` call from retention step (step 13)
    - Remove `await this.store.saveArc(arc)` after setting `arc.ttl`
    - The TTL mutation remains on the in-memory `arc` object
    - _Requirements: 1.2_

  - [x] 6.2 Remove intermediate `saveArc` calls from auto-reply loop (step 15)
    - Remove `await this.store.saveArc(arc)` inside the auto-reply template loop
    - Accumulate all `sentMessageIds` on the in-memory arc object
    - _Requirements: 1.3_

  - [x] 6.3 Verify single `saveArc` call placement and completeness
    - Confirm the existing `await this.store.saveArc(arc)` before `saveSignal` (step 12) is the sole write
    - Verify that pong (step 12) already accumulates `sentMessageIds` before this call
    - Verify blocked/quarantined paths still never call `saveArc`
    - _Requirements: 1.1, 1.4, 1.5, 1.6_

  - [x] 6.4 Write property test for single saveArc call
    - **Property 1: Single saveArc call with complete mutations**
    - Generate random `InboundSignalMessage` + classification + rule outcomes + pong/auto-reply results
    - Mock store, count `saveArc` calls, verify arc contains union of all mutations
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6**

  - [x] 6.5 Write property test for blocked/quarantined signals
    - **Property 2: Blocked/quarantined signals never trigger saveArc**
    - Generate random inputs that produce block/quarantine outcomes
    - Verify zero `saveArc` calls
    - **Validates: Requirements 1.5**

- [x] 7. Add search observability warning log
  - [x] 7.1 Add structured warning log to `searchArcs` when >200 items fetched
    - After the QueryCommand returns, check `items.length > 200`
    - Emit `console.warn(JSON.stringify({ level: "warn", message: "searchArcs.large_result_set", accountId, query, itemsFetched: items.length, timestamp: new Date().toISOString() }))` when threshold exceeded
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 7.2 Write property test for search warning threshold
    - **Property 5: Search warning threshold is bidirectional**
    - Generate random item counts (0–500), mock DynamoDB to return that many items
    - Verify warning emitted iff count > 200
    - **Validates: Requirements 4.1, 4.3**

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses vitest + fast-check for property-based testing
- All code is TypeScript strict mode, ESM, targeting Node.js >=24

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.2", "2.3", "3.1", "3.2", "3.3", "3.4", "3.5"] },
    { "id": 2, "tasks": ["2.4", "3.6", "5.1"] },
    { "id": 3, "tasks": ["5.2", "5.3", "5.4", "6.1", "6.2", "7.1"] },
    { "id": 4, "tasks": ["5.5", "6.3", "7.2"] },
    { "id": 5, "tasks": ["6.4", "6.5"] }
  ]
}
```
