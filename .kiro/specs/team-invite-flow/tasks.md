# Tasks

## Task 1: Create EmailService class

- [x] Create `src/email/email-service.ts` with:
  - `EmailSendOptions` interface: `to`, `subject`, `textBody`, optional `htmlBody`, optional `headers` array, optional `tags` array, optional `fromOverride`
  - `EmailRawOptions` interface: `to`, `rawData` (Uint8Array), optional `tags` array
  - `EmailService` class constructor accepting `SESv2Client` and `{ from: string; configSet: string }`
  - `send(opts: EmailSendOptions): Promise<Result<{ messageId: string }, DbError>>` — builds `SendEmailCommand` with `Simple` content, applies `from`/`configSet`/`fromOverride`/`headers`/`tags`
  - `sendRaw(opts: EmailRawOptions): Promise<Result<{ messageId: string }, DbError>>` — builds `SendEmailCommand` with `Content.Raw`, applies `from`/`configSet`/`tags`
- [x] Write tests for `EmailService.send()`: successful send returns Ok with messageId, SES error returns Err with DbError, configSet omitted when empty string, fromOverride used when provided, headers included when provided
- [x] Write tests for `EmailService.sendRaw()`: successful raw send returns Ok with messageId, SES error returns Err
- [x] Commit: `git add src/email/email-service.ts tests/email/email-service.spec.ts` then commit

**Validates:** Requirement 1 (criteria 1, 2, 6)

## Task 2: Create isValidEmail function

- [x] Create `src/email/validate-email.ts` with:
  - The RFC 5322 `emailRegex` constant
  - `isValidEmail(value: string, logger: Logger): boolean` — runs both `z.string().email().safeParse(value)` and `emailRegex.test(value)`, returns `true` only if both pass
  - Logs TRACK with code `email.validation_divergence` when the two checks disagree, including the input value and which passed/failed
- [x] Write tests: both pass → true, both fail → false, zod passes but regex fails → false + TRACK logged, regex passes but zod fails → false + TRACK logged
- [x] Commit: `git add src/email/validate-email.ts tests/email/validate-email.spec.ts` then commit

**Validates:** Requirement 2 (criteria 1, 2, 3, 4)

## Task 3: Create ExternalEmailSignalHandler

- [x] Create `src/notifier/external-email-signal-handler.ts`:
  - Class implements both `ReplySender` and `Forwarder` interfaces from `src/processor/processor.ts`
  - Constructor accepts `EmailService`, `S3Client`, `Logger`, and `emailBucket: string`
  - `sendReply(opts)` delegates to `emailService.send()` with `fromOverride: opts.from`, subject prefixed with `Re: `, `In-Reply-To`/`References` headers, `type: "reply"` tag
  - `forward(s3Key, toAddress, accountId)` fetches raw MIME from S3, delegates to `emailService.sendRaw()` with `type: "forward"` and `accountId` tags
  - No SES imports in this file
- [x] Write tests for `sendReply()`: calls emailService.send with correct options, returns messageId
- [x] Write tests for `forward()`: fetches from S3, calls emailService.sendRaw with raw bytes
- [x] Commit: `git add src/notifier/external-email-signal-handler.ts tests/notifier/external-email-signal-handler.spec.ts` then commit

**Validates:** Requirement 1 (criteria 3, 4)

## Task 4: Refactor handler.ts composition root

- [x] Instantiate `EmailService` in `handler.ts` with the existing `sesv2` client, `noreply@${MAIL_DOMAIN}` (derived from `MAIL_DOMAIN`), and `CONFIG_SET`
- [x] Replace `new SesReplySender(sesv2)` and `new SesForwarder(logger, sesv2, s3)` with a single `new ExternalEmailSignalHandler(emailService, s3, logger, EMAIL_BUCKET)`
- [x] Wire `ExternalEmailSignalHandler` as both `replySender` and `forwarder` in the processor options
- [x] Replace the inline `sesVerificationMailer` object with a version that calls `emailService.send()`
- [x] Delete `src/notifier/ses-reply-sender.ts`
- [x] Delete `src/notifier/ses-forwarder.ts`
- [x] Verify `npm run build` passes
- [x] Verify `npm run test` passes
- [x] Commit: stage only `src/handler.ts` and the deleted files (`git add src/handler.ts src/notifier/ses-reply-sender.ts src/notifier/ses-forwarder.ts`) then commit

**Validates:** Requirement 1 (criteria 3, 5)

## Task 5: Add createInvite to AccessService

- [x] Add `createInvite(accountId: string, email: string, role: AccountRole): Promise<Result<{ inviteId: string }, AuthressServiceError>>` to the `AccessService` interface in `src/api/app.ts`
- [x] Implement `createInvite()` in `AuthressAccessService`:
  - Call `this.client.invites.createInvite({ email, statements: [{ roles: [roleToRoleId(role)], resources: [{ resourceUri: "accounts/${accountId}" }] }] })`
  - Extract `inviteId` from response
  - On success: return `ok({ inviteId })`
  - On error: return `err(authressServiceError(e))`
- [x] Add a no-op mock for `createInvite` in the test helper `makeAccess()` in `tests/api/api.spec.ts`
- [x] Commit: `git add src/api/app.ts src/api/authress-access.ts tests/api/api.spec.ts` then commit

**Validates:** Requirement 4 (criteria 1, 2, 3)

## Task 6: Update InviteUserRequest schema and route handler

- [x] Change `InviteUserRequest` in `src/api/requests.ts` from `{ userId: z.string(), role: AccountRole }` to `{ email: z.string(), role: z.enum(["admin", "member", "viewer"]) }`
- [x] Replace the existing `POST /accounts/:accountId/users` route handler in `src/api/app.ts`:
  - Change authz permission from `"users:write"` to `"accounts:read"` on resource `accounts/${accountId}`
  - Parse body with `zParse(InviteUserRequest, ...)`
  - Validate email with `isValidEmail(body.email, logger)` — return 400 `INVALID_EMAIL` if false
  - Call `access.createInvite(accountId, body.email, body.role)`
  - On Authress error: log TRACK with code `invite.authress_creation_failed`, return 422 `INVITE_CREATION_FAILED`
  - On success: log TRACK with code `invite.email_pending_implementation` containing email, inviteId, inviteUrl
  - Return `new Response(null, { status: 201 })`
- [x] Import `isValidEmail` from `../email/validate-email.js` in `app.ts`
- [ ] Verify `npm run build` passes
- [ ] Verify `npm run test` passes
- [x] Commit: `git add src/api/app.ts src/api/requests.ts` then commit

**Validates:** Requirements 3, 4, 5, 6

## Task 7: Write tests for the invite endpoint

- [x] Add test: valid email + valid role + successful Authress invite → 201
- [x] Add test: invalid email (fails isValidEmail) → 400 with `INVALID_EMAIL`
- [x] Add test: missing role → 400
- [x] Add test: invalid role value → 400
- [x] Add test: Authress createInvite returns error → 422 with `INVITE_CREATION_FAILED`
- [x] Add test: access service not configured (no access) → 501
- [x] Commit: `git add tests/api/api.spec.ts` then commit

**Validates:** Requirements 3, 4, 5, 6

## Task 8: Update TODO.md

- [x] Add "Team invite email via SES" to the "Review all locations where we might want to send emails to users" section in `TODO.md`, referencing the TRACK log at `invite.email_pending_implementation`
- [x] Remove the old `POST /accounts/:id/users accept { email, role }` TODO item from the frontend contract comparison section
- [x] Commit: `git add TODO.md` then commit

**Validates:** Requirement 5 (criteria 2)
