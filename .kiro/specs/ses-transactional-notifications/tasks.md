# Implementation Plan: SES Transactional Notifications

## Overview

Wire up SES transactional email sending across four notification paths (digest, onboarding, team invite, calendar verification). Introduces MJML+Mustache template infrastructure compiled at build time, a two-phase digest dispatch/worker pipeline on SQS, and extends the existing EmailService with new error classifications. All paths converge on the existing `EmailService.send()` method.

## Tasks

- [x] 1. Shared infrastructure and utilities
  - [x] 1.1 Create tag sanitizer module (`src/email/tag-sanitizer.ts`)
    - Implement `sanitizeTagName`, `sanitizeTagValue`, `buildEmailTags` functions
    - Tag values: strip `[^a-zA-Z0-9_-]`, truncate to 255 chars
    - `buildEmailTags` accepts `{ accountId, fullDate, invocationId, triggerId }` and returns `Array<{ Name: string; Value: string }>`
    - _Requirements: REQ-0.5_

  - [x] 1.2 Write unit tests for tag sanitizer (`tests/email/tag-sanitizer.test.ts`)
    - Test empty string, max-length overflow (>255 chars), special characters stripped, already-clean passthrough, idempotence
    - _Requirements: REQ-0.5_

  - [x] 1.3 Create unsubscribe header builder (`src/email/unsubscribe-headers.ts`)
    - `buildUnsubscribeHeaders(accountId, apiDomain, jwt)` returns `List-Unsubscribe` and `List-Unsubscribe-Post` headers
    - Format: `<https://{apiDomain}/accounts/{accountId}/unsubscribe?code={jwt}>`
    - _Requirements: REQ-0.4_

  - [x] 1.4 Create unsubscribe JWT generator (`src/email/unsubscribe-token.ts`)
    - `generateUnsubscribeToken({ accountId, forwardingTargetId, emailType, apiDomain, kmsKeyArn, keyId })` → signs EdDSA JWT via KMS Sign API
    - JWT header: `{ alg: "EdDSA", typ: "JWT", kid: keyId }`
    - JWT payload: `{ sub: accountId, scope: "unsubscribe", resource: "/accounts/{accountId}/targets/{forwardingTargetId}/types/{emailType}", iss: "https://{apiDomain}", iat, exp: iat + 5184000 }`
    - Uses `AUTHRESS_KMS_KEY_ARN` env var (existing Ed25519 key)
    - _Requirements: REQ-0.4_

  - [x] 1.5 Write unit tests for unsubscribe headers (`tests/email/unsubscribe-headers.test.ts`)
    - Verify correct URL format, header names, `List-Unsubscribe-Post` value
    - _Requirements: REQ-0.4_

  - [x] 1.6 Relocate HMAC module from `src/processor/calendar/hmac-secret.ts` to `src/crypto/hmac-secret.ts`
    - Move file to new location
    - Update imports in `src/processor/calendar/` to reference `../../crypto/hmac-secret.js`
    - _Requirements: REQ-0.4_

  - [x] 1.7 Create template renderer (`src/email/template-renderer.ts`)
    - `renderTemplate(name: string, data: Record<string, unknown>): Promise<string>`
    - Uses async `readFile` from `node:fs/promises` — no sync, no cache, no class
    - Reads from `path.join(process.cwd(), "email-templates", `${name}.html`)`
    - Renders with `Mustache.render(html, data)`
    - _Requirements: REQ-0.1_

  - [x] 1.8 Write unit tests for template renderer (`tests/email/template-renderer.test.ts`)
    - Mock `readFile`, verify Mustache variable injection with known data
    - Test missing template throws readable error
    - _Requirements: REQ-0.1_

