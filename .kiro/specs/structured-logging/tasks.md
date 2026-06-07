# Implementation Plan: Structured Logging Migration

## Overview

Implement the `RequestLogger` class, write property-based tests to validate its correctness, then migrate all source files from raw `console` calls to logger injection. The migration proceeds module-by-module: processor first (highest log density), then jobs, then API/notifier layers.

## Tasks

- [x] 1. Create the RequestLogger class
  - [x] 1.1 Implement `src/logger.ts` with the `Logger` interface and `RequestLogger` class
    - Export `LogLevel`, `TrackPoint`, `LogEntry`, `Logger` interface
    - Implement `startInvocation()`, `trackPoint()`, and all six level methods
    - Implement `redactReplacer` function handling secret/signature keys, authorization headers, and cognito identity keys
    - Implement payload truncation with 262,144 byte limit and separate warn emission
    - Implement circular reference protection in serialization
    - Generate `CONTAINER_ID` once at module load (first 8 chars of UUID)
    - Ensure context spread cannot overwrite required fields (level, message, timestamp, invocationId, containerId)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 4.1, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2_

  - [x] 1.2 Write property tests for RequestLogger
    - **Property 1: Log entry structural invariant**
    - **Validates: Requirements 1.1, 1.2, 1.3, 2.5, 3.3**
    - **Property 2: Context merge preserves required fields**
    - **Validates: Requirements 1.5**
    - **Property 3: Track points included for track/error/critical levels**
    - **Validates: Requirements 2.3, 2.4, 4.2, 4.3**
    - **Property 4: Error and critical include stack trace**
    - **Validates: Requirements 2.2**
    - **Property 5: startInvocation resets state and preserves container ID**
    - **Validates: Requirements 3.1, 3.2, 3.4**
    - **Property 6: Recursive secret redaction**
    - **Validates: Requirements 5.1, 5.2, 5.4**
    - **Property 7: Payload truncation guard**
    - **Validates: Requirements 6.1, 6.2**

  - [x] 1.3 Write unit tests for edge cases
    - Test cognito identity object redaction specifically (Requirement 5.3)
    - Test circular reference handling
    - Test BigInt and function values in context
    - Test empty message identifier
    - Test `trackPoint()` called without `startInvocation()`
    - _Requirements: 5.3, Error Handling_

- [x] 2. Create test utilities
  - [x] 2.1 Implement `src/testing/mock-logger.ts`
    - Export `createMockLogger()` factory that returns a `Logger` implementation recording all calls
    - Export type for the mock (Logger + `calls` array + optional `entries` for inspecting structured output)
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 2.2 Write property test for mock injection
    - **Property 8: Mock injection routes all calls**
    - Verify that when a mock logger is passed via constructor, all log calls route to the mock and nothing reaches stdout
    - **Validates: Requirements 7.3**

- [x] 3. Migrate processor module
  - [x] 3.1 Add logger as required parameter to `SignalProcessor` constructor and wire through
    - Add `logger: Logger` (required, not optional) to `SignalProcessorOptions`
    - Store as `this.logger`
    - Replace all `console.error(JSON.stringify(...))` calls in `processor.ts` with appropriate logger method calls
    - Remove the inline `log()` helper function
    - Call `logger.startInvocation()` at the start of `process()`
    - Add track points for key processing stages (parse, classify, arc_match, rules, save)
    - _Requirements: 7.1, 8.1, 8.2, 8.4_

  - [x] 3.2 Migrate `rule-evaluator.ts`
    - Accept logger via constructor parameter
    - Replace `console.error` with `logger.warn()` (rule evaluation failure is degraded but not broken)
    - _Requirements: 8.1, 8.4_

  - [x] 3.3 Update processor test files to use mock logger
    - Update `processor.side-effect-logging.property.spec.ts` to inject mock logger and assert on mock calls
    - Update `processor.aurora-failure.property.spec.ts` to remove `vi.spyOn(console, "error")`
    - Update `processor.blocked.property.spec.ts` to remove `vi.spyOn(console, "error")`
    - Update any other processor specs that spy on console
    - _Requirements: 8.3_

