# Implementation Plan: Signal Follow-Up Scheduler

## Overview

Adds deferred arc reactivation via EventBridge Scheduler one-shot schedules. Infrastructure first (OpenTofu resources + IAM), then library code (schedule name builder, scheduler client, followup handler), then integration (handler routing, notifier extension, processor calendar hook), then API endpoint extension (PATCH arc with `followupAt`).

## Tasks

- [x] 1. Provision EventBridge Scheduler infrastructure
  - [x] 1.1 Add schedule group and Scheduler→SQS IAM role to `deploy/storage.tf`
    - Create `aws_scheduler_schedule_group.followups` with name `signal-followups`
    - Create `aws_iam_role.scheduler_sqs` with `scheduler.amazonaws.com` trust
    - Create `aws_iam_role_policy.scheduler_sqs_send` granting `sqs:SendMessage` on signals queue
    - Update `aws_sqs_queue_policy.signals_sns` to add a second statement allowing `scheduler.amazonaws.com` to send messages (condition: `ArnEquals` on `signal-followups/*`)
    - _Requirements: 8.1, 8.3, 8.4_

  - [x] 1.2 Add Lambda permissions for EventBridge Scheduler to `deploy/compute.tf`
    - Add `EventBridgeScheduler` statement to `aws_iam_role_policy.lambda_permissions`: `scheduler:CreateSchedule`, `scheduler:DeleteSchedule`, `scheduler:GetSchedule`, `scheduler:ListSchedules` scoped to schedule group ARN + `signal-followups/*`
    - Add `PassSchedulerRole` statement: `iam:PassRole` on `aws_iam_role.scheduler_sqs.arn`
    - Add environment variables to Lambda: `SCHEDULER_GROUP_NAME`, `SCHEDULER_ROLE_ARN`, `SIGNAL_QUEUE_ARN`
    - _Requirements: 8.2_

- [x] 2. Implement schedule name builder
  - [x] 2.1 Create `src/scheduler/schedule-name.ts`
    - Implement `buildScheduleName(accountId, signalId, suffix): string`
    - Format: `{accountId}.{signalId}.{suffix}` joined with `.`
    - If full name exceeds 64 chars, replace suffix with `base64url(SHA1(suffix))` sliced to fit remaining budget
    - Output must match `[0-9a-zA-Z-_.]+` and be ≤ 64 characters
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 2.2 Write tests for `buildScheduleName`
    - Test normal case: short inputs produce `{a}.{s}.{suffix}`
    - Test truncation: combined length > 64 triggers hash-slice suffix
    - Test output always ≤ 64 chars with max-length inputs
    - Test output matches `[0-9a-zA-Z-_.]+` pattern
    - **Property 1: Schedule name is always valid**
    - **Validates: Requirements 7.3, 7.4, 8.2, 8.3, 8.4**

- [x] 3. Implement scheduler client
  - [x] 3.1 Create `src/scheduler/scheduler-client.ts`
    - Define `FollowupScheduleParams` interface and `SchedulerClient` interface
    - Implement `EventBridgeSchedulerClient` class wrapping `@aws-sdk/client-scheduler`
    - `createFollowup`: `CreateScheduleCommand` with `ActionAfterCompletion: "DELETE"`, `GroupName: "signal-followups"`, `FlexibleTimeWindow: { Mode: "OFF" }`, target = SQS ARN, schedule expression = `at(...)` format
    - `deleteFollowup`: `DeleteScheduleCommand`, catch `ResourceNotFoundException` → log TRACK, return `ok()`
    - `getSchedule`: `GetScheduleCommand`, return `null` on `ResourceNotFoundException`
    - Log WARN on every `CreateSchedule`/`DeleteSchedule` call (expensive API calls)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.2, 4.3, 4.4, 9.1, 9.3_

  - [x] 3.2 Write tests for scheduler client
    - Mock `@aws-sdk/client-scheduler` commands
    - Verify `CreateScheduleCommand` params: group name, action after completion, target ARN, message body shape
    - Verify `deleteFollowup` returns `ok()` on `ResourceNotFoundException`
    - Verify WARN logging on API calls
    - _Requirements: 2.1, 2.2, 4.3_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement follow-up handler
  - [x] 5.1 Create `src/scheduler/followup-handler.ts`
    - Define `FollowupMessage` interface: `{ accountId, signalId, arcId }`
    - Implement `FollowupHandler` class with `process(message)` method
    - Stale-fire logic: `getArc` → null/deleted → TRACK + discard; active → notify with `reason: "followup"`; archived → update to active + notify with `reason: "followup"`
    - Parse message body, log ERROR + discard on parse failure (no retry)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.1, 10.3, 10.4_

  - [x] 5.2 Write tests for `FollowupHandler`
    - Test all arc states: null → discard, deleted → discard, active → notify only, archived → reactivate + notify
    - Test malformed message body → ERROR log + discard
    - Test `reason: "followup"` is passed to notifier in all notification cases
    - **Property 3: Stale-fire only reactivates archived arcs**
    - **Validates: Requirements 3.2, 3.3, 3.4**

