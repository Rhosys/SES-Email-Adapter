# Requirements Document

## Introduction

Thread snooze allows users to hide a thread until a future time, then resurface it with clear context about why it reappeared. Builds on the existing `signal-followup-scheduler` infrastructure (EventBridge Scheduler, `signal_followup` SQS message type, `FollowupHandler`).

The key UX insight: when a snoozed thread comes back, the user needs to immediately understand *why* it appeared — not just that it's new. The thread card shows "Snoozed until today" and the detail view shows "This thread was snoozed and resurfaced at {time}".

## Glossary

- **Snooze**: User-initiated action to hide a thread until a chosen future time
- **Resurface**: The thread becomes `active` again after the snooze timer fires
- **ReactivationReason**: Discriminator indicating why a snoozed thread became active (`snooze_expired | new_signal | manual`)
- **SnoozedUntil**: The ISO 8601 timestamp the user originally chose when snoozing — persisted for UI display after resurfacing
- **FollowupHandler**: Existing handler from `signal-followup-scheduler` spec that processes timed re-activation messages

## Requirements

### Requirement 1: Thread Status — Add `snoozed`

**User Story:** As a user, I want snoozed threads to have their own status, so that they are hidden from my default inbox view but accessible via a filter.

#### Acceptance Criteria

1. THE `THREAD_STATUSES` constant SHALL include `"snoozed"` as a valid status value
2. THE default inbox query (status = `active`) SHALL NOT return snoozed threads
3. THE `?status=snoozed` filter SHALL return only snoozed threads
4. THE "All" view SHALL include snoozed threads alongside other statuses

### Requirement 2: Snooze API Endpoint

**User Story:** As a user, I want to snooze a thread to a specific time, so that it disappears from my inbox and returns when I need it.

#### Acceptance Criteria

1. THE `PATCH /accounts/:id/threads/:threadId` endpoint SHALL accept `status: "snoozed"` alongside a required `snoozedUntil` field (ISO 8601 timestamp)
2. WHEN `status: "snoozed"` is set without `snoozedUntil`, THE endpoint SHALL reject with 400 ("snoozedUntil is required when snoozing")
3. WHEN `snoozedUntil` is in the past, THE endpoint SHALL reject with 400
4. WHEN `snoozedUntil` exceeds the thread's retention expiration, THE endpoint SHALL reject with 400
5. THE endpoint SHALL persist `snoozedUntil` on the thread record
6. THE endpoint SHALL create an EventBridge Schedule (reusing existing `schedulerClient.createFollowup()`) targeting the signals queue with `messageType: "signal_followup"`
7. THE schedule message body SHALL include `accountId`, `threadId`, and a new `reason: "snooze_expired"` field
8. IF schedule creation fails, THE endpoint SHALL return 500 and leave the thread status unchanged
9. THE `snoozedUntil` field SHALL be cleared when the thread transitions to any non-snoozed status (active, archived, deleted)

### Requirement 3: Snooze Resurfacing

**User Story:** As a user, I want snoozed threads to reappear as active when the timer fires, with context about why they resurfaced.

#### Acceptance Criteria

1. WHEN the `FollowupHandler` processes a message for a thread with status `snoozed`, IT SHALL set the thread status to `active`
2. THE handler SHALL persist `reactivationReason: "snooze_expired"` on the thread record
3. THE handler SHALL send a notification with `reason: "followup"` (reusing existing notifier interface)
4. THE `reactivationReason` field SHALL be included in the thread API response so the UI can render the snooze badge
5. IF the thread status is NOT `snoozed` at fire time (user manually un-snoozed or thread was deleted), THE handler SHALL follow existing stale-fire logic (discard if deleted/missing, notify-only if already active)

### Requirement 4: New Signal on Snoozed Thread

**User Story:** As a user, I want snoozed threads to immediately reappear when new mail arrives on them, so that I don't miss fresh activity.

#### Acceptance Criteria

1. WHEN a new signal arrives on a thread with status `snoozed`, THE processor SHALL set the thread status to `active`
2. THE processor SHALL persist `reactivationReason: "new_signal"` on the thread record
3. THE processor SHALL cancel the pending snooze schedule (call `schedulerClient.deleteFollowup()`)
4. IF schedule deletion returns ResourceNotFoundException, THE processor SHALL log TRACK and continue
5. THE `snoozedUntil` field SHALL be preserved (not cleared) so the UI can show "Was snoozed until {date}, woke early due to new mail"

### Requirement 5: Manual Un-Snooze

**User Story:** As a user, I want to manually un-snooze a thread by setting its status back to active, cancelling the timer.

#### Acceptance Criteria

1. WHEN `PATCH /accounts/:id/threads/:threadId` sets `status: "active"` on a snoozed thread, THE endpoint SHALL cancel the pending snooze schedule
2. THE endpoint SHALL persist `reactivationReason: "manual"` on the thread record
3. THE endpoint SHALL clear `snoozedUntil` (manual un-snooze = user no longer cares about the original target time)

### Requirement 6: Thread Model Fields

**User Story:** As a developer, I want the thread model to carry snooze context, so that the API response provides all data needed for UI rendering.

#### Acceptance Criteria

1. THE `Thread` interface SHALL include an optional `snoozedUntil?: string` field (ISO 8601 timestamp)
2. THE `Thread` interface SHALL include an optional `reactivationReason?: "snooze_expired" | "new_signal" | "manual"` field
3. THE API response for thread list and thread detail SHALL include both fields when present
4. THE `reactivationReason` field SHALL be cleared when the user explicitly archives or deletes the thread (acknowledging the resurfacing)

### Requirement 7: Snooze Presets (API Contract)

**User Story:** As a frontend developer, I want the snooze API to accept an ISO timestamp so the UI can offer presets (later today, tomorrow, next week, pick a date) computed client-side.

#### Acceptance Criteria

1. THE API SHALL accept `snoozedUntil` as an ISO 8601 timestamp — all preset computation happens client-side
2. THE API SHALL NOT define or enforce preset values — the backend is time-agnostic beyond "must be in the future"
3. For `travel` workflows with `workflowData.departureDate`, THE UI MAY offer "Remind me 24 hours before departure" — this is a client-side computation, not a backend concern