- [x] 2. Checkpoint — shared utilities
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Account model and API changes
  - [x] 3.1 Update Account type in `src/types/index.ts`
    - Remove `notifications?: NotificationSettings` field
    - Add `digest?: { frequency: "daily" | "weekly" | "monthly"; forwardingTargetId: string } | null`
    - Add GSI1 key fields: `gsi1pk?: string; gsi1sk?: string`
    - _Requirements: REQ-1.5, REQ-1.7_

  - [x] 3.2 Update `AccountDatabase.updateAccount` in `src/database/account-database.ts`
    - Add `digest` to update params union
    - Handle three states: `undefined` → no-op (omit from expression), `null` → REMOVE attribute, object → SET attribute
    - Add `gsi1pk` and `gsi1sk` writes on create and update (values: `gsi1pk = "META"`, `gsi1sk = "ACCT#{id}"`)
    - _Requirements: REQ-1.5, REQ-1.6, REQ-1.7_

  - [x] 3.3 Update `AccountDatabase.createAccount` to include GSI1 keys
    - Set `gsi1pk: "META"`, `gsi1sk: `ACCT#${account.id}`` in the PutCommand item
    - _Requirements: REQ-1.7_

  - [x] 3.4 Update PATCH account API schema in `src/api/requests.ts`
    - Remove `notifications` from `UpdateAccountRequest`
    - Add `digest: z.object({ frequency: z.enum(["daily", "weekly", "monthly"]), forwardingTargetId: z.string() }).nullable().optional()`
    - Add validation: if `forwardingTargetId` references a non-existent or unverified target → return 422
    - _Requirements: REQ-1.5, REQ-1.6_

  - [x] 3.5 Add `queryAllAccountMetas` method to `AccountDatabase`
    - Query GSI1 with `gsi1pk = "META"`, paginate fully (handle `LastEvaluatedKey`)
    - Return `Array<{ id: string; digest?: { frequency: string; forwardingTargetId: string } | null }>`
    - _Requirements: REQ-1.3, REQ-1.7_

  - [x] 3.6 Write unit tests for PATCH digest semantics (`tests/database/account-digest.test.ts`)
    - Test `undefined` → no-op (digest field unchanged)
    - Test `null` → REMOVE attribute (digest disabled)
    - Test object → SET attribute (digest enabled)
    - Test 422 when forwardingTargetId invalid
    - _Requirements: REQ-1.6_

- [x] 4. Checkpoint — model changes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. EmailService extension
  - [x] 5.1 Add new permanent error classifications in `src/email/email-service.ts`
    - Add `ConfigurationSetSendingPausedException` and `ConfigurationSetDoesNotExistException` to `classifyError` as permanent non-retryable (same pattern as `MessageRejected`)
    - _Requirements: REQ-0.6_

  - [x] 5.2 Write unit tests for new error classifications (`tests/email/email-service-errors.test.ts`)
    - Test `ConfigurationSetSendingPausedException` → returns `ok({ messageId: "" })`
    - Test `ConfigurationSetDoesNotExistException` → returns `ok({ messageId: "" })`
    - _Requirements: REQ-0.6_

