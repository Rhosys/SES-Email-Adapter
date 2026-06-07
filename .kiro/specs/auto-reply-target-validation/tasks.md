# Implementation Plan: Auto-Reply Target Validation

## Overview

Gate auto-draft auto-send on Reply-To safety. When `signal.replyTo` is present and its eTLD+1 differs from `signal.from.address` eTLD+1, check the receiving alias's approved senders list. If the Reply-To domain is not approved, suppress auto-send. The draft is still created (status "draft") but not dispatched. Pong is unaffected — it always sends to `signal.from.address` (DMARC-authenticated).

## Tasks

- [x] 1. Create the Reply-To validation utility
  - [x] 1.1 Create `src/processor/reply-target-validator.ts`
    - Export `isReplyTargetSafe(signal: Signal, approvedDomains: string[]): { safe: boolean; reason?: string }`
    - Logic: if `signal.replyTo` is absent → safe. If `signal.replyTo` eTLD+1 === `signal.from.address` eTLD+1 → safe. If `signal.replyTo` eTLD+1 is in `approvedDomains` → safe. Otherwise → unsafe with reason string containing both addresses.
    - Use `getETLD1` from `./filter.js` (already exists) for domain extraction.
    - _Requirements: 2.1, 2.4_

- [x] 2. Wire the validation into auto-draft auto-send
  - [x] 2.1 Add Reply-To check before auto-send dispatch in `processSideEffect`
    - In the auto-draft loop, after `shouldAutoSend` is computed: if `shouldAutoSend` is true, resolve the Reply-To eTLD+1, call `this.store.getSender(accountId, signal.recipientAddress, replyToETLD1)` to check if it's approved, pass result to `isReplyTargetSafe`.
    - If unsafe: set `shouldAutoSend = false` (draft is still created as "draft"), log at TRACK level with both addresses, create system signal via `this.systemSignalCreator`.
    - If safe: proceed normally.
    - _Requirements: 2.1, 2.2, 2.3, 3.2, 3.4_

- [x] 3. Verify and run tests
  - [x] 3.1 Run `npm test` — all existing tests must pass (no Reply-To field in test signals means they all pass the safe check)
    - _Requirements: 3.1, 3.3_

## Notes

- The `getSender` call is a single DDB GET — cheap and already used in the inbound pipeline.
- `getETLD1` from `./filter.js` handles the domain extraction (uses `tldts`).
- The system signal creator pattern is already established — reuse `createInvalidOutputSignal` or add a new method for reply-target suppression.
- Pong sends to `signal.from.address` which is DMARC-authenticated — no validation needed.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1"] }
  ]
}
```
