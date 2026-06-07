# Requirements Document

## Introduction

Migrate the email-catcher/backend codebase from traditional throw/catch error handling to neverthrow `Result` and `ResultAsync` types, following the conventions defined in ADR-005. The migration covers the database layer, processor pipeline, API routes, side effects, and job workers. Hono middleware (auth/authz) is explicitly excluded.

## Glossary

- **Result_Type**: A `Result<T, E>` or `ResultAsync<T, E>` value from the neverthrow library that encodes success or failure at the type level
- **DbError**: `{ kind: "db_error"; cause: Error }` — infrastructure failure in a database or AWS SDK call
- **NotFoundError**: `{ kind: "not_found"; resource: string; id: string }` — a mutation required an existing resource that does not exist
- **InvalidResponseError**: `{ kind: "invalid_response" }` — an external service returned a response that could not be parsed or was malformed
- **ProcessError**: `{ kind: "process_error"; messageId: string }` — a failure during SQS record processing, carrying the messageId for batch failure reporting
- **Database_Layer**: The classes `AccountDatabase`, `ArcDatabase`, `ProcessingDatabase`, and `AuditDatabase`
- **Processor_Pipeline**: The `SignalProcessor` class and its `processRecord` / `process` methods
- **API_Layer**: The Hono route handlers defined in `createApp`
- **Side_Effects**: The `SesNotifier`, `SesForwarder`, and `TestReplier` implementations
- **Batch_Handler**: The SQS Lambda entry point that iterates over records and builds `batchItemFailures`
- **Hono_Middleware**: The authorization-middleware.ts and authorization-guard.ts modules (excluded from migration)

## Requirements

### Requirement 1: Define Error Types

**User Story:** As a developer, I want standalone error types named by their kind, so that every function signature communicates its failure modes at the type level without redundant wrapper types.

#### Acceptance Criteria

1. THE Error_Types module SHALL export `DbError` as `{ kind: "db_error"; cause: Error }`
2. THE Error_Types module SHALL export `NotFoundError` as `{ kind: "not_found"; resource: string; id: string }`
3. THE Error_Types module SHALL export `InvalidResponseError` as `{ kind: "invalid_response" }`
4. THE Error_Types module SHALL export `ProcessError` as `{ kind: "process_error"; messageId: string }`
5. THE Error_Types module SHALL NOT define composite union types (e.g. no `ClassifyError`, no `EmbedError`, no `NotifyError`) — unions exist only inline at return sites
6. EACH error type SHALL have a `kind` field whose value conceptually matches the type name

### Requirement 2: Migrate Database Layer

**User Story:** As a developer, I want database methods to return `ResultAsync`, so that callers handle infrastructure failures explicitly without try/catch.

#### Acceptance Criteria

1. WHEN a database read method succeeds, THE Database_Layer SHALL return `ok(T)` where T may be null for missing records
2. WHEN a database method encounters an SDK error, THE Database_Layer SHALL return `err({ kind: "db_error", cause })` wrapping the original error
3. WHEN a database mutation requires an existing resource and the resource is missing, THE method SHALL return `err({ kind: "not_found", resource, id })` — the return type is `ResultAsync<T, DbError | NotFoundError>`
4. THE Database_Layer SHALL wrap AWS SDK calls with `ResultAsync.fromPromise()` at the boundary
5. THE Database_Layer SHALL NOT throw exceptions from any public method

### Requirement 3: Migrate Processor Pipeline

**User Story:** As a developer, I want the processor pipeline to return Results, so that the batch handler can build `batchItemFailures` without try/catch.

#### Acceptance Criteria

1. WHEN processing a single SQS record succeeds, THE Processor_Pipeline SHALL return `ok(undefined)`
2. WHEN processing a single SQS record fails, THE Processor_Pipeline SHALL return `err({ kind: "process_error", messageId })`
3. WHEN the Batch_Handler receives results from all records, THE Batch_Handler SHALL partition them into successes and failures using `isErr()` checks
4. WHEN a failure result is encountered, THE Batch_Handler SHALL log at the appropriate level (TRACK for low receive counts, ERROR for high receive counts) — the level is determined by the caller based on context, not carried on the error type
5. THE Batch_Handler SHALL build `batchItemFailures` from error results and return them to the SQS service
6. THE Processor_Pipeline SHALL NOT throw exceptions — the batch handler never catches

