# Implementation Plan: Signal Processor Retry Resilience

## Overview

Refactor `SignalProcessor` from a binary dedup-or-skip retry model to a resume-from-where-we-left-off pattern. The implementation introduces message type discrimination (inbound signal vs side-effect), moves side-effect execution to a separate SQS message, gates all side-effects behind Aurora upsert success, and resumes from DDB state on retry.

## Tasks

- [x] 1. Define message types and SQS dispatcher interface
  - [x] 1.1 Create `SqsDispatcher` interface and `SideEffectPayload` type
    - Add `ProcessorMessageType`, `SideEffectPayload`, and `SqsDispatcher` interface to `processor.ts` (or a new `processor-types.ts` if preferred for separation)
    - `SqsDispatcher.sendMessage(payload: SideEffectPayload): ResultAsync<void, DbError>`
    - `SideEffectPayload` contains `{ signal: Signal; arc: Arc }`
    - Add `SqsDispatcher` to `SignalProcessorOptions` as an optional dependency
    - _Requirements: 2.1, 2.2, 4.2_

- [x] 2. Implement message routing in `process()`
  - [x] 2.1 Refactor `process()` to route by `messageType` attribute
    - Inspect `record.messageAttributes?.["messageType"]?.stringValue` on each SQS record
    - Route `"side_effect"` records to a new `processSideEffectRecord()` method
    - Route absent or `"inbound_signal"` records to existing `processRecord()`
    - Remove the `Promise.all` parallel processing — process records sequentially to maintain per-record error isolation
    - Preserve existing logging for failures (receiveCount threshold at 30)
    - _Requirements: 4.1, 4.2_

  - [x] 2.2 Write unit tests for message routing
    - Test: absent `messageType` attribute routes to `processRecord`
    - Test: `"inbound_signal"` value routes to `processRecord`
    - Test: `"side_effect"` value routes to `processSideEffectRecord`
    - _Requirements: 4.1_

- [x] 3. Implement retry resumption logic in `processRecord()`
  - [x] 3.1 Refactor `processRecord()` to load existing state on retry
    - When `receiveCount > 1`: read signal from DDB via `getSignalByMessageId`
    - If signal exists: read arc via `getArc(accountId, signal.arcId)`
    - If signal does not exist: fall through to full first-attempt pipeline
    - If DDB read fails: return `err(processError(record.messageId))` immediately (no writes, no Aurora, no side-effects)
    - _Requirements: 1.1, 1.2, 1.3, 1.5_

  - [x] 3.2 Write property test: resume from prior state on retry
    - **Property 1: Resume from prior state on retry**
    - **Validates: Requirements 1.1, 1.2**

  - [x] 3.3 Write property test: missing signal on retry triggers fresh processing
    - **Property 2: Missing signal on retry triggers fresh processing**
    - **Validates: Requirements 1.3**

  - [x] 3.4 Write property test: DDB read failure on retry returns batchItemFailure
    - **Property 3: DDB read failure on retry returns batchItemFailure without writes**
    - **Validates: Requirements 1.5**

