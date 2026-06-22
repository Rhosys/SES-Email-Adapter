# Requirements: SES Transactional Notifications

## Overview

Wire up SES transactional email sending across all system-to-user notification paths. Replace TRACK log placeholders with actual SES sends, implement the digest email system, and establish a shared email templating infrastructure (MJML + Mustache).

---

## Notification Paths (In Scope)

| # | Email Type | Current Status |
|---|---|---|
| 1 | **Digest email** (daily/weekly/monthly) | Settings stored (`notifications`), no sender exists |
| 2 | **Onboarding follow-up** (day 7 + 14) | TRACK log only (`onboarding-task-handler.ts:96`) |
| 3 | **Team invite** | TRACK log only (`api/app.ts:1765`) |
| 4 | **Calendar forwarding address verification** | Not implemented (TODO item) |

**Already implemented (out of scope):** Forwarding address verification (`handler.ts:271`).

---

## Cross-Cutting Requirements

### REQ-0.1: Email Template System
- Source templates: `email-templates/*.mjml` in the backend repo root
- Build step: MJML → compiled HTML (preserving `{{...}}` Mustache placeholders)
- Output lands in deploy artifact (Lambda zip): `email-templates/*.html`
- Runtime: read compiled HTML from filesystem → `Mustache.render(template, data)` → pass to `EmailService.send({ htmlBody })`
- Templating library: `mustache` (spec-compliant, loops via `{{#array}}...{{/array}}`, conditionals via `{{#flag}}...{{/flag}}`)
- `make.ts` build step addition: compile MJML + copy compiled HTML into deploy directory

### REQ-0.2: Email Format (All Emails)
- **HTML body:** Styled via MJML templates with Mustache variable injection
- **Plain text fallback:** Brief explanation of the email's purpose + link to `${APP_BASE_URL}/a/`
- Portal URL: `${APP_BASE_URL}/a/` (derived from `APP_BASE_URL` env var)

### REQ-0.3: Shared Footer (All Emails)
All emails include a shared MJML footer partial:
```mjml
<mj-section background-color="#DEE2E6">
  <mj-column padding="0 10px">
    <mj-spacer height="20px" />
    <mj-text mj-class="footer">You're getting these notifications because you're part of an active Numaeel account.</mj-text>
    <mj-text mj-class="footer">Rhosys AG · Wülflingerstrasse 151c · 8408 Winterthur · Switzerland</mj-text>
    <mj-text mj-class="footer">You think you got this email by mistake? Reply to this email or contact <a href="https://{{domain}}/a/support">{{domain}}/a/support</a></mj-text>
    <mj-text mj-class="footer"><a href="https://{{domain}}/a/unsubscribe?code={{unsubscribeCode}}&type={{emailType}}">Unsubscribe</a></mj-text>
  </mj-column>
</mj-section>
```

### REQ-0.4: Unsubscribe Headers (All Emails)
- Include `List-Unsubscribe` header: `<https://{api-domain}/accounts/{accountId}/unsubscribe?code={jwt}>`
- Include `List-Unsubscribe-Post` header: `List-Unsubscribe=One-Click`
- The `code` is a JWT signed with the existing Ed25519 KMS key (same key used for Authress service client)
- JWT header: `{ alg: "EdDSA", typ: "JWT", kid: "{AUTHRESS_KEY_ID}" }`
- JWT payload: `{ sub: accountId, scope: "unsubscribe", resource: "/accounts/{accountId}/targets/{forwardingTargetId}/types/{emailType}", iss: "https://{apiDomain}", iat: <now>, exp: <iat + 60 days> }`
- The generalized HMAC module (`src/processor/calendar/hmac-secret.ts`) is relocated to a shared `src/crypto/hmac-secret.ts` — calendar code re-imports from new location
- **Dependency:** POST unsubscribe endpoint (separate TODO — validates JWT, sets `account.digest = null`, logs audit event). Endpoint is unauthenticated (no Authress bearer token) — the JWT code IS the authorization.
- **Dependency:** Site UI at `/a/unsubscribe?code={{code}}&type={{emailType}}` (separate TODO)