- [x] 6. Extend notifier with `reason` parameter
  - [x] 6.1 Update `src/notifier/types.ts` and `src/notifier/device-notifier.ts`
    - Add `NotificationReason = "new_signal" | "followup"` type
    - Add optional `reason?: NotificationReason` parameter to `Notifier.notify()` signature
    - Add optional `reason?: NotificationReason` field to `NotificationPayload`
    - Update `DeviceNotifier.notify()` to accept and forward `reason` into the payload
    - Backward compatible: absent `reason` = `"new_signal"` (existing callers unchanged)
    - _Requirements: 5.2, 5.3, 5.4_

  - [x] 6.2 Write tests for notifier reason parameter
    - Test that `reason: "followup"` appears in the notification payload
    - Test that omitting `reason` keeps payload backward-compatible (no `reason` field or defaults to `"new_signal"`)
    - _Requirements: 5.3, 5.4_

- [x] 7. Register message type and wire handler routing
  - [x] 7.1 Add `"signal_followup"` to `SQS_MESSAGE_TYPES` in `src/types/index.ts`
    - Append to the existing array: `["reindex", "side_effect", "draft_send", "signal_followup"]`
    - _Requirements: 10.1_

  - [x] 7.2 Wire `signal_followup` routing in `src/handler.ts`
    - Add `FollowupHandler` instantiation in the singleton section
    - Add `else if (messageType === MSG_TYPE_SIGNAL_FOLLOWUP)` branch in the SQS routing
    - Parse body as `FollowupMessage`, call `followupHandler.process()`
    - _Requirements: 10.2, 10.3_

  - [x] 7.3 Write test for handler routing
    - Test that SQS message with `messageType: "signal_followup"` routes to `FollowupHandler.process()`
    - Test that malformed body results in message discard (not added to `batchItemFailures`)
    - _Requirements: 10.2, 10.4_

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Extend PATCH arc endpoint with `followupAt`
  - [x] 9.1 Add `followupAt` to PATCH arc request schema and handler
    - Add optional `followupAt` (ISO 8601 string) to the Zod schema for PATCH arc body
    - Validate: must be in the future (400 if not)
    - Validate: must not exceed `arc.createdAt + arc.retentionDuration` (400 if beyond)
    - When present: call `schedulerClient.createFollowup()` after any status change
    - On schedule creation failure: rollback status change (compensating write), return 500
    - `followupAt` is independent of `status` — can be sent alone or alongside `status: "archived"`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [x] 9.2 Write tests for PATCH arc `followupAt` handling
    - Test `followupAt` alone (no status change) → schedule created, arc unchanged
    - Test `followupAt` + `status: "archived"` → arc archived + schedule created
    - Test `followupAt` in the past → 400
    - Test `followupAt` beyond retention → 400
    - Test schedule creation failure → 500, arc status unchanged (rollback)
    - **Property 2: followupAt validation rejects invalid timestamps**
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7**

- [x] 10. Integrate calendar day-of scheduling in processor
  - [x] 10.1 Add schedule creation to calendar event ingestion in `src/processor/`
    - When `calendar_event` signal has `startTime` in future: leave arc active, call `schedulerClient.createFollowup()` with fire time = `08:00` on event day (account timezone or UTC)
    - When `startTime` ≤ now: leave arc active, no schedule
    - Suffix: derived from calendar event identifier (e.g. `calendar.20250715`)
    - Log ERROR on schedule creation failure, leave arc as-is (user can manually unarchive)
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 10.2 Add schedule cancellation on arc reactivation in processor
    - When processor reactivates an archived arc (new signal arrives): derive schedule name, call `schedulerClient.deleteFollowup()`
    - `ResourceNotFoundException` → TRACK, continue
    - Other failures → WARN, continue (stale-fire handles it at fire time)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 10.3 Write tests for calendar scheduling integration
    - Test future calendar event → schedule created with 08:00 fire time
    - Test past calendar event → no schedule created
    - Test arc reactivation → `deleteFollowup` called with correct schedule name
    - Test `deleteFollowup` ResourceNotFoundException → continues without error
    - **Property 4: Calendar schedule fire time computation**
    - **Property 5: Fire time floor — never schedule in the past**
    - **Validates: Requirements 6.1, 6.2, 6.3, 4.2, 4.3, 4.4**

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests use deterministic boundary enumeration (no fast-check) per tech stack constraints
- Unit tests validate specific examples and edge cases
- Infrastructure tasks (1.x) must be applied via `tofu plan`/`tofu apply` separately from code
- The `@aws-sdk/client-scheduler` package must be added to `package.json` before task 3
- Config change propagation (ListSchedules + UpdateSchedule on existing schedules) is explicitly deferred

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1"] },
    { "id": 1, "tasks": ["2.2", "3.1", "6.1"] },
    { "id": 2, "tasks": ["3.2", "5.1", "6.2", "7.1"] },
    { "id": 3, "tasks": ["5.2", "7.2"] },
    { "id": 4, "tasks": ["7.3", "9.1"] },
    { "id": 5, "tasks": ["9.2", "10.1", "10.2"] },
    { "id": 6, "tasks": ["10.3"] }
  ]
}
```
