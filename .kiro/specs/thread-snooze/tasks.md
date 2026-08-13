# Implementation Plan: Thread Snooze

## Overview

Adds `snoozed` thread status, snooze/un-snooze API logic, FollowupHandler extension for snoozed threads, processor reactivation on new signal, and the `snoozedUntil`/`reactivationReason` fields. All scheduler infrastructure already exists from the `signal-followup-scheduler` spec.

## Tasks

- [ ] 1. Add `snoozed` status and new thread fields to the type system
  - [ ] 1.1 Update `THREAD_STATUSES` in `src/types/index.ts`
    - Add `"snoozed"` to the `THREAD_STATUSES` array
    - Add `REACTIVATION_REASONS` const array: `["snooze_expired", "new_signal", "manual"] as const`
    - Add `ReactivationReason` type derived from the array
    - Add `snoozedUntil?: string` and `reactivationReason?: ReactivationReason` to the `Thread` interface
    - _Requirements: 1.1, 6.1, 6.2_

  - [ ] 1.2 Update thread API response schema
    - Add `snoozedUntil` (optional ISO 8601 string) and `reactivationReason` (optional enum) to the thread zod response schema in `src/api/schemas.ts`
    - Ensure `toApiThread` passes through both fields when present
    - _Requirements: 6.3_

- [ ] 2. Extend PATCH thread endpoint with snooze logic
  - [ ] 2.1 Add snooze validation to PATCH handler
    - Accept `status: "snoozed"` + required `snoozedUntil` in request body schema
    - Reject with 400 if `status = "snoozed"` without `snoozedUntil`
    - Reject with 400 if `snoozedUntil` is in the past
    - Reject with 400 if `snoozedUntil` exceeds thread retention expiration
    - Only allow snooze from `active` status (reject 409 if thread is archived/deleted/already snoozed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ] 2.2 Create schedule on snooze
    - Call `schedulerClient.createFollowup()` with suffix `"snooze"`, fire time = `snoozedUntil`
    - Message body: `{ accountId, threadId, reason: "snooze_expired" }`
    - Persist `snoozedUntil` on thread record
    - Set thread status to `snoozed`
    - On schedule creation failure: return 500, leave status unchanged
    - _Requirements: 2.5, 2.6, 2.7, 2.8_

  - [ ] 2.3 Handle un-snooze and status transitions
    - When `status: "active"` is set on a snoozed thread: cancel schedule, set `reactivationReason: "manual"`, clear `snoozedUntil`
    - When `status: "deleted"` is set on a snoozed thread: cancel schedule, clear `snoozedUntil`
    - When `status: "archived"` or `status: "deleted"` is set on an active thread that has `reactivationReason`: clear `reactivationReason`
    - _Requirements: 2.9, 5.1, 5.2, 5.3, 6.4_

  - [ ] 2.4 Write tests for snooze endpoint
    - Test snooze from active: schedule created, status = snoozed, snoozedUntil persisted
    - Test snooze without snoozedUntil: 400
    - Test snooze with past timestamp: 400
    - Test snooze from archived/deleted: 409
    - Test un-snooze (status: active from snoozed): schedule cancelled, reason = manual, snoozedUntil cleared
    - Test delete from snoozed: schedule cancelled
    - Test schedule creation failure: 500, status unchanged
    - _Requirements: 2.1–2.9, 5.1–5.3_

- [ ] 3. Extend FollowupHandler for snoozed status
  - [ ] 3.1 Add `snoozed` case to FollowupHandler.process()
    - When thread status is `snoozed`: set status to `active`, set `reactivationReason: "snooze_expired"`, notify with `reason: "followup"`
    - Existing cases (null/deleted → discard, active → notify, archived → reactivate) remain unchanged
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

  - [ ] 3.2 Write tests for FollowupHandler snoozed case
    - Test snoozed thread → reactivated to active with reason snooze_expired + notification sent
    - Test already-active thread (user manually un-snoozed before fire) → notify only, no status change
    - Test deleted thread → discard
    - _Requirements: 3.1, 3.3, 3.5_

- [ ] 4. Extend processor to reactivate snoozed threads on new signal
  - [ ] 4.1 Update processor reactivation logic
    - When new signal arrives on a thread with `status: "snoozed"`: set status to `active`, set `reactivationReason: "new_signal"`, preserve `snoozedUntil`
    - Cancel pending snooze schedule (suffix `"snooze"`)
    - ResourceNotFoundException → TRACK, continue
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ] 4.2 Write tests for processor snoozed reactivation
    - Test new signal on snoozed thread → status active, reason = new_signal, snoozedUntil preserved
    - Test schedule cancellation called with correct name
    - Test ResourceNotFoundException → continues without error
    - _Requirements: 4.1–4.5_

- [ ] 5. Final checkpoint — run full test suite
  - Run `npm test` to verify type-check + all tests pass
  - Verify no regressions in existing followup-scheduler tests

## Notes

- No infrastructure changes needed — EventBridge Scheduler group, IAM permissions, and SQS routing already exist from `signal-followup-scheduler` spec
- The `reason` field in the SQS message body is a new addition to distinguish snooze fires from calendar/followup fires in the handler. The handler uses the thread's current status as the primary discriminator, but `reason` in the message provides audit context.
- Thread list queries don't need changes — `?status=active` already excludes non-active threads; `?status=snoozed` works via the existing GSI on status