### REQ-0.5: Email Tags (SES EmailTags)
All transactional emails include these tags for CloudWatch metrics attribution:
```typescript
[
  { Name: "X-Numaeel-AccountId", Value: accountId },
  { Name: "X-Numaeel-FullDate", Value: fullDate },
  { Name: "X-Numaeel-InvocationId", Value: logger.invocationId },
  { Name: "X-Numaeel-TriggerId", Value: uniqueIdRelevantToTheSendingOfThisMessage },
]
```
- Tag sanitization before sending: `Name.replace(/[^a-z0-9_-]/gi, '').slice(0, 255)`, `Value.replace(/[^a-z0-9_-]/gi, '').slice(0, 255)`
- `X-Numaeel-TriggerId` values per email type:
  - Digest: `digest-{accountId}-{date}` (e.g. `digest-acct_abc123-2026-06-21`)
  - Onboarding: `onboarding-{accountId}-{step}` (step = `followup` or `cleanup`)
  - Team invite: `invite-{inviteId}`
  - Calendar verification: `calverify-{accountId}-{address}`

### REQ-0.6: Error Handling (EmailService)
- `ConfigurationSetSendingPausedException` → permanent, non-retryable. Log error, do not retry.
- `ConfigurationSetDoesNotExistException` → permanent, non-retryable. Log error, do not retry.
- Existing transient/permanent classification remains for other errors.

### REQ-0.7: Idempotency
- The SES send is the **terminal operation** in every email-sending handler. No database writes or side effects after the send call.
- If SES returns success → ack the SQS message (done).
- If SES returns transient error → don't ack → SQS retries.
- Duplicate sends on retry are acceptable (low-impact for digests/onboarding).

### REQ-0.8: From Address
- Digest: `"Numaeel Digest" <digest@${MAIL_DOMAIN}>`
- All others (onboarding, team invite, calendar verification): `"Numaeel" <noreply@${MAIL_DOMAIN}>`
- `MAIL_DOMAIN` derived from Lambda env var.

---

## REQ-1: Digest Email

### REQ-1.1: Content
- List of the 100 most recent active arcs (sorted by `lastSignalAt` descending)
- Each arc row: urgency badge, workflow icon, sender, summary, labels, last signal timestamp
- Separate quarantine section: query `ACCT#{accountId}#QUARANTINED` GSI with `Select: COUNT`. If count > 0, show "You have {N} emails awaiting review in quarantine" with link to quarantine page.
- **Suppression:** Do not send if the account has zero active arcs.

### REQ-1.2: Subject
- Daily: `"Daily Numaeel Digest for {Day Name}"` (e.g. "Monday")
- Weekly: `"Weekly Numaeel Digest for Week {N}"` (e.g. "Week 25")
- Monthly: `"Monthly Numaeel Digest for {Month}"` (e.g. "June")

### REQ-1.3: Schedule & Trigger
- Single EventBridge Scheduler schedule: `cron(0 8 * * ? *)` (daily 08:00 UTC)
- Targets the signals SQS queue with `messageType = "digest_dispatch"`
- **Dispatcher handler:** receives `digest_dispatch`, queries GSI1 (`gsi1pk = "META"`) to list all accounts, filters in-code:
  - `if (daily || (weekly && today is Sunday) || (monthly && today is 1st))`
- Enqueues `messageType = "digest_send"` SQS message per qualifying account (body: `{ "accountId": "..." }`)
- **Worker handler:** receives `digest_send`, re-validates frequency against today's date (guards against stale retries), queries arcs, counts quarantine, renders template, sends email

### REQ-1.4: Recipient
- Send to the verified email address stored on the forwarding target (`digest.forwardingTargetId`)
- The `forwardingTargetId` is required — digest cannot be enabled without one
- Worker resolves the target → extracts verified address → sends there

