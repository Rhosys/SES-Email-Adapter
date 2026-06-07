# Requirements Document

## Introduction

The email-catcher backend processes incoming emails into arcs with workflow classification and urgency scoring. Some arcs contain items that warrant user attention — but the system currently has no mechanism to detect when actionable arcs have gone stale without user interaction. User actions (reply, compose, archive) already create signals that bump `lastSignalAt`, so an arc whose `lastSignalAt` is old and hasn't been archived represents genuinely unattended work.

This feature introduces a weekly scheduled job that identifies outstanding arcs across all accounts and emits structured log entries for each account with stale actionable arcs. The existing logging and alerting infrastructure handles downstream actions (dashboards, notifications, re-engagement triggers).

## Glossary

- **Outstanding_Arc**: An arc with `status: "active"`, `urgency` not `"silent"`, and `lastSignalAt` older than 7 days.
- **Staleness_Checker**: The weekly scheduled Lambda job that scans for outstanding arcs and emits structured log entries.
- **SIGNALS_TABLE**: The DynamoDB table storing arcs and signals.

## Requirements

### Requirement 1: Identify Outstanding Arcs

**User Story:** As a system operator, I want a weekly job to identify arcs that have gone unattended for over a week, so that I have visibility into user disengagement patterns.

#### Acceptance Criteria

1. WHEN the Staleness_Checker runs, THE Staleness_Checker SHALL identify arcs where `status` is `"active"`, `urgency` is not `"silent"`, and `lastSignalAt` is strictly older than 7 days from the current time.
2. THE Staleness_Checker SHALL include arcs of ALL workflows (including `"test"`) in the outstanding count.
3. IF an arc has no `urgency` field (undefined), THEN THE Staleness_Checker SHALL treat it as `"normal"` urgency and include it in the outstanding count.
4. THE Staleness_Checker SHALL group outstanding arcs by `accountId` for reporting purposes.

### Requirement 2: Emit Structured Log Entries

**User Story:** As a system operator, I want the staleness checker to emit structured logs per account with outstanding arcs, so that the existing alerting infrastructure can batch-notify me daily.

#### Acceptance Criteria

1. FOR EACH account with one or more outstanding arcs, THE Staleness_Checker SHALL emit a structured JSON log entry at TRACK level containing: `message: "staleness_checker.outstanding_arcs"`, `accountId`, `outstandingArcCount`, `oldestArcLastSignalAt` (the earliest `lastSignalAt` among outstanding arcs), and `timestamp`.
2. FOR accounts with zero outstanding arcs, THE Staleness_Checker SHALL not emit any log entry.
3. WHEN the Staleness_Checker completes a run, THE Staleness_Checker SHALL emit a structured JSON log entry at INFO level containing: `message: "staleness_checker.run_complete"`, `accountsWithOutstandingArcs`, `totalOutstandingArcs`, `durationMs`, and `timestamp`.

### Requirement 3: Scheduled Execution

**User Story:** As a system operator, I want the staleness checker to run on a weekly schedule, so that stale arcs are detected without excessive compute cost.

#### Acceptance Criteria

1. THE Staleness_Checker SHALL execute on a fixed schedule (once per week).
2. WHEN the Staleness_Checker starts, THE Staleness_Checker SHALL scan all active arcs across all accounts using the GSI sorted by `lastSignalAt`.
3. THE Staleness_Checker SHALL complete processing within a single Lambda invocation timeout (15 minutes maximum).
4. IF the Staleness_Checker encounters an error processing a single account, THEN THE Staleness_Checker SHALL log the error at error level and continue processing remaining accounts.
5. THE Staleness_Checker SHALL process arcs in `lastSignalAt` ascending order so that the oldest unattended arcs are evaluated first.
