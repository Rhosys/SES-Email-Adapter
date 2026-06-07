# Implementation Plan: Remove Database Adapters

## Overview

Mechanical refactoring to eliminate both the `ProcessorDatabaseAdapter` and `ApiDatabaseAdapter` classes, along with their interfaces (`ProcessorDatabase` and `ApiDatabase`). The processor accepts three concrete database classes directly; the API app accepts three concrete database classes directly. The `updateArc` bridging logic moves inline into the API route handler. The end result is the complete deletion of `src/database/adapters.ts`.

## Tasks

- [x] 1. Update processor constructor and internal references
  - [x] 1.1 Update `SignalProcessorOptions` interface and constructor in `src/processor/processor.ts`
    - Remove `store: ProcessorDatabase` field from options
    - Make `arcDb: ArcDatabase` required (was optional)
    - Add `accountDb: AccountDatabase` and `processingDb: ProcessingDatabase` fields
    - Store all three as `private readonly` fields, remove `this.store`
    - _Requirements: 3.1, 3.3_

  - [x] 1.2 Replace all `this.store.xxx()` calls in `src/processor/processor.ts`
    - Replace arc/signal method calls (`getSignalByMessageId`, `saveSignal`, `updateSignalSendStatus`, `updateSignalRetention`, `getArc`, `fastFindArcByAlternativeLookupKey`, `saveArc`) with `this.arcDb.xxx()`
    - Replace account method calls (`listEnabledRules`, `getProcessorAccountContext`, `saveAlias`, `getSender`, `saveSender`, `getTemplate`, `getDomainByName`, `incrementStats`, `annotateRuleError`, `annotateTemplateError`) with `this.accountDb.xxx()`
    - Replace reputation method calls (`updateGlobalReputation`) with `this.processingDb.xxx()`
    - _Requirements: 1.2, 1.3, 1.4, 3.2_

  - [x] 1.3 Remove the `ProcessorDatabase` interface definition from the codebase
    - Delete the interface and any associated type exports
    - _Requirements: 1.5_

- [x] 2. Update handler wiring and processor consumers
  - [x] 2.1 Update `JsonLogicRuleEvaluator` in `src/processor/rule-evaluator.ts`
    - Change constructor to accept `accountDb` (or `Pick<AccountDatabase, "annotateRuleError">`) instead of `ProcessorDatabase`/`ProcessorDatabaseAdapter`
    - Update internal usage to call `accountDb.annotateRuleError()`
    - _Requirements: 9.4_

  - [x] 2.2 Update `src/handler.ts` processor wiring
    - Remove `ProcessorDatabaseAdapter` instantiation and `processorStore` variable
    - Pass `arcDb`, `accountDb`, `processingDb` directly to `SignalProcessor` constructor
    - Pass `accountDb` directly to `JsonLogicRuleEvaluator`
    - _Requirements: 2.1, 2.2, 2.3_

- [x] 3. Processor checkpoint
  - Run `npm test` in `email-catcher/backend`. Ensure processor-related tests pass. Ask the user if questions arise.

- [x] 4. Update processor test mocks
  - [x] 4.1 Create shared test mock helpers
    - Create or update a test helper (e.g. `tests/processor/_helpers.ts`) exporting `makeArcDbMock()`, `makeAccountDbMock()`, `makeProcessingDbMock()`
    - Each returns a partial mock typed to the concrete class with only the methods belonging to that class
    - _Requirements: 4.1, 4.2_

  - [x] 4.2 Migrate processor test files to use new mocks
    - Replace `import type { ProcessorDatabase }` with imports of the three concrete types
    - Replace `makeStore(): ProcessorDatabase` with calls to the three mock factories
    - Update `buildProcessor` / `new SignalProcessor(...)` calls to pass `arcDb`, `accountDb`, `processingDb`
    - Remove any `arcDb: mockArcDb as never` hacks
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 4.3 Update `http-authorizer.test.ts` — remove `ProcessorDatabaseAdapter` from `vi.mock` call
    - _Requirements: 4.4_

- [x] 5. Processor final checkpoint
  - Run `npm test` in `email-catcher/backend`. Ensure all tests pass with zero failures and zero type errors.
  - _Requirements: 4.5, 9.5_

