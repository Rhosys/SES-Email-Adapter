# Implementation Tasks

## Task 1: Extend type definitions (R1, R8, R11)

- [x] Add `"pending_send"` and `"sent"` to `SIGNAL_STATUSES` array in `src/types/index.ts`
- [x] Add `"deliverability"` to `SIGNAL_SOURCES` array
- [x] Add `"draft_send"` to `SQS_MESSAGE_TYPES` array
- [x] Add optional fields to Signal interface: `sendInitiatedAt?: string`, `sesMessageId?: string`, `sendFailureReason?: string`, `relatedSignalId?: string`, `bouncedRecipients?: Array<{ address: string; bounceType: "permanent" | "transient"; reason?: string }>`
- [x] Add `afterSendAction?: "archive" | "keep_active"` to Account interface
- [x] Update the status comment to document `pending_send` and `sent`
- [x] Update `statusToCategory` in `src/database/stats-writer.ts` to exclude `pending_send` and `sent`

## Task 2: Undo window calculator (R3)

- [x] Create `src/api/undo-window.ts` with `computeUndoWindowSeconds(textBody: string | undefined): number`
- [x] Implement word count logic: split on `/\s+/`, filter empty, count tokens
- [x] Return 10 for <50, 60 for 50–199, 180 for 200–499, 300 for 500+
- [x] Write tests in `tests/undo-window.test.ts` covering each bracket boundary

## Task 3: MX validator (R10)

- [x] Create `src/dns/mx-validator.ts` with `validateRecipientMx(recipients, timeoutMs)` function
- [x] Extract unique domains from recipient addresses
- [x] Resolve MX records with 2s timeout per domain; fall back to A/AAAA (RFC 5321 §5 implicit MX)
- [x] Return `{ valid: boolean, invalidDomains: string[] }`
- [x] Write tests in `tests/mx-validator.test.ts` (mock `dns/promises`)

## Task 4: Draft send dispatcher (R4)

- [x] Create `src/processor/draft-send-dispatcher.ts` with `DraftSendDispatcher` class
- [x] Implement `dispatch(payload: DraftSendPayload, delaySeconds: number)` method
- [x] Send SQS message with `DelaySeconds` and `messageType: "draft_send"` attribute
- [x] Export `DraftSendPayload` interface: `{ signalId, accountId, sendInitiatedAt }`

## Task 5: Database method — updateSignalSendStatus (R8)

- [x] Add `updateSignalSendStatus` method to `ArcDatabase` in `src/database/arc-database.ts`
- [x] Support updating: `status`, `sendInitiatedAt` (set or remove), `sentAt`, `sesMessageId`, `sendFailureReason`
- [x] Use `REMOVE` expression for `sendInitiatedAt: null`
- [x] Expose through `ApiDatabaseAdapter` and `ProcessorDatabaseAdapter` in `src/database/adapters.ts`
- [x] Add to `ApiDatabase` interface in `src/api/app.ts`

## Task 6: Rewrite POST /send endpoint (R2, R3, R4, R10)

- [x] Move endpoint from `/accounts/:accountId/signals/:id/send` to `/accounts/:accountId/arcs/:arcId/signals/:id/send`
- [x] Add arc existence and ownership validation
- [x] Add signal-belongs-to-arc validation
- [x] Call `validateRecipientMx` — return 422 with `INVALID_RECIPIENT_DOMAIN` if any domain fails
- [x] Call `computeUndoWindowSeconds` on `signal.textBody`
- [x] Dispatch SQS message FIRST via `DraftSendDispatcher`
- [x] Then update DDB status to `pending_send` with `sendInitiatedAt`
- [x] Return updated signal + `undoWindowSeconds` + `undoExpiresAt` in response
- [x] Inject `DraftSendDispatcher` into the app factory deps

## Task 7: Update PATCH/PUT/DELETE guards (R5, R7)

- [x] Add `status: z.literal("draft").optional()` to `UpdateSignalRequest` in `src/api/requests.ts`
- [x] Update PATCH handler: allow when status is `"draft"` OR `"pending_send"`
- [x] When `pending_send` + body has `status: "draft"`: call `updateSignalSendStatus` to revert, clear `sendInitiatedAt`
- [x] When `pending_send` + body has content fields (subject/textBody/from/to): reject with 400
- [x] Reject PATCH/PUT/DELETE on `"sent"` signals with error code `SIGNAL_ALREADY_SENT`
- [x] Reject PUT/DELETE on `"pending_send"` signals with error code `SIGNAL_NOT_DRAFT`

## Task 8: Draft send worker (R6, R9)

- [x] Create `src/processor/draft-send-worker.ts` with `DraftSendWorker` class
- [x] Implement `process(payload: DraftSendPayload): Promise<Result<void, DbError>>`
- [x] Re-read signal from DDB; discard if not found, status ≠ `pending_send`, or `sendInitiatedAt` mismatch
- [x] Send email via `ReplySender.sendReply` (to all recipients in signal.to)
- [x] On success: update status to `sent`, set `sentAt` and `sesMessageId`
- [x] On permanent SES error: revert to `draft`, set `sendFailureReason: "ses_permanent_failure"`
- [x] On transient SES error: return err (SQS retries)
- [x] After successful send: check account `afterSendAction`; if `"archive"`, archive the arc
- [x] Write tests in `tests/draft-send-worker.test.ts`

## Task 9: Handler routing for draft_send (R6)

- [x] Destructure `MSG_TYPE_DRAFT_SEND` from `SQS_MESSAGE_TYPES` in `src/handler.ts`
- [x] Add `else if (messageType === MSG_TYPE_DRAFT_SEND)` branch in the SQS event loop
- [x] Instantiate `DraftSendDispatcher` and `DraftSendWorker` in handler singletons
- [x] Wire `DraftSendWorker` with `processorStore`, `externalEmailHandler`, and `logger`

## Task 10: Bounce handling — deliverability signals (R11)

- [x] Add method to find a signal by `sesMessageId` (query or scan with filter on `source: "user"`)
- [x] Extend `FeedbackProcessor.processFeedback` to check if bounce is for a user-sent signal
- [x] Create a `source: "deliverability"` signal in the same arc with `relatedSignalId` and `bouncedRecipients`
- [x] If ALL recipients permanently bounced: revert original signal to `draft` with `sendFailureReason: "all_recipients_bounced"`
- [x] Inject the required store methods into `FeedbackProcessor` (or extend its existing store interface)
- [x] Write tests in `tests/feedback-processor-bounce.test.ts`

## Task 11: Account afterSendAction preference (R9)

- [x] Add `afterSendAction` to `UpdateAccountRequest` schema in `src/api/requests.ts`
- [x] Add `afterSendAction` to the `updateAccount` database method's accepted fields
- [x] Verify PATCH `/accounts/:id` persists and returns the new field