### REQ-1.5: Account Model Change
- Remove `notifications` field entirely (dead: `push.enabled` never read, `email` unused)
- Add `digest` field to Account:
  ```typescript
  digest?: {
    frequency: "daily" | "weekly" | "monthly";
    forwardingTargetId: string;
  } | null;
  ```
- `undefined` / absent = never configured (no digest sent)
- `null` = explicitly disabled (no digest sent)
- Object = enabled with specified frequency
- No DDB migration needed — just change types

### REQ-1.6: PATCH API Semantics
- `PATCH /accounts/:id` with `digest` key absent → no-op
- `PATCH /accounts/:id` with `digest: null` → disables digest (stores NULL in DDB)
- `PATCH /accounts/:id` with `digest: { frequency, forwardingTargetId }` → enables/updates
- Zod schema: `.nullable().optional()` to support all three states
- If `forwardingTargetId` references a non-existent or unverified target → return 422
- **Must be thoroughly unit tested** (undefined vs null vs object PATCH semantics)

### REQ-1.7: GSI1 for Account META Rows
- Add `gsi1pk = "META"`, `gsi1sk = "ACCT#{id}"` to account META rows on create and update
- Enables digest dispatcher to query all accounts via GSI1 without a table scan
- No migration needed — new/updated accounts get the keys; existing accounts pick them up on next PATCH

---

## REQ-2: Onboarding Follow-up Emails

- Replace TRACK log in `OnboardingTaskHandler` with `EmailService.send()`
- **Suppress if all steps complete** — only send when there are outstanding action items
- Subject: `"The Next Step"`
- Body: ordered checklist of onboarding steps with ✅/❌ indicators, callout for the next incomplete step
- CTA: link to `${APP_BASE_URL}/a/onboarding`
- Step Function timing already handles scheduling (day 7 followup, day 14 cleanup)

---

## REQ-3: Team Invite Email

- Replace TRACK log in team invite route with `EmailService.send()`
- Subject: `"You've been invited to join {accountName} on Numaeel"`
- Body: invite context + CTA button to invite URL
- From: `"Numaeel" <noreply@${MAIL_DOMAIN}>`

---

## REQ-4: Calendar Forwarding Address Verification

- Same flow as existing forwarding address verification (send email with clickable link → verify endpoint)
- Targets the `calendarForwardingAddress` field
- Reuses `VerificationMailer` pattern

---

## Infrastructure Changes

- **Lambda timeout:** 30s → 60s (main Lambda)
- **SQS visibility timeout:** 900s → 120s (signals queue)
- **EventBridge Scheduler:** new recurring schedule `cron(0 8 * * ? *)` targeting SQS with `messageType = "digest_dispatch"`
- **Scheduler IAM:** reuse existing `scheduler_sqs` role (already has `sqs:SendMessage` to signals queue)

---

## Dependencies (Separate TODOs, Not This Spec)

- [ ] **Unsubscribe POST endpoint** — `POST /accounts/:id/unsubscribe` with signed code. Sets `digest = null`, logs audit event. Supports RFC 8058 `List-Unsubscribe-Post`.
- [ ] **Unsubscribe UI page** — site route `/a/unsubscribe?code={{code}}&type={{emailType}}`. Renders confirmation, calls backend POST.
- [ ] **Forwarding targets refactor** — existing TODO ("Unify forwarding targets"). Add note: `digest.forwardingTargetId` depends on this. Verification of digest target address flows through the target verification system.
- [ ] **User outbound compose/reply via SES** — separate TODO (not part of this spec)

---

## Out of Scope

- Push notification settings (removing dead `push.enabled` is in scope; push itself is device-level)
- SES templates (not using — we render locally with Mustache for full header control)
- Predictable Message-IDs (SES overwrites them on both Simple and Raw sends)