- [x] 6. Update API app to accept concrete database classes
  - [x] 6.1 Update `AppDeps` interface and `createApp()` signature in `src/api/app.ts`
    - Replace `store: ApiDatabase` with `arcDb: ArcDatabase`, `accountDb: AccountDatabase`, `auditDb: AuditDatabase`
    - Destructure the three fields in `createApp()`
    - _Requirements: 5.2_

  - [x] 6.2 Replace all `store.xxx()` calls in `src/api/app.ts` with direct calls
    - Replace arc/signal calls with `arcDb.xxx()`
    - Replace account/view/label/rule/domain/alias/sender/template/stats/forwarding calls with `accountDb.xxx()`
    - Replace audit calls with `auditDb.xxx()`
    - _Requirements: 5.3, 5.4, 5.5_

  - [x] 6.3 Relocate `updateArc` bridging logic inline into the route handler
    - The PATCH /arcs/:id handler already reads the arc via `getArc` — use `arc.status` as the default when the request doesn't provide `status` (NOT `"active"`)
    - Use `arc.lastSignalAt` as the default when the request doesn't provide `lastSignalAt` (NOT `new Date().toISOString()`)
    - Build `UpdateArcFields` from the request body (extract `urgency`, `labels`)
    - Call `arcDb.updateArc(accountId, id, status, lastSignalAt, fields)` directly
    - Remove `updateArcDirect` usage — any caller needing the 5-arg signature calls `arcDb.updateArc` directly
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 6.4 Remove the `ApiDatabase` interface from `src/api/app.ts`
    - Delete the interface definition
    - Remove unused type imports that were only needed by the interface
    - _Requirements: 5.1_

- [x] 7. Update handler.ts API wiring
  - [x] 7.1 Update `src/handler.ts` to pass concrete databases to `createApp()`
    - Remove `ApiDatabaseAdapter` instantiation
    - Pass `arcDb`, `accountDb`, `auditDb` directly to `createApp()`
    - Remove the `ApiDatabaseAdapter` import
    - _Requirements: 6.2_

- [x] 8. Delete adapters.ts
  - [x] 8.1 Delete `src/database/adapters.ts` entirely
    - Remove all imports of `ProcessorDatabaseAdapter` and `ApiDatabaseAdapter` from the codebase
    - _Requirements: 2.1, 6.1, 6.3_

- [x] 9. API checkpoint
  - Run `npm test` in `email-catcher/backend`. Ensure API-related tests pass. Ask the user if questions arise.

- [x] 10. Update API test mocks
  - [x] 10.1 Migrate API test files to use new mocks
    - Replace `import type { ApiDatabase }` with imports of ArcDatabase, AccountDatabase, AuditDatabase
    - Replace single store mock with three separate mocks (`arcDb`, `accountDb`, `auditDb`)
    - Update `createApp(...)` calls to pass the three mocks matching the new `AppDeps` signature
    - For `updateArc` tests: mock `arcDb.updateArc` with the 5-arg signature; verify bridging logic (field extraction, defaults)
    - _Requirements: 8.1, 8.2_

  - [x] 10.2 Remove `ApiDatabaseAdapter` from `http-authorizer.test.ts` vi.mock
    - Remove the entire `vi.mock("../src/database/adapters.js", ...)` call since the file no longer exists
    - _Requirements: 8.3_

- [x] 11. Final checkpoint
  - Run `npm test` in `email-catcher/backend`. Ensure all tests pass with zero failures and zero type errors. Ask the user if questions arise.
  - _Requirements: 8.4, 9.5_

## Notes

- No tasks are marked optional — this is a mechanical refactoring where every step is required for correctness
- Each task references specific requirements for traceability
- `npm test` runs `tsc --noEmit -p tsconfig.check.json && vitest run` (full type-check + test suite)
- The design has no Correctness Properties section — no property-based tests apply (per workspace testing rules)
- Processor tasks (1–5) are independent of API tasks (6–11) and can be committed separately
- The `updateArc` bridging logic is the only non-trivial piece — all other methods are pure passthroughs

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3"] },
    { "id": 6, "tasks": ["6.1"] },
    { "id": 7, "tasks": ["6.2", "6.3", "6.4"] },
    { "id": 8, "tasks": ["7.1"] },
    { "id": 9, "tasks": ["8.1"] },
    { "id": 10, "tasks": ["10.1", "10.2"] }
  ]
}
```
