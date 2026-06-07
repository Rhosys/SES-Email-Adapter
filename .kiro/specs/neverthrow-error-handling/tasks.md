# Implementation Plan: neverthrow Error Handling Migration

## Overview

Migrate the email-catcher/backend from throw/catch error handling to explicit `Result` and `ResultAsync` types from neverthrow. The migration proceeds layer-by-layer: error types first, then database boundary, processor pipeline, side effects, API routes, job workers, and finally cleanup. Each layer builds on the previous — database Results are consumed by processor and API, processor Results are consumed by the batch handler.

## Tasks

- [x] 1. Define error types module
  - [x] 1.1 Create `src/errors.ts` with standalone error types and constructor helpers
    - Export `DbError`, `NotFoundError`, `InvalidResponseError`, `ProcessError` types
    - Export constructor helpers: `dbError()`, `notFoundError()`, `invalidResponseError()`, `processError()`
    - Re-export `ok`, `err`, `Result`, `ResultAsync` from neverthrow
    - No composite union types — unions only exist inline at return sites
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 1.2 Write property test: error type kind field consistency
    - **Property 1: Database boundary completeness** (partial — type shape validation)
    - Verify each constructor produces an object with the correct `kind` field
    - Verify `DbError.cause` is always an `Error` instance
    - **Validates: Requirements 1.6**

- [x] 2. Migrate database layer
  - [x] 2.1 Migrate `AccountDatabase` to return `ResultAsync`
    - Wrap all AWS SDK calls with `ResultAsync.fromPromise()`
    - Read methods return `ResultAsync<T | null, DbError>`
    - Mutation methods requiring existing resources return `ResultAsync<T, DbError | NotFoundError>`
    - Remove all `throw` statements from public methods
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 2.2 Migrate `ArcDatabase` to return `ResultAsync`
    - Wrap all AWS SDK calls with `ResultAsync.fromPromise()`
    - Read methods return `ResultAsync<T | null, DbError>`
    - Mutation methods requiring existing resources return `ResultAsync<T, DbError | NotFoundError>`
    - Remove all `throw` statements from public methods
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 2.3 Migrate `ProcessingDatabase` to return `ResultAsync`
    - Wrap all AWS SDK calls with `ResultAsync.fromPromise()`
    - Read methods return `ResultAsync<T | null, DbError>`
    - Remove all `throw` statements from public methods
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

  - [x] 2.4 Migrate `AuditDatabase` to return `ResultAsync`
    - Wrap all AWS SDK calls with `ResultAsync.fromPromise()`
    - Remove all `throw` statements from public methods
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

  - [x] 2.5 Write property test: database boundary completeness
    - **Property 1: Database boundary completeness**
    - For any database method, verify it returns `ResultAsync` that resolves to `ok(value)` or `err({ kind: "db_error", cause })` — never throws, never rejects
    - Mock SDK to throw arbitrary errors, verify they become `DbError`
    - **Validates: Requirements 2.2, 2.4, 2.5**

  - [x] 2.6 Write unit tests for database layer migration
    - Assert `result.isOk()` and inspect `result.value` for success paths
    - Assert `result.isErr()` and inspect `result.error.kind` for failure paths
    - Verify `ok(null)` for missing records on reads
    - Verify `err({ kind: "not_found" })` for mutations on missing resources
    - _Requirements: 2.1, 2.2, 2.3, 8.1, 8.2, 8.3_

- [x] 3. Checkpoint — database layer
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Migrate side effects to return `ResultAsync`
  - [x] 4.1 Migrate `SesNotifier` to return `ResultAsync`
    - Wrap SES SDK calls with `ResultAsync.fromPromise()`
    - `notify()` and `notifyBlocked()` return `ResultAsync<void, DbError>`
    - Remove all `.catch()` usage
    - _Requirements: 5.1, 5.2, 5.4, 5.5_

  - [x] 4.2 Migrate `SesForwarder` to return `ResultAsync`
    - Wrap SES SDK calls with `ResultAsync.fromPromise()`
    - Return `ResultAsync<void, DbError>`
    - Remove all `.catch()` usage
    - _Requirements: 5.1, 5.2, 5.4, 5.5_

  - [x] 4.3 Migrate `FeedbackProcessor` to return `ResultAsync`
    - Wrap SDK calls with `ResultAsync.fromPromise()`
    - Return `ResultAsync<void, DbError>`
    - Remove all `.catch()` usage
    - _Requirements: 5.1, 5.2, 5.4, 5.5_

- [x] 5. Migrate processor pipeline
  - [x] 5.1 Migrate `SignalProcessor.processMessage()` internals to use `isErr()` checks
    - Replace try/catch with sequential `isErr()` checks for each fallible step
    - Return `Result<void, DbError | InvalidResponseError>` from internal methods
    - Side effect errors: log explicitly at TRACK/ERROR level, do not propagate
    - No `.andThen()`, no `.map()`, no `.mapErr()`
    - _Requirements: 3.1, 3.2, 3.6, 5.3, 9.1, 9.2, 9.3, 9.4_

  - [x] 5.2 Migrate `SignalProcessor.processRecord()` to return `Result<void, ProcessError>`
    - Wrap all internal failures as `ProcessError` with the SQS `messageId`
    - Use explicit `isErr()` checks — no fluent chaining
    - _Requirements: 3.1, 3.2, 3.6, 9.4_

  - [x] 5.3 Write property test: ProcessError always carries the SQS messageId
    - **Property 7: ProcessError always carries the SQS messageId**
    - For any SQS record processed, if result is `err`, verify `ProcessError.messageId` matches `record.messageId`
    - **Validates: Requirements 3.2**

  - [x] 5.4 Write property test: side effect caller logging
    - **Property 5: Side effect caller logging**
    - For any side effect returning `err`, verify the immediate caller logs at TRACK or ERROR level
    - No error result is silently discarded
    - **Validates: Requirements 5.3**

