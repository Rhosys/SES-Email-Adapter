# Requirements Document

## Introduction

Adds an RSVP reminder notification that fires 24 hours before a calendar event's start time when the user has not yet responded to the invite. This reuses the existing signal-followup-scheduler infrastructure (EventBridge Scheduler one-shot schedules → SQS → Lambda handler) and adds a new `NotificationReason` value `"rsvp_reminder"` to distinguish from day-of reminders.

The RSVP reminder is a SECOND schedule for the same calendar event signal (alongside the existing day-of reminder). It fires at `eventStart - 24h` with suffix `rsvp.YYYYMMDD`. At fire time, the handler checks whether a `calendar_response` signal exists on the arc for the same `veventUid` — if the user has already RSVP'd, the reminder is discarded silently.

## Glossary

- **Processor**: The existing signal processing Lambda that ingests new signals and creates calendar_event signals from .ics attachments
- **Handler**: The existing FollowupHandler that processes `signal_followup` SQS messages at fire time
- **Calendar_Event_Signal**: A signal with `type: "calendar_event"` containing `CalendarEventData` (title, startTime, method, veventUid, etc.)
- **Calendar_Response_Signal**: A signal with `type: "calendar_response"`, `source: "user"`, containing the user's RSVP decision, veventUid, and respondedAt timestamp
- **RSVP_Reminder_Schedule**: An EventBridge Scheduler one-shot schedule that fires 24 hours before a calendar event's start time, with suffix `rsvp.YYYYMMDD`
- **SchedulerClient**: The existing thin wrapper over `@aws-sdk/client-scheduler` that provides `createFollowup` and `deleteFollowup`
- **NotificationReason**: A discriminator on notification payloads — currently `"new_signal" | "followup"`, to be extended with `"rsvp_reminder"`
- **ArcDb**: The database access layer that provides `getLatestCalendarResponse(accountId, arcId, veventUid)` to check whether a user has RSVP'd

## Requirements

### Requirement 1: Create RSVP Reminder Schedule on Invite Ingestion

**User Story:** As a user, I want the system to schedule an RSVP reminder when a calendar invite arrives, so that I am prompted to respond before the event.

#### Acceptance Criteria

1. WHEN a calendar_event signal is ingested with `method` equal to `REQUEST` (case-insensitive) and `startTime` more than 24 hours after the current time (compared in UTC), THE Processor SHALL create an RSVP_Reminder_Schedule with fire time equal to `startTime - 24 hours`
2. WHEN a calendar_event signal is ingested with `method` equal to `REQUEST` and `startTime` 24 hours or less after the current time (compared in UTC), THE Processor SHALL NOT create an RSVP_Reminder_Schedule (there is insufficient lead time for the reminder to be useful)
3. WHEN a calendar_event signal is ingested with `method` not equal to `REQUEST` (e.g. `CANCEL`, `REPLY`, `COUNTER`), THE Processor SHALL NOT create an RSVP_Reminder_Schedule
4. THE RSVP_Reminder_Schedule suffix SHALL be `rsvp.YYYYMMDD` where YYYYMMDD is the event start date in UTC
5. THE RSVP_Reminder_Schedule SHALL use the calendar_event signal's `id` as the `signalId` parameter (same signal used for the day-of schedule)
6. IF RSVP_Reminder_Schedule creation fails, THEN THE Processor SHALL log an ERROR and continue processing without failing the overall signal ingestion and without affecting creation of the day-of schedule
7. IF a calendar_event signal is ingested with `method` equal to `REQUEST` but `startTime` is missing or not a valid ISO 8601 timestamp, THEN THE Processor SHALL NOT create an RSVP_Reminder_Schedule and SHALL log a WARN indicating the invalid startTime

### Requirement 2: RSVP Check at Fire Time

**User Story:** As a user, I want the RSVP reminder to be suppressed if I have already responded, so that I am not nagged about invites I have already handled.

#### Acceptance Criteria

1. WHEN an RSVP_Reminder_Schedule fires, THE Handler SHALL retrieve the calendar_event signal by `signalId` from the message, extract the `veventUid` from the signal's data, and query `getLatestCalendarResponse` using the `accountId`, `arcId`, and `veventUid`
2. IF a Calendar_Response_Signal exists for the veventUid (any decision: accepted, declined, or tentative), THEN THE Handler SHALL discard the message without sending a notification and log a TRACK with reason `"already_responded"`
3. IF no Calendar_Response_Signal exists for the veventUid, THEN THE Handler SHALL send a notification with `reason: "rsvp_reminder"`
4. IF `getLatestCalendarResponse` returns a database error, THEN THE Handler SHALL return the error to the caller so that SQS retries the message via batch item failure

