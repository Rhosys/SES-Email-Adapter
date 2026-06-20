# Design Document

## Overview

Implements the draft signal send flow with undo window, MX validation, post-send arc archival, and bounce-back handling via deliverability signals. The design leverages existing infrastructure: SQS delayed messages for scheduling, `ExternalEmailSignalHandler` for SES delivery, `FeedbackProcessor` for bounce routing, and `dns/promises` for MX resolution.

## Architecture

### State Machine

```
draft ──[POST /send]──→ pending_send ──[SQS delay expires]──→ sent
  ↑                          │                                   │
  │                          │                                   │
  └──[PATCH status:draft]────┘                                   │
  └──[SES permanent error]───────────────────────────────────────┘
  └──[all recipients bounced]────────────────────────────────────┘
```

### Send Initiation Sequence (POST /arcs/:arcId/signals/:id/send)

```
Client                    API Handler              DNS              SQS              DynamoDB
  │                          │                     │                │                  │
  ├─POST /send──────────────→│                     │                │                  │
  │                          ├─resolve MX─────────→│                │                  │
  │                          │←─MX results─────────│                │                  │
  │                          │                     │                │                  │
  │                          │  [if any domain has no MX → 422]     │                  │
  │                          │                     │                │                  │
  │                          ├─compute undoWindowSeconds            │                  │
  │                          ├─SendMessage(DelaySeconds)───────────→│                  │
  │                          │←─ok──────────────────────────────────│                  │
  │                          ├─UpdateItem(status=pending_send)────────────────────────→│
  │                          │←─updated signal─────────────────────────────────────────│
  │←─200 { signal, undoWindowSeconds, undoExpiresAt }               │                  │
```

SQS dispatch happens BEFORE DynamoDB write. If SQS fails, the signal stays `draft` — no inconsistency. If DDB fails after SQS succeeds, the delayed message will fire, re-read the signal, find it still `draft`, and discard (no-op).

### Delayed Send Execution (SQS consumer)

```
SQS                     Handler                  DynamoDB           SES              DynamoDB
  │                       │                        │                │                  │
  ├─message visible──────→│                        │                │                  │
  │                       ├─GetItem(signalId)─────→│                │                  │
  │                       │←─signal────────────────│                │                  │
  │                       │                        │                │                  │
  │                       │  [if status ≠ pending_send → discard]   │                  │
  │                       │  [if sendInitiatedAt ≠ msg → discard]   │                  │
  │                       │                        │                │                  │
  │                       ├─send email─────────────────────────────→│                  │
  │                       │←─{ messageId }──────────────────────────│                  │
  │                       ├─UpdateItem(status=sent, sesMessageId)─────────────────────→│
  │                       │                        │                │                  │
  │                       │  [if afterSendAction=archive → archive arc]                │
```

## Data Model Changes

### Signal interface additions

```typescript
// In src/types/index.ts — Signal interface
export interface Signal {
  // ... existing fields ...

  // Send flow fields (only present on source: "user" signals)
  sendInitiatedAt?: string;    // ISO 8601 — when POST /send was called
  sesMessageId?: string;       // SES message ID after successful delivery
  sendFailureReason?: string;  // "all_recipients_bounced" | "ses_permanent_failure"

  // Deliverability signal fields (only present on source: "deliverability" signals)
  relatedSignalId?: string;    // ID of the sent signal this bounce relates to
  bouncedRecipients?: Array<{
    address: string;
    bounceType: "permanent" | "transient";
    reason?: string;
  }>;
}
```

### Status and source extensions

```typescript
// Updated SIGNAL_STATUSES
export const SIGNAL_STATUSES = [
  "active", "block_hidden", "block_reject", "report_violation",
  "quarantine_visible", "quarantine_hidden",
  "draft", "pending_send", "sent"
] as const;

// Updated SIGNAL_SOURCES
export const SIGNAL_SOURCES = ["email", "system", "user", "deliverability"] as const;

// Updated SQS_MESSAGE_TYPES
export const SQS_MESSAGE_TYPES = ["reindex", "side_effect", "draft_send"] as const;
```

### Account interface addition

```typescript
export interface Account {
  // ... existing fields ...
  afterSendAction?: "archive" | "keep_active";  // default: "keep_active"
}
```

### DraftSendPayload (SQS message body)

```typescript
export interface DraftSendPayload {
  signalId: string;
  accountId: string;
  sendInitiatedAt: string;
}
```

## Component Design

### 1. Undo Window Calculator (`src/api/undo-window.ts`)

