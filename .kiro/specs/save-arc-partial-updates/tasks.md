# Implementation Plan: save-arc-partial-updates

## Overview

Replace `saveArc` (full PutItem) with `updateArc` (targeted UpdateExpression) at call sites that only modify a subset of arc fields. After this refactoring, `saveArc` is used exclusively for initial arc creation, while all subsequent mutations go through `updateArc`. The `updateArc` signature changes to require `status` and `lastSignalAt` as positional parameters, with optional fields in a separate bag. The dead `delete` rule action is removed from the processor.

## Tasks

- [x] 1. Extend UpdateArcFields type and rewrite updateArc method signature
  - [x] 1.1 Define `UpdateArcFields` interface and rewrite `updateArc` in `src/database/arc-database.ts`
    - Add `UpdateArcFields` interface with optional fields: `urgency`, `labels`, `summary`, `workflow`, `retentionDuration`, `sentMessageIds`
    - Change `updateArc` signature to `(accountId, id, status, lastSignalAt, update: UpdateArcFields)`
    - Rewrite expression builder: always set `status`, `lastSignalAt`, `gsi1sk`, `updatedAt`; conditionally set each optional field
    - Always compute `gsi1sk` as `LASTACT#${status}#${lastSignalAt}#${id}`
    - Remove the old conditional `if (update.status !== undefined)` / `if (update.lastSignalAt)` logic
    - Remove the `deletedAt` write (dead — arcs are never deleted by automation)
    - Use `ExpressionAttributeNames` for `#status` always (reserved word)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 5.1, 5.2_

  - [x] 1.2 Update `UpdateArcRequest` Zod schema in `src/api/requests.ts`
    - Keep the existing `UpdateArcRequest` Zod schema for API validation (status, urgency, labels — all optional for the PATCH endpoint)
    - Export the new `UpdateArcFields` interface from `src/database/arc-database.ts` (or a shared types location)
    - _Requirements: 2.1_

  - [x] 1.3 Update `ApiDatabase` interface and adapters for new `updateArc` signature
    - In `src/api/app.ts`: split the API's `updateArc` usage — the PATCH /arcs/:id handler still uses the old shape (status/urgency/labels optional), so add a wrapper or keep a separate internal call that maps to the new signature
    - In `src/database/adapters.ts`: update `ApiDatabaseAdapter.updateArc` to bridge the API's optional-status call to the new required-status signature (read current arc status/lastSignalAt when not provided by caller)
    - _Requirements: 2.1, 5.1_

- [x] 2. Add updateArc to ProcessorDatabase interface and adapter
  - [x] 2.1 Extend `ProcessorDatabase` interface in `src/processor/processor.ts`
    - Add `updateArc(accountId: string, id: string, status: ArcStatus, lastSignalAt: string, update: UpdateArcFields): Promise<Result<Arc, DbError>>`
    - Import `UpdateArcFields` type
    - _Requirements: 2.1, 3.3_

  - [x] 2.2 Wire `updateArc` in `ProcessorDatabaseAdapter` in `src/database/adapters.ts`
    - Delegate to `this.arc.updateArc(accountId, id, status, lastSignalAt, update)`
    - _Requirements: 2.1, 3.3_

- [x] 3. Convert processor to use updateArc for existing arcs and remove dead delete action
  - [x] 3.1 Replace `saveArc` with delta-based `updateArc` in `processMessage` for existing arcs
    - When `matchedArc` is not null: always set `status: "active"` and `lastSignalAt: timestamp` (reactivation)
    - If `outcome.archive` is true, use `status: "archived"` instead
    - Compute delta of optional fields (summary, workflow, urgency, retentionDuration, labels, sentMessageIds) between `matchedArc` and mutated `arc`
    - Call `this.store.updateArc(accountId, arc.id, arc.status, arc.lastSignalAt, delta)`
    - Keep `saveArc` call only for the `!matchedArc` (new arc) branch
    - Remove the conditional `if (!matchedArc || !outcome.archive) arc.lastSignalAt = timestamp` — lastSignalAt is always set to timestamp now
    - _Requirements: 1.1, 1.2, 3.1, 3.2, 3.3, 3.4_

  - [x] 3.2 Remove dead `delete` rule action from `deriveOutcome` and `ProcessingOutcome`
    - Remove `outcome.delete` case from the switch in `deriveOutcome`
    - Remove `delete: boolean` from `ProcessingOutcome` interface
    - Remove `if (outcome.delete) { arc.status = "deleted"; arc.deletedAt = now; }` from `processMessage`
    - Remove `outcome.delete` from the `hasStatusOutcome` check
    - Update `emptyOutcome()` to remove the `delete` field
    - _Requirements: 6.1, 6.2_

  - [x] 3.3 Remove `delete` from `RuleActionType` enum in `src/api/requests.ts`
    - Remove `"delete"` from the `RuleActionType` z.enum array
    - _Requirements: 6.3_