- [x] 4. Reorder DDB saves: arc before signal
  - [x] 4.1 Move arc save to occur before signal save in `processMessage()`
    - Save arc immediately after arc matching and rule evaluation (before signal save)
    - Save signal after arc save succeeds
    - If arc save fails: return error without saving signal, Aurora, or side-effects
    - Remove the final `saveArc` call at the end of `processMessage()` — the arc is now saved earlier with all mutations applied
    - _Requirements: 1.4, 2.3, 2.4_

  - [x] 4.2 Write property test: arc saved before signal
    - **Property 4: Arc saved before signal (leaf before dependent)**
    - **Validates: Requirements 2.3, 2.4**

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Gate side-effects behind Aurora upsert success
  - [x] 6.1 Refactor Aurora upserts to block side-effect dispatch
    - Extract Aurora upsert logic into a dedicated `executeAuroraUpserts(signal, arc)` method
    - Run upserts for ALL active clusters in parallel
    - If ANY cluster fails: log at ERROR for primary cluster, WARN for non-primary, return `err`
    - If ALL succeed: return `ok`
    - Move Aurora upserts to execute AFTER DDB saves but BEFORE side-effect dispatch
    - On Aurora failure: return `processError` as batchItemFailure (no side-effects fire)
    - _Requirements: 2.1, 2.2, 3.1, 3.2, 3.3, 3.4_

  - [x] 6.2 Write property test: side-effects dispatch iff all Aurora upserts succeed
    - **Property 5: Side-effects dispatch if and only if all Aurora upserts succeed**
    - **Validates: Requirements 2.1, 2.2, 3.3, 4.2, 4.3**

  - [x] 6.3 Write property test: Aurora failure returns batchItemFailure with appropriate log level
    - **Property 6: Aurora failure returns batchItemFailure with appropriate log level**
    - **Validates: Requirements 3.1, 3.2**

  - [x] 6.4 Write property test: partial Aurora success preserves primary write
    - **Property 7: Partial Aurora success preserves primary write**
    - **Validates: Requirements 3.4**