Pure function, no dependencies.

```typescript
export function computeUndoWindowSeconds(textBody: string | undefined): number {
  const wordCount = textBody?.trim().split(/\s+/).filter(Boolean).length ?? 0;
  if (wordCount < 50) return 10;
  if (wordCount < 200) return 60;
  if (wordCount < 500) return 180;
  return 300;
}
```

### 2. MX Validator (`src/dns/mx-validator.ts`)

Uses `dns/promises` (already imported in `dns-checker.ts`). Resolves MX for recipient domains with a per-domain timeout.

```typescript
import dns from "dns/promises";

export interface MxValidationResult {
  valid: boolean;
  invalidDomains: string[];
}

export async function validateRecipientMx(
  recipients: Array<{ address: string }>,
  timeoutMs: number = 2000,
): Promise<MxValidationResult> {
  const domains = [...new Set(recipients.map(r => r.address.split("@")[1]!))];
  const invalidDomains: string[] = [];

  await Promise.all(domains.map(async (domain) => {
    const hasMx = await resolveWithTimeout(domain, timeoutMs);
    if (!hasMx) invalidDomains.push(domain);
  }));

  return { valid: invalidDomains.length === 0, invalidDomains };
}

async function resolveWithTimeout(domain: string, timeoutMs: number): Promise<boolean> {
  try {
    const result = await Promise.race([
      dns.resolveMx(domain),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return Array.isArray(result) && result.length > 0;
  } catch {
    // Fallback: check A/AAAA record (RFC 5321 §5 implicit MX)
    try {
      const a = await Promise.race([
        dns.resolve4(domain),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);
      return Array.isArray(a) && a.length > 0;
    } catch {
      return false;
    }
  }
}
```

### 3. Draft Send Dispatcher (`src/processor/draft-send-dispatcher.ts`)

Extends the existing SQS dispatch pattern. Sends a delayed message with the `draft_send` message type.

```typescript
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import { SQS_MESSAGE_TYPES } from "../types/index.js";

export interface DraftSendPayload {
  signalId: string;
  accountId: string;
  sendInitiatedAt: string;
}

export class DraftSendDispatcher {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly logger: Logger;

  constructor(queueUrl: string, client: SQSClient, logger: Logger) {
    this.queueUrl = queueUrl;
    this.client = client;
    this.logger = logger;
  }

  async dispatch(payload: DraftSendPayload, delaySeconds: number): Promise<Result<void, DbError>> {
    try {
      await this.client.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(payload),
        DelaySeconds: delaySeconds,
        MessageAttributes: {
          messageType: { DataType: "String", StringValue: SQS_MESSAGE_TYPES[2] },
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
```

### 4. Draft Send Worker (`src/processor/draft-send-worker.ts`)

Handles the `draft_send` SQS message type. Reads signal, validates state, sends via SES, updates status.

