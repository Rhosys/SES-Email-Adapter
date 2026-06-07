# Implementation Plan: Log Message Review

## Overview

Update the `LogEntry` type and `RequestLogger.emit()` to promote a `code` field from context to a top-level entry field. Extend the existing structured-logging design document with log level semantics and message format guidance. Rewrite all TRACK/WARN/ERROR/CRITICAL log calls across six source files to use verbose WHAT/HOW/WHY/DO messages with a `code` field. Add static analysis tests to prevent regression.

## Tasks

- [x] 1. Update LogEntry type and RequestLogger.emit() for code field promotion
  - [x] 1.1 Add optional `code` field to `LogEntry` interface and update `emit()` to extract and promote `code` from context
    - In `src/logger.ts`, add `code?: string` to the `LogEntry` interface
    - Update the `emit()` method to check for `code` in context, extract it, promote to top-level, and remove from spread context
    - Ensure non-string `code` values are treated as regular context (not promoted)
    - Ensure missing `code` results in no `code` field on the output
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 7.1, 7.2, 7.3_

  - [x] 1.2 Write property tests for code field promotion (Property 1: Code field promotion and omission)
    - **Property 1: Code field promotion and omission**
    - **Validates: Requirements 2.2, 2.4, 7.2**
    - In `src/logger.property.spec.ts`, add a new describe block testing that string `code` in context is promoted to top-level and non-string/missing `code` is omitted

  - [x] 1.3 Write property test for code field non-duplication (Property 2: Code field does not duplicate in context)
    - **Property 2: Code field does not duplicate in context**
    - **Validates: Requirements 2.1, 2.2**
    - In `src/logger.property.spec.ts`, add a new describe block testing that `code` appears exactly once in serialized output when provided

- [x] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Extend structured-logging design document with level semantics and message format
  - [x] 3.1 Add "Log Level Semantics" and "Message Format" sections to the existing design document
    - In `.kiro/specs/structured-logging/design.md`, append a "Log Level Semantics" section defining purpose, audience, alerting, and usage for each of the six levels (DEBUG, INFO, TRACK, WARN, ERROR, CRITICAL)
    - Add a "Message Format" section describing the WHAT/HOW/WHY/DO pattern with examples for TRACK, WARN, ERROR, CRITICAL
    - Add guidance on `code` field usage and identifier construction conventions
    - Include a before/after example showing terse → verbose transformation
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 8.1, 8.2, 8.3_

- [x] 4. Rewrite all TRACK/WARN/ERROR/CRITICAL log messages across source files
  - [x] 4.1 Rewrite all log calls in all six source files in a single pass
    - Rewrite `src/processor/processor.ts`: all `.error()` and `.track()` calls to use verbose messages with `code` field in context
    - Rewrite `src/jobs/reindex/reindex-worker.ts`: all `.error()` and `.track()` calls
    - Rewrite `src/jobs/domain-health-job.ts`: all `.error()` calls
    - Rewrite `src/notifier/feedback-processor.ts`: all `.error()` calls
    - Rewrite `src/database/arc-database.ts`: the `.warn()` call in `searchArcs`
    - Rewrite `src/processor/rule-evaluator.ts`: the `.warn()` call in `evaluate`
    - Each rewritten call uses the verbose WHAT/HOW/WHY/DO message as the first argument and includes `code: "original.terse.id"` in the context object
    - Follow the message catalog in the design document exactly
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

- [x] 5. Update existing property tests for new message format
  - [x] 5.1 Update `processor.side-effect-logging.property.spec.ts` to expect verbose messages and code fields
    - Update any assertions that check for dot-separated message identifiers to instead check for verbose strings (containing spaces) and verify the `code` field carries the terse identifier
    - _Requirements: 7.4_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Add static analysis tests to prevent regression
  - [x] 7.1 Write static analysis test: no terse-only messages at TRACK/WARN/ERROR/CRITICAL (Property 3)
    - **Property 3: No terse-only messages at TRACK/WARN/ERROR/CRITICAL level**
    - **Validates: Requirements 6.1, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8**
    - In `src/log-message-static-analysis.spec.ts`, read all `.ts` source files (excluding tests and `logger.ts`), parse log calls via regex, assert message arguments contain at least one space

  - [x] 7.2 Write static analysis test: all TRACK/WARN/ERROR/CRITICAL calls include code field (Property 4)
    - **Property 4: All TRACK/WARN/ERROR/CRITICAL calls include a code field**
    - **Validates: Requirements 6.2**
    - In `src/log-message-static-analysis.spec.ts`, assert that every `.track()`, `.warn()`, `.error()`, `.critical()` call with a context object includes a `code` field

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The single-pass rewrite (task 4.1) covers all six source files at once per user preference
- The design document uses TypeScript — no language selection needed
- Existing DEBUG/INFO calls are left unchanged (backward-compatible)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "3.1"] },
    { "id": 2, "tasks": ["4.1"] },
    { "id": 3, "tasks": ["5.1"] },
    { "id": 4, "tasks": ["7.1", "7.2"] }
  ]
}
```