- [x] 4. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Migrate jobs module
  - [x] 5.1 Migrate `reindex-worker.ts`
    - Add `logger: Logger` (required) to `ReindexWorker` constructor
    - Replace all `logAtLevel()` calls with `logger.track()` or `logger.error()` as appropriate
    - Remove the inline `logAtLevel()` helper function
    - Call `logger.startInvocation()` at the start of `process()`
    - _Requirements: 7.1, 8.1, 8.2, 8.4_

  - [x] 5.2 Convert `domain-health-job.ts` to a class with injected logger
    - Convert the standalone `handler()` function to a `DomainHealthJob` class with constructor accepting `db`, `arcDb`, and `logger`
    - Replace all `console.log(JSON.stringify(...))` calls with `logger.error()` or `logger.track()` based on the level field in the existing JSON
    - Call `logger.startInvocation()` at the start of `run()`
    - Update `handler.ts` to instantiate `DomainHealthJob` with the shared logger
    - _Requirements: 7.2, 8.1, 8.4_

  - [x] 5.3 Update reindex worker test files to use mock logger
    - Update `reindex-worker-isolation.property.spec.ts` to inject mock logger
    - Remove `consoleLogSpy`/`consoleErrorSpy` patterns
    - _Requirements: 8.3_

- [x] 6. Migrate API and notifier modules
  - [x] 6.1 Convert `authorization-middleware.ts` to a class with injected logger
    - Convert the middleware factory to a class that accepts `access` and `logger` via constructor
    - Replace `console.warn("Authorization failed", ...)` with `logger.info()` (expected auth failure, not a warning)
    - Replace `console.error("Authress SDK call failed", ...)` with `logger.error()`
    - Replace `console.error("AccessService not available...")` with `logger.critical()`
    - _Requirements: 7.2, 8.1, 8.4_

  - [x] 6.2 Migrate `ses-forwarder.ts`
    - Accept logger via constructor parameter
    - Replace `console.warn(...)` with `logger.info()` (DKIM/DMARC skip is expected behaviour, not a warning)
    - _Requirements: 8.1, 8.4_

  - [x] 6.3 Migrate `feedback-processor.ts`
    - Accept logger via constructor parameter
    - Replace `console.error("Failed to parse...")` with `logger.error()`
    - Replace `console.error("Failed to process...")` with `logger.error()`
    - Replace `console.error("Failed to disable forward...")` with `logger.error()`
    - _Requirements: 8.1, 8.4_

  - [x] 6.4 Update `handler.ts` to wire logger into all singletons
    - Create a single `RequestLogger` instance at module level
    - Pass it to `SignalProcessor`, `ReindexWorker`, `FeedbackProcessor`, `SesForwarder`, `JsonLogicRuleEvaluator`
    - Call `logger.startInvocation()` at the top of the Lambda handler function
    - _Requirements: 7.1_

- [x] 7. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Static analysis guard
  - [x] 8.1 Add or update static analysis test to verify no console calls remain
    - Extend `src/static-analysis.property.spec.ts` (or add a new test) that greps `src/` for `console.log|error|warn` excluding `logger.ts` and test files
    - Verify zero matches
    - _Requirements: 8.1, 8.2_

- [x] 9. Final checkpoint
  - Ensure all tests pass (`npm run test`), type-check passes (`npm run build`), ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The migration preserves existing log level semantics: `console.error` with `level: "track"` becomes `logger.track()`, not `logger.error()`
- The `authorization-middleware.ts` console.warn calls are actually INFO level (expected auth failures) — the migration corrects this per ADR 002
- Property tests use `fast-check` (already in devDependencies) with minimum 100 iterations
- The static analysis test acts as a regression guard preventing future console.log reintroduction