```typescript
import type { Signal, Arc } from "../types/index.js";
import type { DbError, Result } from "../errors.js";
import { ok, err, dbError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ReplySender } from "./processor.js";
import type { DraftSendPayload } from "./draft-send-dispatcher.js";

export interface DraftSendStore {
  getSignal(accountId: string, id: string): Promise<Result<Signal | null, DbError>>;
  updateSignalSendStatus(accountId: string, id: string, update: {
    status: "sent" | "draft";
    sentAt?: string;
    sesMessageId?: string;
    sendFailureReason?: string;
    sendInitiatedAt?: string | null;
  }): Promise<Result<Signal, DbError>>;
  getArc(accountId: string, id: string): Promise<Result<Arc | null, DbError>>;
  updateArcStatus(accountId: string, id: string, status: "archived"): Promise<Result<void, DbError>>;
  getAccountAfterSendAction(accountId: string): Promise<Result<"archive" | "keep_active", DbError>>;
}

export class DraftSendWorker {
  private readonly store: DraftSendStore;
  private readonly replySender: ReplySender;
  private readonly logger: Logger;

  constructor(store: DraftSendStore, replySender: ReplySender, logger: Logger) {
    this.store = store;
    this.replySender = replySender;
    this.logger = logger;
  }

  async process(payload: DraftSendPayload): Promise<Result<void, DbError>> {
    const { signalId, accountId, sendInitiatedAt } = payload;

    // Re-read signal — verify still pending_send
    const signalResult = await this.store.getSignal(accountId, signalId);
    if (signalResult.isErr()) return err(signalResult.error);
    const signal = signalResult.value;

    if (!signal) {
      this.logger.error("Draft send: signal not found.", { code: "draft_send.signal_not_found", signalId, accountId });
      return ok();
    }

    if (signal.status !== "pending_send") {
      this.logger.info("Draft send: signal no longer pending_send — discarding.", { code: "draft_send.status_changed", signalId, accountId, currentStatus: signal.status });
      return ok();
    }

    if (signal.sendInitiatedAt !== sendInitiatedAt) {
      this.logger.info("Draft send: sendInitiatedAt mismatch — stale message, discarding.", { code: "draft_send.stale_message", signalId, accountId });
      return ok();
    }

    // Send via SES
    const from = signal.from.address;
    const to = signal.to[0]!.address;
    const subject = signal.subject;
    const body = signal.textBody ?? "";

    try {
      const { messageId } = await this.replySender.sendReply({
        to,
        from,
        subject,
        body,
        inReplyTo: signal.arcId ?? "",
      });

      // Transition to sent
      const now = new Date().toISOString();
      const updateResult = await this.store.updateSignalSendStatus(accountId, signalId, {
        status: "sent",
        sentAt: now,
        sesMessageId: messageId,
      });
      if (updateResult.isErr()) return err(updateResult.error);

      // Post-send arc archival
      if (signal.arcId) {
        const actionResult = await this.store.getAccountAfterSendAction(accountId);
        if (actionResult.isOk() && actionResult.value === "archive") {
          await this.store.updateArcStatus(accountId, signal.arcId, "archived");
        }
      }

      return ok();
    } catch (e) {
      // Distinguish permanent vs transient SES errors
      const error = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      const isPermanent = error.name === "MessageRejected"
        || error.name === "AccountSendingPausedException"
        || (error.$metadata?.httpStatusCode ?? 0) >= 400 && (error.$metadata?.httpStatusCode ?? 0) < 500;

      if (isPermanent) {
        this.logger.error("Draft send: SES permanent failure — reverting to draft.", { code: "draft_send.ses_permanent_failure", signalId, accountId, error: e });
        await this.store.updateSignalSendStatus(accountId, signalId, {
          status: "draft",
          sendInitiatedAt: null,
          sendFailureReason: "ses_permanent_failure",
        });
        return ok(undefined); // Don't retry
      }

      // Transient — let SQS retry
      return err(dbError(e));
    }
  }
}
```

### 5. Send Endpoint Changes (`src/api/app.ts`)

The existing `POST /accounts/:accountId/arcs/:arcId/signals/:id/send` handler is rewritten:

```typescript
// Pseudocode for the send handler
app.post("/accounts/:accountId/arcs/:arcId/signals/:id/send", authz(...), async (c) => {
  const signal = await store.getSignal(accountId, id);
  // Guards: exists, belongs to account, status === "draft"

  // MX validation
  const mxResult = await validateRecipientMx(signal.to);
  if (!mxResult.valid) return c.json({ title: "Invalid recipient domain", errorCode: "INVALID_RECIPIENT_DOMAIN", details: { invalidDomains: mxResult.invalidDomains } }, 422);

  // Compute undo window
  const undoWindowSeconds = computeUndoWindowSeconds(signal.textBody);
  const sendInitiatedAt = new Date().toISOString();
  const undoExpiresAt = new Date(Date.now() + undoWindowSeconds * 1000).toISOString();

  // SQS FIRST — before DDB write
  const sqsResult = await draftSendDispatcher.dispatch({ signalId: signal.id, accountId, sendInitiatedAt }, undoWindowSeconds);
  if (sqsResult.isErr()) return err(c, 500, "Internal Server Error");

  // DDB write — transition to pending_send
  const updateResult = await store.updateSignalSendStatus(accountId, signal.id, { status: "pending_send", sendInitiatedAt });
  if (updateResult.isErr()) return err(c, 500, "Internal Server Error");

  return c.json({ ...updateResult.value, undoWindowSeconds, undoExpiresAt });
});
```

### 6. PATCH Handler Changes

The PATCH guard is relaxed to allow `pending_send` → `draft` transition:

```typescript
app.patch("/accounts/:accountId/signals/:id", authz(...), async (c) => {
  const signal = await store.getSignal(accountId, id);

  if (signal.status === "sent") return err(c, 400, "Signal already sent", "SIGNAL_ALREADY_SENT");
  if (signal.status !== "draft" && signal.status !== "pending_send") return err(c, 400, "Only draft or pending signals can be updated", "SIGNAL_NOT_EDITABLE");

  const body = await zParse(UpdateSignalRequest, c.req.raw);

  // If pending_send, only status change to "draft" is allowed
  if (signal.status === "pending_send") {
    if (body.status !== "draft") return err(c, 400, "Pending signals can only be reverted to draft", "INVALID_STATUS_TRANSITION");
    // Clear sendInitiatedAt on cancellation
    const updateResult = await store.updateSignalSendStatus(accountId, signal.id, { status: "draft", sendInitiatedAt: null });
    return c.json(updateResult.value);
  }

  // Normal draft edit (subject, textBody, from, to)
  const updateResult = await store.updateSignal(accountId, signal.id, body);
  return c.json(updateResult.value);
});
```

### 7. Bounce Handler Extension (`src/notifier/feedback-processor.ts`)

The existing `processFeedback` method is extended to handle bounces for user-sent signals:

```typescript
// After existing suppression logic in processFeedback():
if (feedback.notificationType === "Bounce" && feedback.bounce) {
  // ... existing suppression logic ...

  // Check if this bounce is for a user-sent signal
  const sesMessageId = feedback.mail.messageId;
  const sentSignal = await this.findSentSignalBySesMessageId(sesMessageId);

  if (sentSignal && sentSignal.source === "user") {
    const bouncedRecipients = feedback.bounce.bouncedRecipients.map(r => ({
      address: r.emailAddress,
      bounceType: isPermanent ? "permanent" as const : "transient" as const,
      reason: r.status,
    }));

    // Create deliverability signal in the same arc
    const deliverabilitySignal: Signal = {
      id: `SYS#${randomUUID()}`,
      arcId: sentSignal.arcId,
      accountId: sentSignal.accountId,
      source: "deliverability",
      status: "active",
      receivedAt: new Date().toISOString(),
      from: { address: "system@deliverability" },
      to: [],
      cc: [],
      subject: `Delivery failure: ${bouncedRecipients.length} recipient(s) bounced`,
      attachments: [],
      headers: {},
      recipientAddress: sentSignal.from.address,
      workflow: sentSignal.workflow,
      workflowData: sentSignal.workflowData,
      spamScore: 0,
      summary: "",
      classificationModelId: "",
      s3Key: "",
      createdAt: new Date().toISOString(),
      relatedSignalId: sentSignal.id,
      bouncedRecipients,
    };
    await this.store.saveSignal(deliverabilitySignal);

    // If ALL recipients permanently bounced → revert sent signal to draft
    if (isPermanent) {
      const allTo = sentSignal.to.map(t => t.address.toLowerCase());
      const allBounced = allTo.every(addr =>
        bouncedRecipients.some(b => b.address.toLowerCase() === addr && b.bounceType === "permanent")
      );
      if (allBounced) {
        await this.store.updateSignalSendStatus(sentSignal.accountId, sentSignal.id, {
          status: "draft",
          sendFailureReason: "all_recipients_bounced",
          sendInitiatedAt: null,
        });
      }
    }
  }
}
```

### 8. Handler Routing (`src/handler.ts`)

Add `draft_send` message type routing alongside existing `reindex` and `side_effect`:

```typescript
const [MSG_TYPE_REINDEX, MSG_TYPE_SIDE_EFFECT, MSG_TYPE_DRAFT_SEND] = SQS_MESSAGE_TYPES;

