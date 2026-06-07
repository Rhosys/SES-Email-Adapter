# Requirements Document

## Introduction

A generic Signal Follow-Up Scheduler that re-surfaces arcs at a scheduled time. The architecture uses AWS EventBridge Scheduler one-shot schedules that send messages to the existing SQS signals queue. The Lambda handler discriminates follow-up messages via the `messageType` SQS message attribute (value `"signal_followup"`), matching the existing pattern used by `"reindex"`, `"side_effect"`, and `"draft_send"`.

Use cases: user-initiated "remind me later" (with or without archiving), calendar event day-of reminder notifications, and future "waiting for reply" auto-scheduling.

## Glossary

- **Scheduler**: The AWS EventBridge Scheduler service — creates one-shot schedules that fire at a specified time
- **Schedule**: A single EventBridge Scheduler resource with `ActionAfterCompletion: DELETE` — fires once, sends an SQS message, then self-removes
- **Schedule_Group**: An EventBridge Scheduler organizational container (namespace). All follow-up schedules belong to the `signal-followups` group. Groups support `ListSchedules` with `NamePrefix` filtering.
- **ActionAfterCompletion**: An EventBridge Scheduler setting. When set to `DELETE`, the schedule automatically deletes itself after successful invocation of the target.
- **Handler**: The existing Lambda function, invoked via the SQS event source mapping, that processes follow-up messages
- **Arc**: A materialized aggregate of related signals displayed to the user
- **Signal**: An individual inbound item (email, calendar event, etc.) belonging to an Arc
- **Processor**: The existing signal processing Lambda that ingests new signals and updates arcs
- **Notifier**: The notification subsystem that delivers push notifications to user devices
- **Notification_Reason**: A discriminator (`new_signal` | `followup`) included in notification payloads so clients differentiate notification types
- **Stale_Fire**: A Schedule fires but the arc no longer needs reactivation (deleted/missing)
- **FlexibleTimeWindow**: EventBridge Scheduler setting controlling whether a schedule fires at the exact time or within a window. We use `OFF` (exact time).
- **ActionAfterCompletion**: EventBridge Scheduler setting for post-fire behavior. We use `DELETE` (self-cleanup after firing).
- **Schedule_Name**: The identifier for a schedule, formatted as `{accountId}.{signalId}.{suffix}`, max 64 characters, matching pattern `[0-9a-zA-Z-_.]+`
- **Signals_Queue**: The existing SQS queue (`${service_name}-signals`) that feeds the Lambda via event source mapping

## Requirements

### Requirement 1: Follow-Up via PATCH Arc Endpoint

**User Story:** As a user, I want to schedule a follow-up on an arc, so that the arc re-surfaces at a time I choose regardless of whether I also archive it.

#### Acceptance Criteria

1. THE `PATCH /accounts/:id/arcs/:arcId` endpoint SHALL accept an optional `followupAt` field (ISO 8601 timestamp) in the request body, independent of any status change
2. WHEN `followupAt` is present without a status change, THE endpoint SHALL create a Schedule targeting the Signals_Queue with messageType `"signal_followup"` and leave the arc status unchanged
3. WHEN `followupAt` is present alongside `status: "archived"`, THE endpoint SHALL set the arc status to `archived` and create a Schedule targeting the Signals_Queue with messageType `"signal_followup"`
4. WHEN `status: "archived"` is present without `followupAt`, THE endpoint SHALL archive the arc without creating a Schedule
5. THE `followupAt` value SHALL be validated as a future timestamp — reject with 400 if in the past
6. THE `followupAt` value SHALL be validated as not exceeding the arc's retention expiration (createdAt + retentionDuration) — reject with 400 if beyond that bound, since the arc will be deleted by then
7. IF schedule creation fails, THEN THE endpoint SHALL return a 500 error and leave the arc status unchanged (rollback any status change that was part of the same request)

### Requirement 2: Create One-Shot Schedule

**User Story:** As the system, I want schedules to send messages to the existing SQS queue, so that follow-ups are processed by the same Lambda with SQS retry guarantees.

#### Acceptance Criteria

1. WHEN a follow-up is requested, THE Scheduler SHALL create a one-shot schedule in the `signal-followups` group with `ActionAfterCompletion: DELETE`
2. THE Schedule target SHALL be an `sqs:SendMessage` action targeting the Signals_Queue ARN
3. THE SQS message body SHALL be a JSON object containing `accountId`, `signalId`, and `arcId`
4. THE SQS message SHALL include a message attribute `messageType` with string value `"signal_followup"`
5. THE Schedule fire time SHALL use the `at()` expression format: `at(yyyy-mm-ddThh:mm:ss)`

### Requirement 3: Stale-Fire Evaluation

**User Story:** As a user, I want the system to handle follow-up fires appropriately based on the arc's current state, so that I receive useful notifications without unnecessary status changes.

#### Acceptance Criteria

1. WHEN a `signal_followup` message is processed, THE Handler SHALL retrieve the current arc state before performing any side effects
2. IF the arc does not exist or has status `deleted` at processing time, THEN THE Handler SHALL discard the message without side effects
3. IF the arc status is `active` at processing time, THEN THE Handler SHALL send a notification with `reason: "followup"` without changing the arc status (the user asked for a reminder on an already-visible arc)
4. IF the arc status is `archived` at processing time, THEN THE Handler SHALL set the arc status to `active` and send a notification with `reason: "followup"`
5. WHEN a message is discarded (arc missing or deleted), THE Handler SHALL log a TRACK with `accountId`, `arcId`, and the reason for skipping