- [x] 6. MJML templates and build step
  - [x] 6.1 Create MJML templates
    - `email-templates/_footer.mjml` — shared footer partial with unsubscribe link, company address, support link
    - `email-templates/digest.mjml` — arc list table (urgency badge, workflow icon, sender, summary, labels, timestamp), quarantine section, CTA
    - `email-templates/onboarding-followup.mjml` — checklist with ✅/❌ indicators, CTA to onboarding page
    - `email-templates/team-invite.mjml` — invite context, CTA button to invite URL
    - `email-templates/calendar-verify.mjml` — verification link email (reuses VerificationMailer pattern)
    - All templates include `{{unsubscribeCode}}`, `{{domain}}`, `{{emailType}}` for footer
    - _Requirements: REQ-0.1, REQ-0.2, REQ-0.3_

  - [x] 6.2 Add MJML compilation step to `make.ts`
    - After esbuild, before upload: glob `email-templates/*.mjml` (skip `_` prefixed partials)
    - Compile each via `mjml` package → write to `dist/main/email-templates/{name}.html`
    - Preserve `{{...}}` Mustache placeholders (MJML doesn't touch them)
    - _Requirements: REQ-0.1_

  - [x] 6.3 Add `mjml` and `mustache` to package.json dependencies
    - `mjml` as devDependency (build-time only)
    - `mustache` as production dependency (runtime rendering)
    - Add `@types/mustache` as devDependency
    - _Requirements: REQ-0.1_

- [x] 7. Digest pipeline
  - [x] 7.1 Create digest frequency filter (`src/digest/digest-frequency-filter.ts`)
    - `shouldDispatchDigest(frequency: "daily" | "weekly" | "monthly", date: DateTime): boolean`
    - daily → always true; weekly → Sunday only; monthly → 1st only
    - `buildDigestSubject(frequency, date): string` — returns formatted subject per REQ-1.2
    - _Requirements: REQ-1.2, REQ-1.3_

  - [x] 7.2 Write unit tests for digest frequency filter (`tests/digest/digest-frequency-filter.test.ts`)
    - Test each frequency on matching and non-matching days (use known dates)
    - Test subject format for each frequency
    - _Requirements: REQ-1.2, REQ-1.3_

  - [x] 7.3 Create digest dispatcher (`src/digest/digest-dispatcher.ts`)
    - Receives `digest_dispatch` message type
    - Queries `queryAllAccountMetas()` — paginates GSI1 fully
    - Filters accounts: `account.digest` exists AND `shouldDispatchDigest(account.digest.frequency, today)`
    - Batch enqueues `messageType = "digest_send"` messages (body: `{ "accountId": "..." }`)
    - All-or-nothing: quit on any SQS batch send failure (no partial success)
    - _Requirements: REQ-1.3_

  - [x] 7.4 Write unit tests for digest dispatcher (`tests/digest/digest-dispatcher.test.ts`)
    - Mock GSI1 query response with various account states
    - Verify correct accounts filtered and enqueued
    - Verify batch failure → returns err (no partial sends)
    - _Requirements: REQ-1.3_

  - [x] 7.5 Create digest worker (`src/digest/digest-worker.ts`)
    - Receives `digest_send` message (body: `{ "accountId": "..." }`)
    - Load account → verify digest still enabled → re-validate frequency against today
    - Resolve `digest.forwardingTargetId` → get verified email address from target
    - Query top 100 active arcs (sorted by `lastSignalAt` desc)
    - If zero arcs → suppress, return ok
    - Count quarantined signals (`ACCT#{accountId}#QUARANTINED` GSI with `Select: COUNT`)
    - Generate unsubscribe JWT
    - Render digest template via `renderTemplate("digest", data)`
    - Build tags (`triggerId: digest-{accountId}-{date}`), headers (unsubscribe + List-Unsubscribe-Post)
    - Send via `EmailService.send()` — terminal operation, no post-send writes
    - From address: `"Numaeel Digest" <digest@${MAIL_DOMAIN}>`
    - Plain text fallback: brief summary + link to `${APP_BASE_URL}/a/`
    - _Requirements: REQ-1.1, REQ-1.2, REQ-1.3, REQ-1.4, REQ-0.2, REQ-0.4, REQ-0.5, REQ-0.7, REQ-0.8_

  - [x] 7.6 Write unit tests for digest worker (`tests/digest/digest-worker.test.ts`)
    - Test zero arcs → no send (suppression)
    - Test account deleted → no-op
    - Test digest disabled between dispatch and send → suppress
    - Test frequency mismatch on stale retry → suppress
    - Test forwarding target not found → suppress with warning
    - Test happy path: arcs returned → template rendered → email sent with correct from/tags/headers
    - _Requirements: REQ-1.1, REQ-1.4, REQ-0.7_

  - [x] 7.7 Wire digest message types into `src/handler.ts`
    - Add `digest_dispatch` → `DigestDispatcher.dispatch()`
    - Add `digest_send` → `DigestWorker.process(message)`
    - _Requirements: REQ-1.3_

- [x] 8. Checkpoint — digest pipeline
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Onboarding email integration
  - [x] 9.1 Update `OnboardingTaskHandler` to send email via SES
    - Replace TRACK log at line 96 with actual `EmailService.send()` call
    - Suppress if all onboarding steps complete (all true → no send)
    - Render `onboarding-followup` template with progress data
    - Subject: `"The Next Step"`
    - From: `"Numaeel" <noreply@${MAIL_DOMAIN}>`
    - Include unsubscribe headers + tags (`triggerId: onboarding-{accountId}-{step}`)
    - Plain text fallback with link to `${APP_BASE_URL}/a/`
    - Send is terminal operation — no DB writes after send
    - _Requirements: REQ-2, REQ-0.2, REQ-0.4, REQ-0.5, REQ-0.7, REQ-0.8_

  - [x] 9.2 Write unit tests for onboarding email send (`tests/onboarding/onboarding-email.test.ts`)
    - Test all-complete account → no send
    - Test incomplete account → email sent with correct subject and template data
    - _Requirements: REQ-2_

- [x] 10. Team invite email integration
  - [x] 10.1 Replace TRACK log in team invite route with `EmailService.send()`
    - In `src/api/app.ts` at the team invite endpoint
    - Subject: `"You've been invited to join {accountName} on Numaeel"`
    - Render `team-invite` template with invite context
    - From: `"Numaeel" <noreply@${MAIL_DOMAIN}>`
    - Include unsubscribe headers + tags (`triggerId: invite-{inviteId}`)
    - Plain text fallback with link to `${APP_BASE_URL}/a/`
    - _Requirements: REQ-3, REQ-0.2, REQ-0.4, REQ-0.5, REQ-0.8_

  - [x] 10.2 Write unit tests for team invite email (`tests/api/team-invite-email.test.ts`)
    - Test email sent with correct subject, from address, and template data
    - _Requirements: REQ-3_

- [x] 11. Calendar forwarding verification
  - [x] 11.1 Implement calendar forwarding address verification email
    - Reuse `VerificationMailer` pattern from existing forwarding address verification
    - Render `calendar-verify` template
    - From: `"Numaeel" <noreply@${MAIL_DOMAIN}>`
    - Include tags (`triggerId: calverify-{accountId}-{address}`)
    - _Requirements: REQ-4, REQ-0.5, REQ-0.8_

- [x] 12. Infrastructure changes
  - [x] 12.1 Update Lambda timeout and SQS visibility in `deploy/compute.tf`
    - Lambda timeout: 30s → 60s
    - SQS visibility timeout: 900s → 120s
    - _Requirements: Infrastructure Changes_

  - [x] 12.2 Add EventBridge Scheduler for digest dispatch in deploy/
    - Schedule: `cron(0 8 * * ? *)` (daily 08:00 UTC)
    - Target: signals SQS queue with `messageType = "digest_dispatch"`
    - IAM: reuse existing `scheduler_sqs` role
    - _Requirements: REQ-1.3, Infrastructure Changes_

- [x] 13. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- No property-based tests — all tests are static example-based (Vitest)
- Template renderer uses async `readFile` (no sync, no cache, no class)
- SQS `digest_send` body is just `{ "accountId": "..." }` — worker resolves everything else
- Digest sends to forwarding target's verified address, NOT account email
- Dispatcher is all-or-nothing: paginate GSI1 fully → filter → batch SQS send → quit on any failure
- Unsubscribe token is EdDSA JWT signed with existing KMS key (AUTHRESS_KMS_KEY_ARN)
- HMAC secret module moves from `src/processor/calendar/` to `src/crypto/`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.4", "1.6", "1.7", "6.3"] },
    { "id": 1, "tasks": ["1.2", "1.5", "1.8", "3.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.4", "3.5", "5.1"] },
    { "id": 3, "tasks": ["3.6", "5.2", "6.1"] },
    { "id": 4, "tasks": ["6.2", "7.1"] },
    { "id": 5, "tasks": ["7.2", "7.3"] },
    { "id": 6, "tasks": ["7.4", "7.5"] },
    { "id": 7, "tasks": ["7.6", "7.7", "9.1"] },
    { "id": 8, "tasks": ["9.2", "10.1"] },
    { "id": 9, "tasks": ["10.2", "11.1"] },
    { "id": 10, "tasks": ["12.1", "12.2"] }
  ]
}
```