// In the SQS event loop:
} else if (messageType === MSG_TYPE_DRAFT_SEND) {
  const payload = body as DraftSendPayload;
  const result = await draftSendWorker.process(payload);
  failed = result.isErr();
}
```

### 9. Database Method: `updateSignalSendStatus`

New method on `ArcDatabase` that updates send-related fields atomically:

```typescript
async updateSignalSendStatus(
  accountId: string,
  signalId: string,
  update: {
    status: "pending_send" | "sent" | "draft";
    sendInitiatedAt?: string | null;
    sentAt?: string;
    sesMessageId?: string;
    sendFailureReason?: string;
  },
): Promise<Result<Signal, DbError>> {
  const setParts: string[] = ["#status = :status", "updatedAt = :now"];
  const exprValues: Record<string, unknown> = { ":status": update.status, ":now": new Date().toISOString() };
  const exprNames: Record<string, string> = { "#status": "status" };
  const removeParts: string[] = [];

  if (update.sendInitiatedAt === null) {
    removeParts.push("sendInitiatedAt");
  } else if (update.sendInitiatedAt !== undefined) {
    setParts.push("sendInitiatedAt = :sia");
    exprValues[":sia"] = update.sendInitiatedAt;
  }

  if (update.sentAt !== undefined) { setParts.push("sentAt = :sentAt"); exprValues[":sentAt"] = update.sentAt; }
  if (update.sesMessageId !== undefined) { setParts.push("sesMessageId = :smid"); exprValues[":smid"] = update.sesMessageId; }
  if (update.sendFailureReason !== undefined) { setParts.push("sendFailureReason = :sfr"); exprValues[":sfr"] = update.sendFailureReason; }

  let updateExpr = `SET ${setParts.join(", ")}`;
  if (removeParts.length > 0) updateExpr += ` REMOVE ${removeParts.join(", ")}`;

  const result = await dynamo.send(new UpdateCommand({
    TableName: SIGNALS_TABLE,
    Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
    UpdateExpression: updateExpr,
    ExpressionAttributeValues: exprValues,
    ExpressionAttributeNames: exprNames,
    ReturnValues: "ALL_NEW",
  }));
  return ok(result.Attributes as unknown as Signal);
}
```

### 10. UpdateSignalRequest Schema Change

Add `status` to the PATCH request schema (constrained to `"draft"` only):

```typescript
export const UpdateSignalRequest = z.object({
  status: z.literal("draft").optional(),
  subject: z.string().optional(),
  textBody: z.string().optional(),
  from: EmailAddressSchema.optional(),
  to: z.array(EmailAddressSchema).optional(),
});
```

### 11. Stats Writer Update

The `statusToCategory` function needs to handle the new statuses:

```typescript
const STATUS_TO_CATEGORY: Record<Exclude<SignalStatus, "draft" | "pending_send" | "sent">, StatsCategory> = {
  active: "allowed",
  block_hidden: "blocked",
  block_reject: "blocked",
  report_violation: "blocked",
  quarantine_visible: "quarantined",
  quarantine_hidden: "quarantined",
};

export function statusToCategory(status: SignalStatus): StatsCategory | null {
  if (status === "draft" || status === "pending_send" || status === "sent") return null;
  return STATUS_TO_CATEGORY[status];
}
```

## Files Changed

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `pending_send`, `sent` to SIGNAL_STATUSES; add `deliverability` to SIGNAL_SOURCES; add `draft_send` to SQS_MESSAGE_TYPES; add `sendInitiatedAt`, `sesMessageId`, `sendFailureReason`, `relatedSignalId`, `bouncedRecipients` to Signal; add `afterSendAction` to Account |
| `src/api/undo-window.ts` | New file — `computeUndoWindowSeconds` pure function |
| `src/dns/mx-validator.ts` | New file — `validateRecipientMx` function |
| `src/processor/draft-send-dispatcher.ts` | New file — `DraftSendDispatcher` class |
| `src/processor/draft-send-worker.ts` | New file — `DraftSendWorker` class |
| `src/api/app.ts` | Rewrite `POST /send` handler; update PATCH/PUT/DELETE guards |
| `src/api/requests.ts` | Add `status: z.literal("draft").optional()` to `UpdateSignalRequest` |
| `src/database/arc-database.ts` | Add `updateSignalSendStatus` method |
| `src/database/adapters.ts` | Expose `updateSignalSendStatus` through adapters |
| `src/notifier/feedback-processor.ts` | Extend bounce handling to create deliverability signals and revert fully-bounced signals |
| `src/handler.ts` | Add `MSG_TYPE_DRAFT_SEND` routing; instantiate `DraftSendDispatcher` and `DraftSendWorker` |
| `src/database/stats-writer.ts` | Exclude `pending_send` and `sent` from stats categories |

## Dependency Injection

The `DraftSendDispatcher` is injected into the API app (for the send endpoint). The `DraftSendWorker` is instantiated in `handler.ts` alongside the existing processor and reindex worker. Both share the existing `SQSClient`, `SIGNAL_QUEUE_URL`, and `ExternalEmailSignalHandler` instances.

The `FeedbackProcessor` gains a dependency on a store interface that can look up signals by `sesMessageId` and save new signals. This uses the existing `ArcDatabase` methods.

## Error Handling

All operations use `neverthrow` Result types. The send flow has three failure modes:

1. **MX validation failure** → synchronous 422 response, signal stays `draft`
2. **SQS dispatch failure** → synchronous 500 response, signal stays `draft`
3. **SES send failure (transient)** → SQS message retried automatically
4. **SES send failure (permanent)** → signal reverted to `draft` with `sendFailureReason`

The undo cancellation is a simple DDB update — if it races with the SQS consumer, the consumer's status check (`pending_send` guard) ensures at-most-once delivery.
