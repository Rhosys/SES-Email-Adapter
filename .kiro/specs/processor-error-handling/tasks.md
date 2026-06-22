# Implementation Plan: Processor Error Handling

## Overview

Refactor the email-catcher backend's side-effect processing to: (1) classify SES errors in EmailService with proper logging, (2) include full context in all processor logs, (3) accumulate critical failures into AggregateError, and (4) coerce stale pending_send signals to draft at read-time.

## Tasks

- [x] 1. Add TransientSesError type and update EmailService error classification
  - [x] 1.1 Add `TransientSesError` type to `src/errors.ts`. Add `Logger` to `EmailService` constructor. Update `send` and `sendRaw` catch blocks to classify permanent vs transient: permanent → `logger.error` (with opts) + return `ok({ messageId: "" })`; transient → `logger.warn` (with opts) + return `err(TransientSesError)`. Add `logger.info` with messageId on success. Update return types from `Result<{ messageId }, DbError>` to `Result<{ messageId }, TransientSesError>`. Update instantiation in handler.ts. Fix compile errors. Write tests for all classification paths.
    - _Requirements: R1.1, R1.2, R1.3, R1.4, R1.5, R1.6, R1.7, R1.8, R1.11_

- [x] 2. Update ReplySender interface to return Result
  - [x] 2.1 Change `ReplySender` interface return type to `Promise<Result<{ messageId: string }, TransientSesError>>`. Update `ExternalEmailSignalHandler.sendReply` to return Result (delegate to emailService.send, no longer throw). Update `forward` return type if affected. Fix compile errors in all callers. Update test mocks.
    - _Requirements: R1.9_

- [x] 3. Update DraftSendWorker to use Result-based sendReply
  - [x] 3.1 Update `DraftSendWorker.process`: remove try/catch around sendReply, use `result.isErr()` → return `err(result.error)` for transient retry. Remove permanent-failure revert-to-draft logic. Update return type to `Result<void, DbError | TransientSesError>`. Update tests.
    - _Requirements: R1.10_

- [x] 4. Add stale pending_send coercion at read-time
  - [x] 4.1 Create `coerceStaleStatus` helper in `src/database/arc-database.ts`: if `status === "pending_send"` and `sendInitiatedAt` > 4 hours ago, return signal with `status: "draft"`. Apply in `getSignalById` and `getSignalByMessageId`. Write tests: within 4h unchanged, over 4h coerced, missing sendInitiatedAt coerced, non-pending unaffected, original not mutated.
    - _Requirements: R1.10_

- [x] 5. Add full context to all processSideEffect logs
  - [x] 5.1 Update all `logger.track`/`warn`/`error`/`critical` calls in `processSideEffect` to include full `signal`, `arc`, `payload` objects and full `error`. Add `toAddress` to forward-specific entries. Verify no partial-identifier-only calls remain.
    - _Requirements: R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R2.7_

- [x] 6. Accumulate critical failures into AggregateError
  - [x] 6.1 Change `let criticalFailure: unknown = null` to `const criticalFailures: unknown[] = []`. Replace all `criticalFailure = ...` with `criticalFailures.push(...)`. Replace bottom check with `if (criticalFailures.length > 0)` → return `err(processorError(new AggregateError(criticalFailures, message)))`. Always AggregateError. Write tests for multiple/single/zero failures.
    - _Requirements: R3.1, R3.2, R3.3, R3.4, R3.5, R3.6_

- [x] 7. Final verification
  - [x] 7.1 Final verification: `npm test` passes. Grep for stale `dbError` in SES paths, partial-context logs, singular `criticalFailure`, and `failed = result.isErr()`.

## Notes

- Task 4 (stale coercion) is fully independent and can be done first or in parallel with everything else.
- Task 3 removes tests for the permanent-failure revert-to-draft path in DraftSendWorker — that behavior is replaced by Task 4's read-time coercion.
- The pong side-effect in processSideEffect currently uses try/catch around `replySender.sendReply`. After Task 2, it will use the Result return and check `isErr()` to append to `criticalFailures`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1", "5.1", "6.1"] },
    { "id": 3, "tasks": ["7.1"] }
  ]
}
```
