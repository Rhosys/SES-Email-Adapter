# Requirements Document

## Introduction

Implement a draft signal send flow with an undo window for the email-catcher backend. When a user sends a draft signal, the system transitions it to `pending_send` and opens a time-limited undo window proportional to the email body word count. During the window, the user can cancel (revert to `draft`). Once the window expires without cancellation, the system sends the email via SES and transitions the signal to `sent`. This provides a safety net against accidental sends while keeping the UX responsive.

## Glossary

- **Backend**: The Hono API running on Lambda (Node.js, TypeScript) that handles HTTP requests for the email-catcher product
- **Signal**: An email event record stored in DynamoDB, identified by a discriminated ID (`USR#${uuid}` for user-authored drafts)
- **Draft_Signal**: A Signal with `status: "draft"` — user-authored, unsent, editable
- **Pending_Signal**: A Signal with `status: "pending_send"` — send initiated, within the undo window, cancellable
- **Sent_Signal**: A Signal with `status: "sent"` — email delivered via SES, immutable
- **Undo_Window**: The time period after send initiation during which the user can cancel the send and revert to draft
- **Word_Count**: The number of whitespace-delimited tokens in the signal's `textBody` field (empty or absent body = 0 words)
- **SES**: Amazon Simple Email Service v2, used to deliver outbound emails
- **SQS**: Amazon Simple Queue Service, used for async message dispatch within the single Lambda
- **SesReplySender**: The existing class that wraps SESv2 `SendEmailCommand` for outbound email delivery
- **SqsDispatcher**: The existing class that dispatches SQS messages to the signal processing queue with message type discrimination
- **Delayed_Message**: An SQS message sent with a `DelaySeconds` parameter, making it invisible to consumers until the delay expires

## Requirements

### Requirement 1: Extend signal statuses

**User Story:** As a developer, I want `pending_send` and `sent` added to the signal status enum, so that the system can represent the full lifecycle of a draft being sent.

#### Acceptance Criteria

1. THE Backend SHALL include `"pending_send"` and `"sent"` in the `SIGNAL_STATUSES` array in `src/types/index.ts`
2. THE `SignalStatus` type SHALL include `"pending_send"` and `"sent"` as valid values derived from the updated array
3. THE status comment SHALL be updated to document the new statuses: `pending_send = send initiated, within undo window; sent = delivered via SES`

### Requirement 2: Initiate send with status transition

**User Story:** As a user, I want to hit Send on a draft signal, so that the system begins the send process and opens an undo window.

#### Acceptance Criteria

1. WHEN a POST request is received at `/accounts/:accountId/arcs/:arcId/signals/:id/send`, THE Backend SHALL validate that the signal exists, belongs to the authenticated account, belongs to the specified arc, and has `status: "draft"`
2. IF the signal status is not `"draft"`, THEN THE Backend SHALL respond with HTTP 400 and error code `SIGNAL_NOT_DRAFT`
3. WHEN the signal is a valid draft, THE Backend SHALL transition the signal status to `"pending_send"` and persist the transition timestamp as `sendInitiatedAt` on the signal record
4. WHEN the status transition succeeds, THE Backend SHALL respond with HTTP 200 and the updated signal (including the new status and `sendInitiatedAt`)

### Requirement 3: Compute undo window duration from word count

**User Story:** As a user, I want the undo window to be longer for longer emails, so that I have proportionally more time to catch mistakes in substantial messages.

#### Acceptance Criteria

1. THE Backend SHALL compute the Word_Count by splitting the signal's `textBody` on whitespace (`/\s+/`) and counting the resulting non-empty tokens (absent or empty `textBody` = 0 words)
2. WHEN Word_Count is less than 50, THE Backend SHALL set the undo window duration to 10 seconds
3. WHEN Word_Count is between 50 and 199 (inclusive), THE Backend SHALL set the undo window duration to 60 seconds
4. WHEN Word_Count is between 200 and 499 (inclusive), THE Backend SHALL set the undo window duration to 180 seconds
5. WHEN Word_Count is 500 or greater, THE Backend SHALL set the undo window duration to 300 seconds
6. THE Backend SHALL return the computed `undoWindowSeconds` and `undoExpiresAt` (ISO 8601 timestamp) in the send response, so the client can display a countdown

