# Design Document

## Overview

This feature introduces two foundational pieces and one new endpoint:

1. **`EmailService`** — a shared SES abstraction that all email sending flows through. Consolidates sender address, configuration set, and error handling into one place.
2. **`isValidEmail()`** — a strict email validation function that requires both zod and the RFC 5322 regex to pass, logging divergences for observability.
3. **`POST /accounts/:accountId/users`** — invite a team member by email. Creates an Authress invite, logs a TRACK placeholder for the email, returns 201.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Layer                                 │
│                                                                   │
│  POST /accounts/:id/users                                        │
│    ├── isValidEmail(body.email)                                  │
│    ├── AccessService.createInvite(accountId, email, role)        │
│    ├── logger.track("invite.email_pending_implementation", ...)  │
│    └── return 201                                                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       EmailService                                │
│                                                                   │
│  constructor(sesv2, { from, configSet })                          │
│                                                                   │
│  send(to, subject, textBody, htmlBody?, tags?)                   │
│    → Result<{ messageId }, DbError>                              │
│                                                                   │
│  sendRaw(to, rawData, tags?)                                     │
│    → Result<{ messageId }, DbError>                              │
│                                                                   │
│  Callers:                                                         │
│    • SesReplySender.sendReply()  → emailService.send()           │
│    • SesForwarder.forward()      → emailService.sendRaw()        │
│    • sesVerificationMailer       → emailService.send()           │
│    • (future) invite email       → emailService.send()           │
└─────────────────────────────────────────────────────────────────┘
```

## Data Models

### EmailService interface

```typescript
// src/email/email-service.ts

export interface EmailSendOptions {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  headers?: Array<{ Name: string; Value: string }>;
  tags?: Array<{ Name: string; Value: string }>;
  fromOverride?: string;  // override the default sender (used by reply sender)
}

export interface EmailRawOptions {
  to: string;
  rawData: Uint8Array;
  tags?: Array<{ Name: string; Value: string }>;
}

export class EmailService {
  private readonly sesv2: SESv2Client;
  private readonly from: string;
  private readonly configSet: string;

  constructor(sesv2: SESv2Client, opts: { from: string; configSet: string });

  async send(opts: EmailSendOptions): Promise<Result<{ messageId: string }, DbError>>;
  async sendRaw(opts: EmailRawOptions): Promise<Result<{ messageId: string }, DbError>>;
}
```

### isValidEmail function

```typescript
// src/email/validate-email.ts

import { z } from "zod";
import type { Logger } from "../logger.js";

