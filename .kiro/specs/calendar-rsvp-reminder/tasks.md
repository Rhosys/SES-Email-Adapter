# Implementation Plan: Calendar RSVP Reminder

## Overview

Adds a 24-hour-before RSVP reminder to the existing signal-followup-scheduler infrastructure. The implementation creates a new `RsvpReminderHandler`, registers a new SQS message type `"rsvp_reminder"`, extends the processor to create the RSVP schedule alongside the day-of schedule, and wires cancellation into the calendar-response flow.

## Tasks

- [x] 1. Define constant and extend types
  - [x] 1.1 Create `src/scheduler/rsvp-reminder.ts` with the `RSVP_REMINDER_HOURS_BEFORE` constant and `RsvpReminderMessage` interface
    - Export `RSVP_REMINDER_HOURS_BEFORE = 24`
    - Export `RsvpReminderMessage { accountId: string; signalId: string; arcId: string }`
    - _Requirements: 6.1, 6.2_

  - [x] 1.2 Add `"rsvp_reminder"` to `SQS_MESSAGE_TYPES` in `src/types/index.ts`
    - Append `"rsvp_reminder"` to the `SQS_MESSAGE_TYPES` const array
    - _Requirements: 7.1_

  - [x] 1.3 Extend `NotificationReason` type in `src/notifier/types.ts`
    - Change union to `"new_signal" | "followup" | "rsvp_reminder"`
    - _Requirements: 3.1_

- [x] 2. Implement RsvpReminderHandler
  - [x] 2.1 Create `src/scheduler/rsvp-reminder-handler.ts` with the `RsvpReminderHandler` class
    - Constructor accepts `{ signalDb, calendarDb, notifier, logger }` (per design Component 2)
    - Implement `process(message: RsvpReminderMessage): Promise<Result<void, DbError>>`
    - Sequential logic: fetch signal → check existence → check startTime in past → check calendar response → notify or discard
    - Discard cases return `ok()` with appropriate TRACK logs (`signal_missing`, `event_passed`, `already_responded`)
    - DB errors return `err()` to trigger SQS retry
    - On notify: pass `"rsvp_reminder"` as the reason
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.2, 5.1, 5.2, 5.3_

  - [x] 2.2 Write unit tests for RsvpReminderHandler decision table (Property 2)
    - **Property 2: Fire-time notification decision**
    - **Validates: Requirements 2.1, 2.2, 2.3, 5.1, 5.2**
    - Create `tests/scheduler/rsvp-reminder-handler.spec.ts`
    - Deterministic boundary enumeration: all 4 decision table rows with mocked DB returns
    - Cases: signal missing → discard; event passed → discard; response exists → discard; no response → notify
    - Also test: DB error on getSignalById → err; DB error on getLatestCalendarResponse → err
    - Reference: `// Feature: calendar-rsvp-reminder, Property 2: Fire-time notification decision`

- [x] 3. Implement RSVP schedule creation in processor
  - [x] 3.1 Add RSVP schedule creation to `src/processor/processor.ts` after the day-of schedule block
    - Import `RSVP_REMINDER_HOURS_BEFORE` from `../scheduler/rsvp-reminder.js`
    - After the existing day-of schedule creation block: guard on `method?.toUpperCase() === "REQUEST"`, compute `reminderTime = eventStart.minus({ hours: RSVP_REMINDER_HOURS_BEFORE })`, check `reminderTime > now`
    - Call `createFollowup` with `suffix: "rsvp.YYYYMMDD"` and `sqsMessageAttributeMessageType: "rsvp_reminder"`
    - On failure: log ERROR with code `processor.calendar.rsvp_schedule_failed`, do NOT affect day-of schedule
    - Handle missing/invalid startTime: log WARN and skip (do not create RSVP schedule)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 6.1_

  - [x] 3.2 Write unit tests for RSVP schedule creation guard logic (Property 1)
    - **Property 1: RSVP schedule creation guard and computation**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 6.1**
    - Create `tests/scheduler/rsvp-schedule-creation.spec.ts`
    - Parameterized test arrays covering: method=REQUEST with startTime >24h (creates), method=REQUEST with startTime ≤24h (skips), method=CANCEL/REPLY (skips), missing startTime (skips, logs WARN)
    - Boundary timestamps: exactly 24h, 24h+1s, 23h59m59s, far future, midnight UTC crossings
    - Reference: `// Feature: calendar-rsvp-reminder, Property 1: RSVP schedule creation guard and computation`

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Wire handler routing and cancellation
  - [x] 5.1 Add routing branch for `rsvp_reminder` in `src/handler.ts`
    - Import `RsvpReminderHandler` and `RsvpReminderMessage` from `./scheduler/rsvp-reminder-handler.js`
    - Update destructuring of `SQS_MESSAGE_TYPES` to include `MSG_TYPE_RSVP_REMINDER`
    - Add `else if (messageType === MSG_TYPE_RSVP_REMINDER)` branch with body validation (accountId, signalId, arcId) and call to `rsvpReminderHandler.process()`
    - Instantiate `RsvpReminderHandler` with the existing `signalDb`, `arcDb` (for `getLatestCalendarResponse`), `notifier`, and `logger`
    - _Requirements: 7.2, 7.3, 7.4_

  - [x] 5.2 Add RSVP schedule cancellation to the calendar-response creation path in `src/api/app.ts`
    - After the `calendar_response` signal is saved: look up the linked calendar_event signal (by veventUid on the same arc)
    - If found and startTime is in the future: derive schedule name via `buildScheduleName(accountId, calendarEvent.id, "rsvp.YYYYMMDD")`, call `schedulerClient.deleteFollowup()`
    - If calendar_event not found: log TRACK, skip deletion
    - If startTime in past: skip deletion
    - If deleteFollowup fails: log WARN, continue — non-blocking
    - Entire cancellation flow must NOT prevent the calendar_response signal from being persisted
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 5.3 Write unit tests for handler routing and cancellation
    - Test SQS record with `messageType: "rsvp_reminder"` routes to RsvpReminderHandler
    - Test body fallback: no message attribute but `body.sqsMessageAttributeMessageType: "rsvp_reminder"` routes correctly
    - Test malformed payload (missing fields) → log ERROR, continue (no batch failure)
    - **Property 3: Cancellation schedule name derivation**
    - **Validates: Requirements 4.1, 4.2**
    - Test cancellation: known inputs → expected schedule name; event in past → no deletion attempt; deleteFollowup failure → non-blocking
    - Create `tests/scheduler/rsvp-reminder-routing.spec.ts` and `tests/scheduler/rsvp-cancellation.spec.ts`

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Tests use deterministic boundary enumeration — no fast-check, no random generation
- The `npm test` command (`tsc --noEmit -p tsconfig.check.json && vitest run`) is the pre-commit gate
- All `createFollowup` calls must include the required `sqsMessageAttributeMessageType` field
- The handler reads `messageType` from `record.messageAttributes?.["messageType"]?.stringValue ?? body.sqsMessageAttributeMessageType`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "3.2"] },
    { "id": 3, "tasks": ["5.1", "5.2"] },
    { "id": 4, "tasks": ["5.3"] }
  ]
}
```