- [x] 6. Migrate batch handler
  - [x] 6.1 Migrate batch handler to collect Results and build `batchItemFailures`
    - Replace try/catch with `isErr()` checks on `processRecord()` results
    - Log level determined by `receiveCount` (TRACK for low, ERROR for high)
    - Build `batchItemFailures` from error results
    - _Requirements: 3.3, 3.4, 3.5, 3.6_

  - [x] 6.2 Write property test: batch handler failure collection
    - **Property 2: Batch handler failure collection**
    - For any list of `Result<void, ProcessError>` values, verify exactly one `batchItemFailure` per `err` result and zero for `ok` results
    - **Validates: Requirements 3.3, 3.5, 8.4**

- [x] 7. Checkpoint — processor pipeline and batch handler
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Migrate API routes
  - [x] 8.1 Migrate route handlers in `app.ts` to unwrap Results inline
    - `isErr()` with `kind: "db_error"` → HTTP 500
    - `ok(null)` on a read → HTTP 404
    - `isErr()` with `kind: "not_found"` on a mutation → HTTP 404
    - No global error middleware — each handler maps errors inline
    - `zParse` continues throwing `HTTPException` (Hono middleware contract)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1, 7.2, 7.3_

  - [x] 8.2 Write property test: API route error mapping consistency
    - **Property 6: API route error mapping consistency**
    - For store returning `err({ kind: "db_error" })`, verify HTTP 500
    - For store returning `ok(null)` on a read, verify HTTP 404
    - For store returning `ok(value)`, verify HTTP 200
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [x] 8.3 Write unit tests for API route migration
    - Verify correct HTTP status codes for each error scenario
    - Verify `zParse` still throws `HTTPException`
    - Use `expect(...).rejects.toThrow()` ONLY for `zParse` (Hono middleware exception)
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 8.1, 8.2, 8.3_

- [x] 9. Migrate job workers
  - [x] 9.1 Migrate `ReindexWorker` to return Results and build `batchItemFailures`
    - `processRecord()` returns `Result<void, ProcessError>`
    - Batch handler collects failures via `isErr()` checks
    - Log level based on `receiveCount`
    - _Requirements: 6.1, 6.2, 6.5_

  - [x] 9.2 Migrate `domain-health-job` to use Result types
    - Wrap database calls with `ResultAsync`
    - Log per-account failures explicitly and continue to next account
    - _Requirements: 6.3, 6.5_

  - [x] 9.3 Verify `staleness-logic.ts` does NOT use Result types
    - Confirm pure functions return plain values (boolean, number, string)
    - No `Result` or `ResultAsync` imports in this module
    - _Requirements: 6.4_

- [x] 10. Checkpoint — API routes and job workers
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Final cleanup and static analysis
  - [x] 11.1 Remove all `.catch()` usage from the codebase
    - Grep for `.catch(` across all source files (excluding test files and Hono middleware)
    - Replace with explicit `isErr()` checks and logging
    - _Requirements: 5.4, 9.1, 9.2, 9.3_

  - [x] 11.2 Verify no `.andThen()` / `.map()` / `.mapErr()` usage
    - Grep for `.andThen(`, `.map(`, `.mapErr(` on Result/ResultAsync values
    - Remove any fluent chaining found
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 11.3 Verify no remaining `throw` statements outside Hono middleware
    - Grep for `throw ` across all source files
    - Only `authorization-middleware.ts`, `authorization-guard.ts`, and `validate.ts` may throw
    - _Requirements: 2.5, 3.6, 7.1, 7.2, 7.3_

  - [x] 11.4 Write static analysis property tests
    - **Property 3: No `.catch()` in codebase**
    - **Property 4: No `.andThen()` / `.map()` / `.mapErr()` in codebase**
    - Verify zero violations outside test files and Hono middleware
    - **Validates: Requirements 5.4, 9.1, 9.2, 9.3**

  - [x] 11.5 Update existing test assertions to use `isOk()` / `isErr()` pattern
    - Replace `expect(...).rejects.toThrow()` with `result.isErr()` assertions for Result-returning functions
    - Verify `result.error.kind` matches expected error type
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 12. Final checkpoint — full test suite
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation between migration waves
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- `staleness-logic.ts` is explicitly excluded from Result types (pure functions, no I/O)
- Hono middleware (`authorization-middleware.ts`, `authorization-guard.ts`) is explicitly excluded from migration
- `validate.ts` (`zParse`) continues throwing `HTTPException` — Hono middleware contract
- The project uses vitest + fast-check, TypeScript strict mode, ESM, Node.js >=24

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.2", "2.3", "2.4"] },
    { "id": 2, "tasks": ["2.5", "2.6", "4.1", "4.2", "4.3"] },
    { "id": 3, "tasks": ["5.1", "8.1"] },
    { "id": 4, "tasks": ["5.2", "8.2", "8.3", "9.1", "9.2", "9.3"] },
    { "id": 5, "tasks": ["5.3", "5.4", "6.1"] },
    { "id": 6, "tasks": ["6.2"] },
    { "id": 7, "tasks": ["11.1", "11.2", "11.3", "11.5"] },
    { "id": 8, "tasks": ["11.4"] }
  ]
}
```
