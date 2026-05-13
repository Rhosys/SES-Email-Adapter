# Log Message Review — Progress

## Status: IN PROGRESS (item #8 next)

## Completed Reviews

| # | Code | File | Level | Verdict | Notes |
|---|------|------|-------|---------|-------|
| 1 | `processor.signal.failed` | processor.ts | ERROR | **Fixed** | Removed incorrect DLQ reference. Message now says "redelivered indefinitely until root cause is fixed." |
| 2 | `processor.signal.failed` | processor.ts | TRACK→**WARN** | **Fixed** | No action needed at low volume; WARN triggers pattern-based alerting at high volume. |
| 3 | `processor.pong_reply_failed` | processor.ts | ERROR | **Keep** | User-facing confirmation fails — operator needs to check SES/domain config. |
| 4 | `processor.s3_retention_failed` | processor.ts | ERROR→**WARN** | **Discrepancy** | Decision was TRACK, but code has WARN. WARN is actually correct — it's a degraded-but-recoverable condition (signal uses default lifecycle). Updating decision to match code: WARN is right. |
| 5 | `processor.aurora_upsert_failed` | processor.ts | ERROR/WARN | **Done** | Resilience spec landed. Primary cluster = ERROR + force retry, non-primary = WARN + force retry. Implemented in `executeAuroraUpserts`. |
| 6 | `processor.forward_failed` | processor.ts | ERROR→**WARN** | **Blocked** | **Current:** ERROR, fire-and-forget (forward silently lost on failure). **Target:** WARN + force retry via batchItemFailure. **Why WARN:** The forward address was already verified by the user (went through email verification flow). Failures here are almost certainly transient (SES throttling, temporary suppression, network blip). **Why force retry:** Without retry, a transient SES hiccup permanently loses the forward — unacceptable for a user-configured action on a verified address. **Strategy:** Add force retry to the side-effect handler when forward fails. Change level to WARN once retry is in place (WARN without retry would silently swallow failures). **Followup:** Implement retry in the side-effect dispatch path, then revisit this log level. See TODO: "Forward should force retry on transient failure." |
| 7 | `processor.auto_reply_failed` | processor.ts | ERROR | **Blocked** | **Current:** ERROR, fire-and-forget (reply silently lost on failure). Uses `testReplier.pong` which is the wrong interface. **Target:** ERROR (keep — recipient is not vetted, errors are probably not transient). No retry needed because once auto-reply and auto-draft unify, the draft is always generated first — send failure leaves the draft in `status: "draft"` for user review. The draft IS the durable artifact; the send is best-effort on top. **Why ERROR stays:** Unlike forward (#6), we have no confidence the recipient address is valid. Errors here likely indicate a real problem (bad address, domain not configured for sending), not a transient blip. **Strategy:** (1) Unify `auto_reply` and `auto_draft` into a single action type with `autoSend: boolean` flag. (2) Replace `testReplier.pong` with a proper `Sender` interface. (3) Always generate draft first, then attempt send if `autoSend: true`. (4) On send failure, draft remains for user review — graceful degradation. **Followup:** Implement the unification (see TODO), then revisit this log call — it may become a WARN once the draft fallback guarantees no data loss. Also: validate reply-to addresses before sending to prevent spoofed-sender amplification attacks (see TODO). |
| 8 | `processor.reputation_update_failed` | processor.ts | TRACK→**WARN** | **Fix** | TRACK is wrong — TRACK means we can take action, but there's nothing to do here. WARN is correct: non-critical, system compensated (signal processed fine), investigate if pattern persists. |
| 9 | `processor.quarantine_notification_failed` | processor.ts | TRACK | **Keep** | Notifier shouldn't be failing in the first place. TRACK surfaces it for investigation without treating it as urgent. |
| 10 | `processor.retention_metadata_save_failed` | processor.ts | WARN | **Keep** | S3 retention already applied (data safe). Metadata mismatch = non-critical. WARN is correct. |
| 11 | `processor.calendar_signal_save_failed` | processor.ts | — | **Removed** | The synthetic calendar signal was a redundant copy with no new data. Removed the code entirely. UI should render calendar cards from the scheduling workflow signal directly (TODO added). |
| 12 | `processor.auto_draft_save_failed` | processor.ts | TRACK | **Keep** | DynamoDB failure saving a draft. Can't do anything about it immediately. Once auto-reply/auto-draft unify this becomes more critical, but for now TRACK is correct. |
| 13 | `processor.notification_failed` | processor.ts | TRACK | **Keep** | Same as #9. Notifier shouldn't be failing. TRACK surfaces it. Also fixed inconsistency: `processor.side_effect.notify_failed` in the SQS path was ERROR, changed to TRACK to match. |
| 14 | `reindex.worker.segment_failed` | reindex-worker.ts | TRACK→**WARN** / ERROR | **Fixed (partial)** | Changed low-count from TRACK to WARN. But the threshold logic itself belongs in the handler, not in each processor — TODO added for the full SQS dispatch refactor. |
| 15 | `reindex.worker.malformed_signal` | reindex-worker.ts | TRACK | **Removed** | The validation was pointless — the scan now uses `FilterExpression` to only return signal items (`#SIG#` in pk). Removed `isValidSignalForCopy`, the log call, and the associated tests. |
| 16 | `reindex.worker.signal_upsert_failed` | reindex-worker.ts | TRACK | **Keep** | Per-signal failure within a batch. We can do something — next reindex run will pick it up. Transient Aurora throttling. |

## Remaining Reviews

### reindex-worker.ts
- `reindex.worker.s3_fetch_failed` (TRACK)
- `reindex.worker.regeneration_failed` (TRACK)
- `reindex.worker.unrecoverable` (TRACK)

### domain-health-job.ts
- `domain_health.accounts_fetch_failed` (ERROR)
- `domain_health.account_fetch_failed` (ERROR)
- `domain_health.update_health_failed` (ERROR)
- `domain_health.notification_failed` (ERROR)
- `staleness_checker.account_error` (ERROR)

### feedback-processor.ts
- `feedback.parse_failed` (ERROR)
- `feedback.process_failed` (ERROR)
- `feedback.disable_forward_failed` (ERROR)

### arc-database.ts
- `arc_database.search_arcs.large_result_set` (WARN)

### rule-evaluator.ts
- `rule_evaluator.condition.failed` (WARN)

### api/app.ts
- `forwarding.verification_email_failed` (ERROR)

### api/authorization-middleware.ts
- `authorization.sdk_error` (ERROR)

## Review Criteria (per Warren)

For each log message, justify:
1. Why it exists
2. Why it exists at that level
3. That it is clear what action should be taken

Outcomes: **Keep**, **Fix** (change level/message), or **Remove**

Show the preceding 5 lines and call context for each message.

## Key Decisions Made

- **TRACK** = per-invocation outcome for dashboards. Use when there IS a concrete action to take on receiving even one instance.
- **WARN** = system compensated, investigate if pattern persists. Non-critical failures where we can't do anything immediately but should know about.
- **ERROR** = operation failed, operator attention required now.
- No DLQ exists on any queue — all retry indefinitely.
- Unknown error types start at TRACK; promote once failure modes are understood.
- Aurora upsert failure forces retry (not fire-and-forget) — resilience spec implemented this.
- Forward failures should be WARN + retry (address is pre-verified, failures are transient).
- Auto-reply and auto-draft should unify — single action with `autoSend` flag, fallback to draft on send failure.
- Must validate reply-to addresses before any outbound send to prevent spoofed-sender amplification attacks.