### Requirement 4: Migrate API Routes

**User Story:** As a developer, I want API route handlers to unwrap Results inline, so that error-to-HTTP mapping is visible in the handler without global error middleware.

#### Acceptance Criteria

1. WHEN a store method returns `err({ kind: "db_error" })`, THE API_Layer SHALL respond with HTTP 500
2. WHEN a store method returns `ok(null)` for a read, THE API_Layer SHALL respond with HTTP 404
3. WHEN a store method returns `err({ kind: "not_found" })` for a mutation, THE API_Layer SHALL respond with HTTP 404
4. THE API_Layer SHALL NOT use global error middleware to map Result errors to HTTP responses
5. THE API_Layer SHALL unwrap each Result inline using `isErr()` before accessing `.value`
6. THE validate.ts module (zParse) SHALL continue throwing HTTPException since it is consumed by Hono middleware

### Requirement 5: Migrate Side Effects

**User Story:** As a developer, I want side-effect services (notifier, forwarder, reputation) to return `ResultAsync`, so that callers log failures explicitly instead of using `.catch()`.

#### Acceptance Criteria

1. WHEN a side effect succeeds, THE service SHALL return `ok(undefined)`
2. WHEN a side effect fails due to an SDK error, THE service SHALL return `err({ kind: "db_error", cause })`
3. WHEN the caller receives an error result from a side effect, THE caller SHALL log explicitly at TRACK or ERROR level — there is no fire-and-forget
4. THE codebase SHALL NOT use `.catch()` anywhere for error handling
5. THE Side_Effects SHALL wrap AWS SDK calls with `ResultAsync.fromPromise()` at the boundary

### Requirement 6: Migrate Job Workers

**User Story:** As a developer, I want the reindex worker and domain health job to use Result types, so that batch failures are handled explicitly and consistently with the processor pattern.

#### Acceptance Criteria

1. WHEN the reindex worker processes a segment record successfully, THE reindex worker SHALL return `ok(undefined)`
2. WHEN the reindex worker encounters an error processing a segment record, THE reindex worker SHALL return an error result with failure context
3. WHEN the domain health job encounters a failure for a single account, THE domain health job SHALL log explicitly and continue to the next account
4. THE staleness-logic module (pure functions with no I/O) SHALL NOT use Result types — only I/O functions return Results
5. THE Job_Workers SHALL use explicit `isErr()` checks instead of try/catch for error handling

### Requirement 7: Preserve Hono Middleware Exception

**User Story:** As a developer, I want Hono auth/authz middleware to remain unchanged, so that the framework's expected error-throwing contract is preserved.

#### Acceptance Criteria

1. THE Hono_Middleware (authorization-middleware.ts) SHALL continue using try/catch
2. THE Hono_Middleware (authorization-guard.ts) SHALL continue using try/catch
3. THIS is the only exception to the no-throw rule in the codebase

### Requirement 8: Test Migration

**User Story:** As a developer, I want tests to assert `isOk()` / `isErr()` with specific error kinds, so that test assertions match the new error handling pattern.

#### Acceptance Criteria

1. WHEN testing a successful operation, THE test suite SHALL assert `result.isOk()` and inspect `result.value`
2. WHEN testing a failed operation, THE test suite SHALL assert `result.isErr()` and inspect `result.error.kind`
3. THE test suite SHALL NOT use `expect(...).rejects.toThrow()` for functions that return Result types
4. WHEN testing the Batch_Handler, THE test suite SHALL verify that `batchItemFailures` contains the correct messageIds from error results

### Requirement 9: No Fluent Chaining

**User Story:** As a developer, I want all Result handling to use explicit sequential `isErr()` checks, so that code reads top-to-bottom without fluent chaining.

#### Acceptance Criteria

1. THE codebase SHALL NOT use `.andThen()` on Result or ResultAsync values
2. THE codebase SHALL NOT use `.map()` on Result or ResultAsync values for control flow
3. THE codebase SHALL NOT use `.mapErr()` on Result or ResultAsync values
4. WHEN multiple fallible operations are sequenced, THE code SHALL use the pattern: `const result = await fn(); if (result.isErr()) return err(result.error); const value = result.value;`