### Requirement 3: Distinguish RSVP Reminder from Day-Of Reminder

**User Story:** As a user, I want RSVP reminders to be visually distinct from day-of reminders, so that I know the reminder is about responding rather than attending.

#### Acceptance Criteria

1. THE NotificationReason type SHALL be extended to include `"rsvp_reminder"` as a valid value (union becomes `"new_signal" | "followup" | "rsvp_reminder"`)
2. WHEN the Handler sends an RSVP reminder notification, THE notification payload SHALL include `reason: "rsvp_reminder"`
3. WHEN the Handler sends a day-of reminder notification, THE notification payload SHALL continue to include `reason: "followup"` (existing behavior unchanged)

### Requirement 4: Cancel RSVP Reminder on User Response

**User Story:** As a user, I want the pending RSVP reminder to be cancelled when I respond to the invite, so that I do not receive a redundant reminder after I have already acted.

#### Acceptance Criteria

1. WHEN a Calendar_Response_Signal is created (via the RSVP API endpoint or the calendar-response-handler for native calendar replies), THE System SHALL attempt to delete the RSVP_Reminder_Schedule by deriving the schedule name from `accountId`, the calendar_event signal's `id`, and suffix `rsvp.YYYYMMDD` (using the event start date from the linked calendar_event signal on the same arc with matching `veventUid`)
2. IF the event `startTime` from the linked calendar_event signal is in the past, THEN THE System SHALL skip the schedule deletion attempt (the reminder has either already fired or is irrelevant)
3. IF the schedule deletion fails for any reason (throttling, permissions, ResourceNotFoundException), THEN THE System SHALL log a WARN and continue — the RSVP check at fire time (Requirement 2) provides a safety net
4. IF the linked calendar_event signal cannot be found for the given `veventUid` on the arc (deleted or never existed), THEN THE System SHALL log a TRACK, skip the schedule deletion attempt, and continue without failing the Calendar_Response_Signal creation
5. THE schedule deletion attempt SHALL be non-blocking: a failure at any stage of the cancellation flow SHALL NOT prevent the Calendar_Response_Signal from being persisted successfully

### Requirement 5: RSVP Reminder Fire-Time Validation

**User Story:** As the system, I want the RSVP reminder handler to validate the event is still relevant before notifying, so that stale or orphaned schedules do not produce spurious notifications.

#### Acceptance Criteria

1. IF the calendar_event signal referenced by `signalId` does not exist at fire time, THEN THE Handler SHALL discard the message without side effects and log a TRACK with reason `"signal_missing"`
2. IF the event `startTime` from the calendar_event signal is in the past at fire time, THEN THE Handler SHALL discard the message without side effects and log a TRACK with reason `"event_passed"`
3. IF the arc lookup or signal fetch fails due to a database error, THEN THE Handler SHALL return the message as a batch item failure so that SQS retries delivery

### Requirement 6: 24-Hour Window Is Hardcoded

**User Story:** As a developer, I want the RSVP reminder timing to be a compile-time constant, so that the system remains simple without per-account configuration overhead.

#### Acceptance Criteria

1. THE RSVP reminder fire time SHALL be computed as `eventStart - 24 hours` with no per-account override mechanism
2. THE 24-hour offset SHALL be defined as a single named constant in the source code, and all RSVP fire-time computations SHALL reference this constant (no duplicate literals)

### Requirement 7: SQS Message Type Registration

**User Story:** As a developer, I want RSVP reminder messages to have their own messageType, so that routing is explicit and consistent with the existing SQS message type pattern.

#### Acceptance Criteria

1. THE `SQS_MESSAGE_TYPES` constant SHALL include `"rsvp_reminder"` as a new entry
2. THE Lambda handler SHALL route messages with `messageType: "rsvp_reminder"` to the RSVP reminder handler via a dedicated routing branch in `handler.ts`
3. THE SQS message body for RSVP reminder schedules SHALL be `{ sqsMessageAttributeMessageType: "rsvp_reminder", accountId, signalId, arcId }`
4. THE RSVP reminder handler SHALL compose existing calendar handling classes (e.g. the calendar response lookup) rather than duplicating logic
