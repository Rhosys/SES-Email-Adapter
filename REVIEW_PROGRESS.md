# Log Message Review — Progress

## Status: COMPLETE

## Completed Reviews

| # | Code | File | Level | Verdict | Notes |
|---|------|------|-------|---------|-------|
| 1 | `processor.signal.failed` | processor.ts | ERROR | **Fixed** | Removed incorrect DLQ reference. Message now says "redelivered indefinitely until root cause is fixed." |
| 2 | `processor.signal.failed` | processor.ts | TRACK→**WARN** | **Fixed** | No action needed at low volume; WARN triggers pattern-based alerting at high volume. |
| 3 | `processor.pong_reply_failed` | processor.ts | ERROR | **Keep** | User-facing confirmation fails — operator needs to check SES/domain config. |
| 4 | `processor.s3_retention_failed` | processor.ts | ERROR→**WARN** | **Discrepancy** | Decision was TRACK, but code has WARN. WARN is actually correct — it's a degraded-but-recoverable condition (signal uses default lifecycle). Updating decision to match code: WARN is right. |
| 5 | `processor.aurora_upsert_failed` | processor.ts | ERROR/WARN | **Done** | Resilience spec landed. Primary cluster = ERROR + force retry, non-primary = WARN + force retry. Implemented in `executeAuroraUpserts`. |

## In-Progress Reviews

### processor.ts

| # | Code | Level | Verdict | Notes |
|---|------|-------|---------|-------|
| 6 | `processor.forward_failed` | ERROR | **Keep** | User-configured forward rule failed. User-visible impact — recipient won't get the email. Operator must check SES quota or suppression list. |
| 7 | `processor.auto_reply_failed` | ERROR | **Keep** | User-configured auto-reply failed. Sender expected a response and won't get one. Same class as forward. |
| 8 | `processor.reputation_update_failed` | TRACK | **Keep** | Non-critical side-effect. One missed update doesn't degrade spam scoring. Pattern = DynamoDB issue, caught by metric filters on TRACK frequency. |
| 9 | `processor.quarantine_notification_failed` | TRACK→**WARN** | **Fix** | User configured quarantine-with-notification. Notification is part of the feature contract. Degraded UX = WARN. |
| 10 | `processor.notification_failed` | TRACK→**WARN** | **Fix** | Same as #9. Notifications are user-facing. Failure = degraded UX, not just a dashboard metric. |
| 11 | `processor.retention_metadata_save_failed` | WARN | **Keep** | S3 retention is applied (data safe). Metadata inconsistency = degraded condition. WARN is correct. |
| 12 | `processor.calendar_signal_save_failed` | TRACK→**WARN** | **Fix** | Calendar entry is user-visible. Missing it = degraded UX. Same class as notification failure. |
| 13 | `processor.auto_draft_save_failed` | TRACK→**WARN** | **Fix** | User configured auto-draft explicitly. Missing draft = degraded UX. |

### reindex-worker.ts

| # | Code | Level | Verdict | Notes |
|---|------|-------|---------|-------|
| 14 | `reindex.worker.segment_failed` | TRACK→**WARN** / ERROR | **Fixed** | Low count: WARN (same reasoning as processor.signal.failed #2). High count: ERROR stays. |
| 15 | `reindex.worker.malformed_signal` | TRACK | **Keep** | Pre-existing data quality issue, not operational failure. Reindex correctly skips it. |
| 16 | `reindex.worker.signal_upsert_failed` | TRACK | **Keep** | Per-signal failure within a batch. Transient, self-heals on retry. |
| 17 | `reindex.worker.s3_fetch_failed` | TRACK | **Keep** | Transient S3 error, self-heals on next reindex run. |
| 18 | `reindex.worker.regeneration_failed` | TRACK | **Keep** | Per-signal failure, same class as #16/#17. |
| 19 | `reindex.worker.unrecoverable` | TRACK→**WARN** | **Fixed** | Permanent data loss — signal can never be reindexed. Operator should investigate why s3Keys are missing or objects deleted. |

### domain-health-job.ts

| # | Code | Level | Verdict | Notes |
|---|------|-------|---------|-------|
| 20 | `domain_health.accounts_fetch_failed` | ERROR | **Keep** | Entire job run aborted. DynamoDB scan failure. |
| 21 | `domain_health.account_fetch_failed` | ERROR | **Keep** | Single account skipped. DynamoDB read failure. |
| 22 | `domain_health.update_health_failed` | ERROR | **Keep** | Health results not persisted. UI shows stale data. |
| 23 | `domain_health.notification_failed` | ERROR | **Keep** | DNS alert email not sent. Owner won't know DNS is broken. |
| 24 | `staleness_checker.account_error` | ERROR | **Keep** | DynamoDB query failure. Account's staleness report skipped. |

### feedback-processor.ts

| # | Code | Level | Verdict | Notes |
|---|------|-------|---------|-------|
| 25 | `feedback.parse_failed` | ERROR | **Keep** | Bounce/complaint won't be recorded. Suppression won't happen. |
| 26 | `feedback.process_failed` | ERROR | **Keep** | Suppression entry incomplete. Emails may continue to bouncing address. |
| 27 | `feedback.disable_forward_failed` | ERROR | **Keep** | Forward rule not disabled. Bounces will continue. |

### arc-database.ts

| # | Code | Level | Verdict | Notes |
|---|------|-------|---------|-------|
| 28 | `arc_database.search_arcs.large_result_set` | WARN | **Keep** | Performance degradation signal. Search still works, just inefficiently. |

### rule-evaluator.ts

| # | Code | Level | Verdict | Notes |
|---|------|-------|---------|-------|
| 29 | `rule_evaluator.condition.failed` | WARN | **Keep** | User's rule has broken condition. System compensated (treated as non-matching). |

### api/app.ts

| # | Code | Level | Verdict | Notes |
|---|------|-------|---------|-------|
| 30 | `forwarding.verification_email_failed` | ERROR | **Keep** | User-initiated action failed. Verification email won't arrive. |

### api/authorization-middleware.ts

| # | Code | Level | Verdict | Notes |
|---|------|-------|---------|-------|
| 31 | `authorization.sdk_error` | ERROR | **Keep** | Authress SDK failure. Returns 500 to user. |

## Review Criteria (per Warren)

For each log message, justify:
1. Why it exists
2. Why it exists at that level
3. That it is clear what action should be taken

Outcomes: **Keep**, **Fix** (change level/message), or **Remove**

Show the preceding 5 lines and call context for each message.

## Key Decisions Made

- **TRACK** = per-invocation outcome for dashboards. Transient failures that self-heal on retry. No operator action for a single occurrence.
- **WARN** = system compensated, investigate if pattern persists. User-visible degradation (notifications, calendar entries, drafts). Also used for retries at low volume.
- **ERROR** = operation failed, operator attention required now. User-configured actions that failed (forward, auto-reply), database failures in scheduled jobs, SDK failures.
- No DLQ exists on any queue — all retry indefinitely.
- Unknown error types start at TRACK; promote once failure modes are understood.
- Permanent data loss (unrecoverable signals) = WARN, not TRACK — operator should investigate the pattern.
- Side-effect path (processSideEffectRecord) uses same levels as inline path for equivalent operations.
- INFO-level terse messages (ses-forwarder, authorization-middleware) are out of scope for this review but noted as inconsistent with the verbose style.
