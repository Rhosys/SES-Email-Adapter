# Requirements Document

## Introduction

Implement a team member invitation flow for the email-catcher backend, and introduce a shared `EmailService` abstraction that consolidates all SES sending behind a single class. The invite flow allows an account admin to invite a new user by email address. The backend creates an invite in Authress, logs a TRACK message for the invitation email (SES sending deferred), and the recipient accepts the invite through the frontend UI.

## Glossary

- **Backend**: The Hono API running on Lambda (Node.js, TypeScript) that handles HTTP requests for the email-catcher product
- **Authress**: The external RBAC/access control service used for managing user permissions and invites (`@authress/sdk`)
- **Invite**: A pending invitation record created in Authress that grants access to an account upon acceptance
- **Invite_URL**: The frontend URL `https://email.rhosys.cloud/invite?inviteId=<id>` that the recipient clicks to accept the invite
- **AccessService**: The backend interface responsible for managing user access records in Authress
- **Recipient**: The person identified by email address who receives the invitation email
- **AccountRole**: One of "admin", "member", or "viewer"
- **EmailService**: The shared SES abstraction that wraps `SendEmailCommand` — all email sending in the project goes through this class
- **emailRegex**: The RFC 5322-compliant regex used for email validation across the project

## Requirements

### Requirement 1: Shared EmailService abstraction

**User Story:** As a developer, I want a single class that wraps all SES email sending, so that email configuration (sender address, configuration set, error handling) is consistent and not duplicated across multiple callers.

#### Acceptance Criteria

1. THE Backend SHALL have an `EmailService` class that wraps `SESv2Client` and exposes a `send()` method accepting: `to`, `subject`, `textBody`, and optional `htmlBody`
2. THE `EmailService` SHALL derive the sender address from `MAIL_DOMAIN` (as `noreply@${MAIL_DOMAIN}`) and read the configuration set (`SES_CONFIGURATION_SET`) from its constructor, applying them to every `SendEmailCommand`
3. THE `SesReplySender` and `SesForwarder` SHALL be merged into a single `ExternalEmailSignalHandler` class that implements both `ReplySender` and `Forwarder` interfaces, delegating all email sending to `EmailService`
4. THE `ExternalEmailSignalHandler` SHALL NOT import any SES types — all SES knowledge lives exclusively in `EmailService`
5. THE `sesVerificationMailer` inline implementation in `handler.ts` SHALL be refactored to call `EmailService.send()`
6. THE `EmailService` SHALL return a `Result<{ messageId: string }, DbError>` from `send()`

### Requirement 2: Email validation with divergence logging

**User Story:** As a developer, I want a single email validation function that runs both zod and the RFC regex, logging when they disagree, so that we can detect edge cases while being maximally strict.

#### Acceptance Criteria

1. THE `EmailService` (or an exported standalone function) SHALL expose an `isValidEmail(value: string): boolean` method
2. THE method SHALL run both `z.string().email().safeParse(value)` and the project's `emailRegex.test(value)`
3. THE method SHALL return `true` only if BOTH checks pass — if either rejects the input, the result is `false` (intersection/strictest)
4. IF the two checks produce different results (one passes, the other fails), THEN THE method SHALL log a TRACK message with code `email.validation_divergence` including the input value and which check passed/failed
5. THE invite endpoint SHALL use `isValidEmail()` to validate the email field instead of inline zod schema validation

### Requirement 3: Accept invite request with email and role

**User Story:** As an account admin, I want to invite a team member by email address and role, so that I can grant access without needing to know their user ID upfront.

#### Acceptance Criteria

1. WHEN a POST request is received at `/accounts/:accountId/users` with a JSON body containing `email` and `role`, THE Backend SHALL validate the email using `isValidEmail()` and the role against the AccountRole enum ("admin", "member", "viewer")
2. IF the `email` field is missing or `isValidEmail()` returns false, THEN THE Backend SHALL respond with HTTP 400 and error code `INVALID_EMAIL`
3. IF the `role` field is missing or not one of the valid AccountRole values ("admin", "member", "viewer"), THEN THE Backend SHALL respond with HTTP 400 and error code `INVALID_ROLE`
4. THE Backend SHALL require the requesting user to have `accounts:read` permission on the account resource — Authress handles the fine-grained invite permission check internally

### Requirement 4: Create invite in Authress

**User Story:** As the system, I want to create an invite record in Authress, so that the recipient gains the correct role upon acceptance.

#### Acceptance Criteria

1. WHEN the request body is valid, THE AccessService SHALL create an invite in Authress using the Authress SDK's invite API, specifying the recipient email and the target account role mapped to the account resource
2. WHEN Authress returns the created invite, THE AccessService SHALL extract the `inviteId` from the response for use in the invitation email
3. IF Authress returns a 403, 422, or 400 error during invite creation, THEN THE Backend SHALL log the error with context (accountId, email, error details) and respond with HTTP 422 and error code `INVITE_CREATION_FAILED`
4. IF an invite already exists for the same email and account, THEN THE AccessService SHALL create a new invite replacing the previous pending invite, so that the recipient receives a fresh invitation link

### Requirement 5: Log invitation email (SES deferred)

**User Story:** As an account admin, I want the system to record that an invitation email needs to be sent, so that the email can be implemented when the SES sending strategy is finalised.

#### Acceptance Criteria

1. WHEN the invite is successfully created in Authress, THE Backend SHALL log a TRACK message containing: the recipient email, the account name, the inviteId, and the composed Invite_URL (`https://email.rhosys.cloud/invite?inviteId=<inviteId>`)
2. THE TRACK log message SHALL use code `invite.email_pending_implementation` to clearly indicate SES sending needs to be wired here
3. THE Backend SHALL NOT block the response on email delivery — the invite is valid regardless of whether the email is sent

### Requirement 6: Return invite confirmation response

**User Story:** As a frontend client, I want to know the invite was created successfully.

#### Acceptance Criteria

1. WHEN the Authress invite creation succeeds, THE Backend SHALL respond with HTTP 201 and an empty body