### Requirement 4: Reactivate on New Signal

**User Story:** As a user, I want deferred arcs to reappear immediately when a new signal arrives, so that I do not miss fresh activity.

#### Acceptance Criteria

1. WHEN a new signal arrives on an arc with status `archived`, THE Processor SHALL set the arc status to `active` (existing behavior — no code change needed)
2. WHEN the Processor reactivates an archived arc, THE Processor SHALL attempt to cancel the pending Schedule by calling `DeleteSchedule` with the schedule name derived from `{accountId}.{signalId}.{suffix}`
3. IF the schedule deletion returns ResourceNotFoundException (already fired or never existed), THEN THE Processor SHALL log a TRACK and continue without error
4. IF the schedule deletion fails for another reason (throttling, permissions), THEN THE Processor SHALL log a WARN and continue processing — the stale-fire check will handle it at fire time

### Requirement 5: Notification on Reactivation

**User Story:** As a user, I want to receive a push notification when a deferred arc re-surfaces, so that I know to act on it.

#### Acceptance Criteria

1. WHEN the Handler reactivates an archived arc via follow-up message, THE Notifier SHALL send a notification with `reason` set to `followup`
2. WHEN the Processor reactivates an archived arc due to a new inbound signal, THE Notifier SHALL send a notification with `reason` set to `new_signal`
3. THE Notifier interface SHALL accept a `reason` parameter of type `"new_signal" | "followup"`
4. THE NotificationPayload SHALL include the `reason` field so clients can differentiate notification types in push notifications

### Requirement 6: Calendar Event Day-Of Surfacing

**User Story:** As a user, I want a reminder notification on the morning of a calendar event, so that I am prompted to act on it.

#### Acceptance Criteria

1. WHEN a calendar_event signal is ingested and the event startTime is in the future, THE Processor SHALL leave the arc as `active` and create a Schedule with fire time set to the start of the event day
2. THE fire time for calendar events SHALL default to 08:00 local time on the event day (using account timezone if available, otherwise UTC)
3. IF the calendar event startTime is today or in the past at ingestion time, THEN THE Processor SHALL leave the arc as `active` and not create a Schedule
4. WHEN the calendar event schedule fires and the arc is `active`, THE Handler SHALL send a notification with `reason: "followup"` without changing the arc status (per Requirement 3.3)

### Requirement 7: Schedule Naming

**User Story:** As a developer, I want schedule names to follow a deterministic format, so that lookups and cancellations work reliably.

#### Acceptance Criteria

1. THE schedule name builder SHALL accept three explicit inputs: `accountId`, `signalId`, and `suffix`
2. THE schedule name format SHALL be `{accountId}.{signalId}.{suffix}` using `.` as separator
3. THE schedule name SHALL match the EventBridge pattern `[0-9a-zA-Z-_.]+` and be at most 64 characters
4. IF the suffix would cause the full name to exceed 64 characters, THE name builder SHALL base64url-encode a SHA1 hash of the suffix and slice it to fit within the remaining character budget
5. A unit test SHALL validate that the name builder always produces names under 64 characters for all realistic input combinations

### Requirement 8: Infrastructure Provisioning

**User Story:** As a developer, I want the schedule group and IAM permissions provisioned via OpenTofu, so that schedules can be created at runtime.

#### Acceptance Criteria

1. THE Infrastructure SHALL provision an EventBridge Scheduler schedule group named `signal-followups` in the email-catcher AWS account
2. THE Infrastructure SHALL grant the Lambda execution role permissions to call `scheduler:CreateSchedule`, `scheduler:DeleteSchedule`, `scheduler:GetSchedule`, and `scheduler:ListSchedules` scoped to the `signal-followups` group
3. THE Infrastructure SHALL grant EventBridge Scheduler an IAM role with `sqs:SendMessage` permission on the Signals_Queue
4. THE existing Signals_Queue SQS policy SHALL be updated to allow EventBridge Scheduler to send messages

### Requirement 9: No DynamoDB Schedule Storage

**User Story:** As a developer, I want EventBridge Scheduler to be the sole store of schedule metadata, so that the architecture stays simple with no sync concerns.

#### Acceptance Criteria

1. THE System SHALL NOT persist schedule metadata (fire time, target arc, reason) in DynamoDB or any other data store
2. THE SQS message body SHALL carry all context required for the Handler to execute (accountId, signalId, arcId)
3. THE System SHALL use `GetSchedule` by name for per-signal schedule lookup and `ListSchedules` with `NamePrefix` for account-wide queries

### Requirement 10: SQS Message Type Registration

**User Story:** As a developer, I want the follow-up message type registered in the existing SQS message type array, so that the handler routes it correctly.

#### Acceptance Criteria

1. THE `SQS_MESSAGE_TYPES` constant SHALL include `"signal_followup"` as a new entry
2. THE Lambda handler SHALL route messages with `messageType: "signal_followup"` to the follow-up handler
3. THE follow-up handler SHALL parse the message body as `{ accountId: string, signalId: string, arcId: string }`
4. IF the message body fails to parse, THE handler SHALL log an ERROR and discard the message (no retry)