- [x] 4. Convert API unblock-signal handler to use updateArc
  - [x] 4.1 Replace `saveArc` with `updateArc` in the unblock-signal handler in `src/api/app.ts`
    - When `matchedArc` exists and `signal.receivedAt > arc.lastSignalAt`: call `store.updateArc(accountId, matchedArc.id, "active", signal.receivedAt, {})` instead of spreading the full arc into `saveArc`
    - Use the returned `Arc` from `updateArc` result as the response arc
    - Update the `ApiDatabase` interface to expose the new `updateArc` signature (or add a second method for the processor-style call)
    - _Requirements: 4.1, 4.2_

- [x] 5. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Remove saveArc from API layer interfaces where no longer needed
  - [x] 6.1 Remove `saveArc` from `ApiDatabase` interface if no remaining callers
    - Check if any API handler still calls `saveArc` — if not, remove from interface and adapter
    - Keep `saveArc` on `ArcDatabase` class (used by `createArc` internally and by `ProcessorDatabase` for new arcs)
    - _Requirements: 1.3, 1.4_

- [x] 7. Write tests for updateArc and processor conversion
  - [x] 7.1 Write unit tests for `updateArc` expression builder in `tests/database/arc-database-update.test.ts`
    - Test: status + lastSignalAt only → verify `gsi1sk` recomputed, `updatedAt` set, no optional fields in expression
    - Test: status + lastSignalAt + labels → verify labels set alongside required fields
    - Test: summary + workflow in optional fields → verify both set
    - Test: `updatedAt` always present regardless of which optional fields provided
    - Use `aws-sdk-client-mock` to capture the `UpdateCommand` input
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 7.2 Write unit tests for processor delta computation in `tests/processor/processor-update-arc.test.ts`
    - Test: existing active arc, no field changes → `updateArc` called with `("active", newTimestamp, {})`
    - Test: existing archived arc → `updateArc` called with `("active", newTimestamp, {})` (reactivation)
    - Test: existing arc with archive rule → `updateArc` called with `("archived", newTimestamp, {})`
    - Test: existing arc with changed labels → `updateArc` called with `("active", newTimestamp, { labels })`
    - Test: new arc (matchedArc is null) → `saveArc` called, not `updateArc`
    - Test: `delete` rule action no longer sets `arc.status = "deleted"`
    - Use `vi.fn()` mocks for store methods
    - _Requirements: 7.5, 7.6, 7.7, 7.8_

  - [x] 7.3 Write unit tests for API unblock-signal handler in `tests/api/unblock-signal-update.test.ts`
    - Test: matched arc with newer signal → `updateArc` called with `("active", signal.receivedAt, {})`
    - Test: no matched arc → `createArc` called (PutItem)
    - _Requirements: 4.1, 4.2_

- [x] 8. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The design uses TypeScript — all code examples use TypeScript
- No property-based testing — all tests use static deterministic inputs with `it.each` for parameterised cases
- `saveArc` remains on `ArcDatabase` for use by `createArc` and the processor's new-arc path
- The PATCH /arcs/:id API endpoint retains its current optional-status semantics — the adapter bridges to the new required-status `updateArc` by reading the current arc's status/lastSignalAt when not provided

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3"] },
    { "id": 3, "tasks": ["3.1", "4.1"] },
    { "id": 4, "tasks": ["6.1"] },
    { "id": 5, "tasks": ["7.1", "7.2", "7.3"] }
  ]
}
```
