# Design Document

## Overview

Thread snooze extends the existing followup scheduler with a dedicated `snoozed` status and two new thread fields (`snoozedUntil`, `reactivationReason`). The scheduler infrastructure (EventBridge, SQS routing, `FollowupHandler`) is already fully implemented — this spec adds the status semantics and UI-facing metadata on top.

## Architecture

### Status Transition Diagram

```
active ──[snooze]──▶ snoozed ──[timer fires]──▶ active (reason: snooze_expired)
                         │                          
                         ├──[new signal]──▶ active (reason: new_signal)
                         │
                         └──[manual un-snooze]──▶ active (reason: manual)

active ──[archive]──▶ archived
active ──[delete]──▶ deleted
snoozed ──[delete]──▶ deleted (cancel schedule)
```

### Data Model Changes

**Thread record** — two new optional fields:

| Field | Type | When set | When cleared |
|-------|------|----------|-------------|
| `snoozedUntil` | `string` (ISO 8601) | On snooze action | On manual un-snooze or archive/delete. Preserved on snooze_expired and new_signal (UI needs the original target time for display) |
| `reactivationReason` | `"snooze_expired" \| "new_signal" \| "manual"` | When transitioning from snoozed → active | On user's next explicit action (archive, delete, or next snooze) |

### Existing Infrastructure Reuse

| Component | Location | Change needed |
|-----------|----------|---------------|
| `EventBridgeSchedulerClient` | `src/scheduler/scheduler-client.ts` | None — `createFollowup` / `deleteFollowup` already work |
| `buildScheduleName` | `src/scheduler/schedule-name.ts` | None — suffix becomes `"snooze"` |
| `FollowupHandler` | `src/scheduler/followup-handler.ts` | Extend to handle `snoozed` status (currently only handles `archived` and `active`) |
| `SQS_MESSAGE_TYPES` | `src/types/index.ts` | None — `"signal_followup"` already registered |
| Handler routing | `src/handler.ts` | None — already routes to `FollowupHandler` |
| Notifier `reason` param | `src/notifier/` | None — `"followup"` reason already supported |

### PATCH Thread Endpoint Changes

The existing `PATCH /accounts/:id/threads/:threadId` handler gains:

1. `status: "snoozed"` as a valid status transition (only from `active`)
2. Validation: `snoozedUntil` required when `status = "snoozed"`, rejected otherwise
3. Schedule creation on snooze
4. Schedule cancellation on un-snooze (status = `active` from `snoozed`)
5. Schedule cancellation on delete from snoozed

### FollowupHandler Extension

Current behavior:
- Thread null/deleted → discard
- Thread active → notify only
- Thread archived → reactivate to active + notify

New behavior (additive):
- Thread `snoozed` → set `active`, set `reactivationReason: "snooze_expired"`, notify

### Processor Extension

The processor already reactivates `archived` threads on new signal arrival. Extend to also reactivate `snoozed` threads:
- Set status to `active`
- Set `reactivationReason: "new_signal"`
- Cancel pending schedule
- Preserve `snoozedUntil` (for UI: "was snoozed until X, woke early")

### Schedule Naming

Reuses existing `buildScheduleName(accountId, threadId, suffix)`:
- Suffix for user snooze: `"snooze"`
- One active snooze per thread at a time (creating a new one implicitly replaces — schedule names are deterministic)

### API Response Shape

```typescript
interface Thread {
  // ... existing fields ...
  snoozedUntil?: string;          // ISO 8601 — present while snoozed and after resurfacing
  reactivationReason?: "snooze_expired" | "new_signal" | "manual";  // present after resurfacing, cleared on next user action
}
```

### UI Rendering (frontend responsibility, not this spec)

- Thread card badge: if `reactivationReason === "snooze_expired"` and `snoozedUntil` present → "Snoozed until today" / "Snoozed until {date}"
- Thread detail annotation: "This thread was snoozed and resurfaced at {snoozedUntil}" (the fire time ≈ snoozedUntil)
- If `reactivationReason === "new_signal"` → "This thread woke early — new mail arrived while snoozed"

## Scope Exclusions

- Snooze presets UI (client-side computation, not backend)
- "Snoozed" sidebar nav item (uses existing `?status=snoozed` filter)
- Recurring snooze (snooze again after resurfacing — user manually re-snoozes)
- Keyboard shortcut `s` for snooze (frontend concern)