### Requirement 4: Schedule delayed send via SQS

**User Story:** As the system, I want to schedule the actual email delivery after the undo window expires, so that the send happens automatically without a second user action.

#### Acceptance Criteria

1. WHEN the send is initiated, THE Backend SHALL dispatch the SQS delayed message BEFORE persisting the `pending_send` status to DynamoDB — if SQS dispatch fails, the send is aborted and the signal remains in `draft` (no inconsistency)
2. THE SQS message SHALL use `DelaySeconds` set to the computed undo window duration
3. THE SQS message SHALL use a new message type `"draft_send"` in the `messageType` MessageAttribute, discriminated from existing `"reindex"` and `"side_effect"` types
4. THE SQS message body SHALL contain `{ signalId, accountId, sendInitiatedAt }` — the minimum payload needed to identify and validate the send
5. THE `SQS_MESSAGE_TYPES` array in `src/types/index.ts` SHALL be extended to include `"draft_send"`
6. WHEN the delayed SQS message becomes visible, THE Backend SHALL re-read the signal from DynamoDB and verify its status is still `"pending_send"` — if the status is anything else (user cancelled, signal deleted), the message is discarded as a no-op

### Requirement 5: Cancel send (undo) via PATCH

**User Story:** As a user, I want to cancel a pending send during the undo window, so that I can fix mistakes before the email is delivered.

#### Acceptance Criteria

1. WHEN a PATCH request is received at `/accounts/:accountId/signals/:id` with `{ "status": "draft" }` and the signal has `status: "pending_send"`, THE Backend SHALL transition the signal status back to `"draft"` and clear the `sendInitiatedAt` field
2. WHEN the cancellation succeeds, THE Backend SHALL respond with HTTP 200 and the updated signal
3. IF a PATCH request attempts to set status to `"draft"` on a signal with `status: "sent"`, THEN THE Backend SHALL respond with HTTP 400 and error code `SIGNAL_ALREADY_SENT`
4. THE existing PATCH guard (`status !== "draft"`) SHALL be relaxed to allow PATCH when status is `"draft"` OR `"pending_send"`.

### Requirement 6: Execute send after delay expires

**User Story:** As the system, I want to deliver the email via SES when the undo window expires without cancellation, so that the user's intent is fulfilled automatically.

#### Acceptance Criteria

1. WHEN the SQS `"draft_send"` message becomes visible (after DelaySeconds expires), THE Backend SHALL read the signal from DynamoDB and verify its status is still `"pending_send"`
2. IF the signal status is no longer `"pending_send"` (user cancelled or signal was deleted), THEN THE Backend SHALL discard the message without error (idempotent no-op)
3. IF the signal `sendInitiatedAt` does not match the value in the SQS message, THEN THE Backend SHALL discard the message (stale message from a previous send attempt)
4. WHEN the signal is confirmed as `"pending_send"` with matching `sendInitiatedAt`, THE Backend SHALL send the email via SES using the existing SesReplySender pattern (from, to, subject, textBody)
5. WHEN SES returns success, THE Backend SHALL transition the signal status to `"sent"` and persist the SES `messageId` on the signal record
6. IF SES returns a transient error, THEN THE Backend SHALL return a failure result so the SQS message is retried (standard SQS retry behaviour)
7. IF SES returns a permanent error (e.g. suppressed address, invalid recipient), THEN THE Backend SHALL transition the signal status back to `"draft"`, log the error with code `draft_send.ses_permanent_failure`, and discard the message

### Requirement 7: Immutability of sent signals

**User Story:** As a user, I want sent signals to be read-only, so that the historical record of what was sent is preserved.

#### Acceptance Criteria

1. WHEN a PATCH request targets a signal with `status: "sent"`, THE Backend SHALL respond with HTTP 400 and error code `SIGNAL_ALREADY_SENT`
2. WHEN a DELETE request targets a signal with `status: "sent"`, THE Backend SHALL respond with HTTP 400 and error code `SIGNAL_ALREADY_SENT`
3. WHEN a PUT request targets a signal with `status: "sent"`, THE Backend SHALL respond with HTTP 400 and error code `SIGNAL_ALREADY_SENT`
4. THE existing draft guards on PUT, PATCH, and DELETE SHALL be updated to reject both `"pending_send"` and `"sent"` signals (except the specific PATCH-to-draft cancellation path in Requirement 5)