- [x] 7. Implement side-effect dispatch via SQS
  - [x] 7.1 Implement `dispatchSideEffects()` method
    - Build `SideEffectPayload` with full signal and arc objects
    - Send SQS message via `SqsDispatcher` with `messageType: "side_effect"` attribute
    - Call after Aurora upserts succeed
    - If SQS send fails: return batchItemFailure (Aurora succeeded but side-effects won't fire without dispatch)
    - _Requirements: 2.1, 2.2, 4.2_

  - [x] 7.2 Implement `processSideEffectRecord()` handler
    - Parse `SideEffectPayload` from record body
    - Call `deriveOutcome(payload.signal.matchedRules)` to reconstruct outcome
    - Execute all indicated side-effects: forward, notify, pong, auto-reply, auto-draft, calendar
    - Individual side-effect failures: log and continue (do NOT return batchItemFailure)
    - Malformed payload: log error, return `ok` (do NOT return batchItemFailure — prevents infinite retry of unparseable messages)
    - _Requirements: 4.1, 4.2_

  - [x] 7.3 Write property test: outcome re-derived from persisted matchedRules
    - **Property 8: Outcome re-derived from persisted matchedRules on retry**
    - **Validates: Requirements 4.1**

- [x] 8. Isolate S3 retention as fire-and-forget
  - [x] 8.1 Ensure S3 retention errors never cause batchItemFailure
    - Extract S3 retention into `attemptS3Retention(signal, accountCtx)` method
    - Wrap in try/catch — log at warn level on failure, continue processing
    - Always attempt on every delivery (idempotent operation)
    - S3 retention runs BEFORE Aurora upserts (matches design: S3 → Aurora → dispatch)
    - Failure must not alter processing outcome or prevent Aurora/side-effect execution
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 8.2 Write property test: S3 retention failure is isolated and non-fatal
    - **Property 9: S3 retention failure is isolated and non-fatal**
    - **Validates: Requirements 5.1, 5.3**

- [x] 9. Implement `SqsDispatcher` concrete class
  - [x] 9.1 Create `SqsDispatcherImpl` using AWS SDK SQS client
    - Use `@aws-sdk/client-sqs` `SendMessageCommand`
    - Set `MessageAttributes` with `messageType: { DataType: "String", StringValue: "side_effect" }`
    - Serialize `SideEffectPayload` as JSON message body
    - Queue URL sourced from constructor parameter (injected at Lambda bootstrap)
    - _Requirements: 2.1, 4.2_

- [x] 10. Wire everything together and update Lambda entry point
  - [x] 10.1 Update Lambda handler bootstrap to inject `SqsDispatcher`
    - Instantiate `SqsDispatcherImpl` with the queue URL (from environment or compile constant)
    - Pass into `SignalProcessorOptions`
    - Ensure backward compatibility: if `sqsDispatcher` is not provided, side-effects execute inline (graceful degradation during rollout)
    - _Requirements: 2.1, 2.2_

  - [x] 10.2 Write integration tests for end-to-end retry flow
    - Test: first attempt → saves arc → saves signal → S3 retention → Aurora → dispatches side-effect message
    - Test: retry with existing signal → skips parse/classify → S3 retention → Aurora → dispatches side-effect message
    - Test: Aurora failure on retry → no side-effect dispatch → batchItemFailure returned
    - Test: side-effect message received → derives outcome → executes effects
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 3.3, 4.1, 4.2_

- [x] 11. Add logging verbosity for retry and side-effect paths
  - [x] 11.1 Add INFO logs for non-routine events and trackpoints across the entire pipeline
    - **Processor — retry path:**
      - INFO: retry path activated (receiveCount, accountId, sesMessageId)
      - INFO: signal found in DDB on retry (signalId, arcId)
      - INFO: signal NOT found in DDB on retry — running full pipeline
      - Trackpoint: `retry_signal_lookup`
      - Trackpoint: `retry_arc_lookup`
    - **Processor — first-attempt path:**
      - Trackpoint: `email_parsed`
      - Trackpoint: `email_processed` (workflow determined)
      - Trackpoint: `arc_matcher_values_generated`
      - Trackpoint: `arc_match_search` (before the DB/vector query)
      - INFO: new arc created (arcId, groupingKey if present)
      - INFO: existing arc matched (arcId, match method: groupingKey vs similarity)
      - Trackpoint: `arc_saved`
      - Trackpoint: `rules_evaluated` (count of matched rules)
      - Trackpoint: `arc_updated`
      - Trackpoint: `signal_saved`
    - **S3 retention:**
      - Trackpoint: `s3_retention_start`
      - Trackpoint: `s3_retention_complete`
    - **Aurora upserts:**
      - Trackpoint: `aurora_upsert_start` (cluster count)
      - Trackpoint: `aurora_upsert_cluster_complete` (per cluster, with clusterId)
      - Trackpoint: `aurora_upsert_all_complete`
      - INFO: Aurora upsert skipped for cluster (no embedding for that model)
    - **Side-effect dispatch:**
      - Trackpoint: `side_effect_dispatch_start`
      - INFO: side-effect SQS message dispatched (signalId, arcId, outcome summary)
      - Trackpoint: `side_effect_dispatch_complete`
    - **Side-effect handler:**
      - Trackpoint: `side_effect_received`
      - INFO: outcome derived from matchedRules (list of effect types to execute)
      - Trackpoint: `side_effect_forward_start` / `side_effect_forward_complete` (per address)
      - Trackpoint: `side_effect_notify_start` / `side_effect_notify_complete`
      - Trackpoint: `side_effect_pong_start` / `side_effect_pong_complete`
      - Trackpoint: `side_effect_auto_reply_start` / `side_effect_auto_reply_complete`
      - Trackpoint: `side_effect_auto_draft_start` / `side_effect_auto_draft_complete`
      - Trackpoint: `side_effect_calendar_start` / `side_effect_calendar_complete`
      - Trackpoint: `side_effect_all_complete`
    - **Arc matcher (inside findMatchingArc):**
      - Trackpoint: `arc_matcher_grouping_key_lookup`
      - Trackpoint: `arc_matcher_similarity_search`
      - INFO: similarity search returned match (arcId, score)
      - INFO: similarity search returned no match
    - **SQS dispatcher:**
      - Trackpoint: `sqs_send_start`
      - Trackpoint: `sqs_send_complete`
    - Include `receiveCount`, `accountId`, `sesMessageId`, `arcId` in all log entries where available

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout — all implementation uses the existing project conventions (neverthrow, vitest, fast-check)
- Existing property test files in `src/processor/` follow the naming pattern `processor.{concern}.property.spec.ts`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "4.1", "8.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "4.2", "8.2"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "6.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "6.4", "7.1", "9.1"] },
    { "id": 5, "tasks": ["7.2", "7.3"] },
    { "id": 6, "tasks": ["10.1"] },
    { "id": 7, "tasks": ["10.2", "11.1"] }
  ]
}
```