const emailRegex = new RegExp(/^(?:[a-z0-9!#$%&'*+\x2f=?^_`\x7b-\x7d~\x2d]+(?:\.[a-z0-9!#$%&'*+\x2f=?^_`\x7b-\x7d~\x2d]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9\x2d]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9\x2d]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9\x2d]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i);

const zodEmail = z.string().email();

export function isValidEmail(value: string, logger: Logger): boolean {
  const zodResult = zodEmail.safeParse(value).success;
  const regexResult = emailRegex.test(value);

  if (zodResult !== regexResult) {
    logger.track("Email validation divergence between zod and RFC regex. Both must pass for the email to be considered valid.", {
      code: "email.validation_divergence",
      email: value,
      zodPassed: zodResult,
      regexPassed: regexResult,
    });
  }

  return zodResult && regexResult;
}
```

### AccessService extension

```typescript
// Added to AccessService interface in src/api/app.ts

export interface AccessService {
  // ... existing methods ...
  createInvite(accountId: string, email: string, role: AccountRole): Promise<Result<{ inviteId: string }, AuthressServiceError>>;
}
```

### Authress invite creation implementation

```typescript
// Added to AuthressAccessService class

async createInvite(accountId: string, email: string, role: AccountRole): Promise<Result<{ inviteId: string }, AuthressServiceError>> {
  try {
    const response = await this.client.invites.createInvite({
      email,
      statements: [{
        roles: [roleToRoleId(role)],
        resources: [{ resourceUri: `accounts/${accountId}` }],
      }],
    });
    return ok({ inviteId: response.data.inviteId });
  } catch (e) {
    return err(authressServiceError(e));
  }
}
```

### Updated InviteUserRequest schema

```typescript
// src/api/requests.ts — replaces the existing InviteUserRequest

export const InviteUserRequest = z.object({
  email: z.string(),  // validated via isValidEmail() in the route handler, not zod's .email()
  role: z.enum(["admin", "member", "viewer"]),
});
export type InviteUserRequest = z.infer<typeof InviteUserRequest>;
```

### Route handler pseudocode

```typescript
app.post("/accounts/:accountId/users", authz("accounts:read", c => `accounts/${c.req.param("accountId")}`), async (c) => {
  const { accountId } = c.req.param("auth");
  const body = await zParse(InviteUserRequest, c.req.raw);

  if (!isValidEmail(body.email, logger)) {
    return err(c, 400, "Invalid email address", "INVALID_EMAIL");
  }

  const inviteResult = await access.createInvite(accountId, body.email, body.role);
  if (inviteResult.isErr()) {
    logger.track("Authress invite creation failed. The Authress API rejected the invite request.", {
      code: "invite.authress_creation_failed",
      accountId,
      email: body.email,
      error: inviteResult.error,
    });
    return err(c, 422, "Failed to create invite", "INVITE_CREATION_FAILED");
  }

  const { inviteId } = inviteResult.value;
  const inviteUrl = `${APP_BASE_URL}/invite?inviteId=${inviteId}`;

  logger.track("Team invite created. SES email sending not yet implemented — wire EmailService.send() here when ready.", {
    code: "invite.email_pending_implementation",
    accountId,
    email: body.email,
    inviteId,
    inviteUrl,
  });

  return new Response(null, { status: 201 });
});
```

## File Layout

```
src/
├── email/
│   ├── email-service.ts              # NEW — EmailService class wrapping SESv2Client
│   └── validate-email.ts             # NEW — isValidEmail() with dual-check + divergence logging
├── notifier/
│   ├── external-email-signal-handler.ts  # NEW — replaces ses-reply-sender.ts + ses-forwarder.ts
│   ├── ses-reply-sender.ts           # DELETED
│   └── ses-forwarder.ts              # DELETED
├── api/
│   ├── app.ts                        # MODIFIED — new invite route, updated AccessService interface
│   ├── authress-access.ts            # MODIFIED — add createInvite() method
│   └── requests.ts                   # MODIFIED — InviteUserRequest schema changes
└── handler.ts                        # MODIFIED — instantiate EmailService, wire ExternalEmailSignalHandler, remove inline sesVerificationMailer
```

## Refactoring Plan

### SesReplySender + SesForwarder → ExternalEmailSignalHandler

`ses-reply-sender.ts` and `ses-forwarder.ts` are deleted. A single `ExternalEmailSignalHandler` class in `src/notifier/external-email-signal-handler.ts` replaces both. It implements both the `ReplySender` and `Forwarder` interfaces from `processor.ts`.

- Constructor accepts `EmailService` + `S3Client` + `Logger`
- `sendReply()` calls `emailService.send({ to, subject: "Re: ...", textBody, headers: [...], fromOverride: opts.from, tags: [...] })`
- `forward()` fetches raw MIME from S3, then calls `emailService.sendRaw({ to, rawData, tags: [...] })`
- No SES imports — all SES knowledge lives in `EmailService`

### sesVerificationMailer refactor

The inline object in `handler.ts` becomes a call to `emailService.send()`:

```typescript
const verificationMailer: VerificationMailer = {
  async sendForwardVerification(accountId, address, token) {
    const verifyUrl = `${APP_BASE_URL}/accounts/${accountId}/forwarding-addresses/${encodeURIComponent(address)}/verify?token=${token}`;
    return emailService.send({
      to: address,
      subject: "Verify your forwarding address",
      textBody: `Click the link below to verify...\n\n${verifyUrl}`,
    });
  },
};
```

## Error Handling

| Scenario | HTTP Status | Error Code | Logged |
|----------|-------------|------------|--------|
| Invalid email (isValidEmail returns false) | 400 | `INVALID_EMAIL` | No (validation is expected to fail) |
| Invalid role | 400 | `INVALID_ROLE` | No |
| Authress invite creation fails (403/422/400) | 422 | `INVITE_CREATION_FAILED` | TRACK with full error context |
| Authress service unavailable (5xx) | 422 | `INVITE_CREATION_FAILED` | TRACK with full error context |
| Email validation divergence | N/A | N/A | TRACK `email.validation_divergence` |

## Frontend (Requirement 7)

The frontend is a separate repo (`email-catcher/site`). The invite acceptance page (`/invite?inviteId=<id>`) is tracked in that project's TODO — not implemented here.
