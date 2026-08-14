# Requirements Document

## Introduction

Thread snooze = `PATCH` with `followupAt` + `status: "archived"`. This already works end-to-end (scheduler fires, handler reactivates archived → active). The only gap: the UI can't distinguish "resurfaced from snooze" vs "new signal woke it" because the processor doesn't clear `followupAt` on early wake.

## Requirements

### Requirement 1: Clear `followupAt` on new-signal reactivation

**User Story:** As a user, when a snoozed thread wakes early due to new mail, I want the UI to show that new mail arrived (not that the snooze timer fired).

#### Acceptance Criteria

1. WHEN the processor reactivates an archived thread due to a new inbound signal, IT SHALL clear `followupAt` (set to `undefined`) on the thread record
2. THE existing schedule cancellation logic (already implemented) continues to cancel the pending EventBridge schedule on reactivation

### Requirement 2: UI rendering contract

**User Story:** As a frontend developer, I want a simple rule to determine snooze state from the thread response.

#### Acceptance Criteria

1. Thread status `archived` + `followupAt` set (future) = currently snoozed, hidden from inbox
2. Thread status `active` + `followupAt` set (past) = resurfaced on schedule → show "Snoozed until {followupAt}" badge
3. Thread status `active` + `followupAt` absent = normal thread (or woke early from new signal)
4. THE API response for thread list and thread detail already includes `followupAt` when present — no change needed
