# DRAFT — Quarantine approve/block: separate rule evaluation from alias + sender actions

> Temporary working doc for iteration. Delete before merge once the approach is agreed
> and implemented.

## Problem

In `src/api/signalsApi.ts`, the `POST /signals/{id}/quarantineResponse` handler
currently decides whether to create the alias and record the sender disposition
based on `wasQuarantinedByUnknownSender`, which is derived from
`signal.data.matchedRules` (i.e. the output of **rule evaluation**):

```ts
const wasQuarantinedByUnknownSender =
  !(signal.data.matchedRules ?? []).some(r => r.statusChange && r.ruleId !== "SR-00");
```

This conflates two things that must be completely independent:

1. **Alias creation** — the recipient address is a real receiving address. Its
   alias record must exist regardless of *why* a signal was quarantined. This has
   nothing to do with rules.
2. **Sender disposition** — when a user explicitly clicks *approve* / *block* on a
   quarantined signal, that is a direct user decision about the sender. It should
   not depend on whether the signal was held by the unknown-sender policy vs. an
   explicit content rule.

Rule evaluation happens at ingest time. The approve/block handler is a user
action. The two should not reference each other.

## Proposed change

Remove `wasQuarantinedByUnknownSender` / any `matchedRules` inspection from the
handler entirely. Then:

### Block path (`block_hidden` / `block_reject` / `report_violation`)
- Always `ensureAliasExists(accountDb, accountId, signal.data.recipientAddress, signal.id)`.
- Always `accountDb.saveSender(accountId, recipientAddress, senderETLD1, body.status)`.

### Approve path (`active`)
- Always `ensureAliasExists(...)` (already unconditional on the branch).
- Always `accountDb.saveSender(accountId, recipientAddress, senderETLD1, "allow")`.

### Keep (unrelated, already merged in this PR)
- `matchedThreadId` reuse for thread matching on approve — that is thread
  resolution, not rule gating.

## Open questions to resolve before implementing

1. **Always whitelist/blacklist the sender on approve/block?** Confirmed intent is
   yes — the button *is* the user's explicit sender decision. Flagging here in case
   there is a nuance (e.g. should approving a spam-flagged email still allow the
   whole eTLD+1 sender domain, or only this exact sender?).
2. Anything downstream that still *reads* `matchedRules` for this decision
   elsewhere? (Searched: only this handler used it for gating.)

## Tests to update (`tests/api/unblock-signal-update.test.ts`)
- Remove/invert the "content-rule quarantine → no sender allow" expectation:
  sender allow now happens on every approve.
- Keep: alias ensured on approve and block; `matchedThreadId` thread reuse.