### Requirement 8: Signal record extensions

**User Story:** As a developer, I want the Signal type to carry send-related metadata, so that the API can expose undo timing and delivery tracking to clients.

#### Acceptance Criteria

1. THE Signal interface SHALL include an optional `sendInitiatedAt?: string` field (ISO 8601 timestamp of when send was initiated)
2. THE Signal interface SHALL include an optional `sentAt?: string` field (ISO 8601 timestamp of when SES confirmed delivery) — note: this field already exists for inbound email parse date, so it SHALL be repurposed for user-sent signals where `source: "user"`
3. THE Signal interface SHALL include an optional `sesMessageId?: string` field (the SES message ID returned on successful send)
4. THE `updateSignal` database method SHALL be extended to support updating `status`, `sendInitiatedAt`, and `sesMessageId` fields

### Requirement 9: Post-send arc archival preference

**User Story:** As a user, I want the option to automatically archive an arc after I send a reply, so that my inbox stays clean without manual archiving.

#### Acceptance Criteria

1. THE Account interface SHALL include an optional `afterSendAction?: "archive" | "keep_active"` field (default: `"archive"`)
2. WHEN a draft send completes successfully (signal transitions to `"sent"`), THE Backend SHALL check the account's `afterSendAction` preference
3. IF `afterSendAction` is `"archive"`, THEN THE Backend SHALL transition the signal's parent arc to `status: "archived"`
4. IF `afterSendAction` is `"keep_active"` or absent, THEN THE Backend SHALL leave the arc status unchanged
5. THE `PATCH /accounts/:id` endpoint SHALL accept `afterSendAction` as an updatable field

### Requirement 10: MX validation before send

**User Story:** As a user, I want the system to verify that recipient domains can receive email before I send, so that I don't waste time on messages that will never arrive.

#### Acceptance Criteria

1. WHEN a POST request is received at `/accounts/:accountId/arcs/:arcId/signals/:id/send`, THE Backend SHALL resolve MX records for every unique domain in the signal's `to` field before transitioning to `pending_send`
2. IF any recipient domain has no valid MX record (DNS lookup returns no MX entries and no A/AAAA fallback), THEN THE Backend SHALL respond with HTTP 422 and error code `INVALID_RECIPIENT_DOMAIN`, including the list of failing domains in the response body
3. THE MX validation SHALL NOT block the send for domains that have valid MX records — only domains with zero deliverability evidence are rejected
4. THE MX resolution SHALL use a reasonable timeout (2 seconds per domain) to avoid blocking the API response on slow DNS

### Requirement 11: Bounce-back handling via deliverability signals

**User Story:** As a user, I want to see bounce information as a distinct event in the arc thread, so that I can understand which recipients failed and take action without the original sent signal being mutated.

#### Acceptance Criteria

1. WHEN an SES bounce notification arrives (via the existing `SesFeedback` handler) for a message whose `sesMessageId` matches a user-sent signal, THE Backend SHALL create a NEW signal in the same arc with `source: "deliverability"`
2. THE `SIGNAL_SOURCES` array SHALL be extended to include `"deliverability"` as a valid source
3. THE deliverability signal SHALL include a `relatedSignalId` field linking back to the original sent signal
4. THE deliverability signal SHALL include a `bouncedRecipients` field: an array of `{ address: string, bounceType: "permanent" | "transient", reason?: string }` indicating which recipients bounced and why
5. THE deliverability signal SHALL have `status: "active"` so it appears in the arc thread alongside the sent signal
6. THE deliverability signal ID SHALL use the `SYS#${uuid}` prefix (system-created)
7. IF ALL recipient addresses in the original sent signal's `to` field received permanent bounces, THEN THE Backend SHALL also transition the original sent signal to `status: "draft"` and set `sendFailureReason: "all_recipients_bounced"` — the user can then edit and resend
8. IF only SOME recipients bounced (partial bounce), THE original sent signal SHALL remain `status: "sent"` — the deliverability signal in the thread communicates which addresses failed
9. THE Backend SHALL distinguish between permanent bounces (hard bounce — address doesn't exist) and transient bounces (soft bounce — mailbox full, temporary failure). Only permanent bounces count toward the "all recipients bounced" threshold in criterion 7
