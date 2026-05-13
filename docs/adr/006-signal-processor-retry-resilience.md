# ADR-006: Signal Processor Retry Resilience Model

**Date:** 2026-05-13  
**Status:** Accepted  
**Deciders:** Warren  

## Context

The signal processor (`processor.ts`) handles inbound SQS records containing email signals. The original implementation had a binary dedup check: on retry (`receiveCount > 1`), if the signal already existed in DynamoDB, the processor skipped all processing. This meant that if a failure occurred after the DDB save but before Aurora upserts or side-effects completed, the work was permanently lost — the retry would see the signal in DDB and skip everything.

An initial design proposed adding `processingStage`, `completedSideEffects`, and `s3RetentionAttempted` fields to the signal record to track progress through the pipeline. This was rejected.

## Decision

Replace the binary dedup with a resume-from-where-we-left-off pattern that relies on operation idempotency rather than state tracking. The signal existing in DDB is the sole checkpoint. All subsequent operations (Aurora upserts, S3 retagging) are idempotent and always re-run. Side-effects are dispatched as a separate SQS message to the same queue after Aurora succeeds.

### The retry flow

1. On retry (`receiveCount > 1`): read signal from DDB using the existing `getSignal` method
2. If signal missing: inline the full first-attempt pipeline (parse, classify, embed, match, rules, save), then fall through
3. If signal exists: read arc by `signal.arcId`; if arc missing, re-derive from signal classification and save
4. S3 retention: always attempt (fire-and-forget, errors logged at warn)
5. Aurora upserts: always run across all active clusters (idempotent via `ON CONFLICT DO UPDATE`)
6. If Aurora fails on any cluster: return `batchItemFailure` (ERROR for primary, WARN for non-primary)
7. If Aurora succeeds: dispatch side-effect SQS message containing the full signal and arc objects
8. Side-effect handler: separate code path in the same Lambda, discriminated by `MessageAttributes.messageType`

### Message type discrimination

The processor queue carries two message types. Routing is by SQS `MessageAttributes`:
- Absent `messageType` (or `"inbound_signal"`) → signal processing path
- `"side_effect"` → side-effect execution path

SES/SNS does not set custom message attributes, so inbound messages naturally have no `messageType`. Only the processor's own dispatch sets `messageType: "side_effect"`. No infrastructure configuration needed.

## Drivers and Principles

Each architectural choice is justified by a specific principle (documented in `_Strategy/patterns/resilience.md`):

### 1. No `processingStage` field on the signal

**Driver:** The original design tracked pipeline progress as a state machine on the signal record.

**Principle applied:** *Don't track state that the operation itself already handles.* Aurora upserts are idempotent (`ON CONFLICT DO UPDATE`). S3 PUT is idempotent. Re-running them is cheaper than maintaining a flag that can become stale or inconsistent. The flag introduces a new failure mode (flag says "done" but the operation actually failed) with zero upside.

### 2. Always upsert Aurora, always retag S3

**Driver:** The original design checked whether Aurora had "completed" before deciding whether to run it again.

**Principle applied:** *Lean on idempotency over bookkeeping.* The idempotent operation is already tested and proven. Running it again costs milliseconds of compute. Building conditional skip-logic costs engineering hours and creates surface area for subtle data-loss bugs where the skip fires incorrectly.

### 3. Side-effects dispatched as a separate SQS message

**Driver:** The original design executed side-effects inline in the same invocation as Aurora upserts, meaning Aurora failures forced side-effect re-execution and side-effect failures could block Aurora retries.

**Principle applied:** *Separate concerns by failure domain.* Aurora must succeed (data consistency). Side-effects are best-effort (a duplicate notification is harmless, a permanently invalid forward address shouldn't block embedding writes). Independent dispatch lets each concern retry at its own cadence.

### 4. Absent `messageType` = inbound signal (no SES/SNS configuration)

**Driver:** The question of whether SES or SNS could be configured to stamp `messageType: "inbound_signal"` on messages.

**Principle applied:** *Discriminate by convention, not configuration.* SES controls the SNS publish call and doesn't support custom message attributes. Rather than adding infrastructure (a Lambda between SNS and SQS to stamp the attribute), use "absent = default type" as the convention. Zero-config, self-documenting, can't drift.

### 5. Side-effect payload is `{ signal, arc }` — not a bespoke struct

**Driver:** The original design pre-computed a `SideEffectPayload` with extracted fields (s3Key, senderAddress, subject, etc.).

**Principle applied:** *Pass the raw data, derive at execution time.* The side-effect handler can derive everything it needs from the signal and arc objects. A pre-computed payload encodes today's assumptions about what the consumer needs. When requirements change, both producer and consumer must update in lockstep. Raw objects let the consumer evolve independently.

### 6. First-attempt steps inlined in the `if (!signal)` block

**Driver:** The original design called `this.processMessage(msg)` as an early return when the signal was missing on retry.

**Principle applied:** *Inline the exceptional path, don't abstract it.* The "signal missing on retry" case is rare and only exists in one place. Extracting it into a separate method hides the recovery logic behind a name, making it harder to trace during debugging. Inlining keeps the full flow visible at the call site.

### 7. Uses existing `getSignal` — no `getSignalForRetry`

**Driver:** The original design introduced a new `getSignalForRetry` method on the database interface.

**Principle applied:** *Don't invent new interfaces for existing capabilities.* The existing `getSignal(accountId, sesMessageId)` already returns the full signal record. A new method name adds a concept to maintain and implies something different is happening — when it isn't.

### 8. No side-effect idempotency tracking (deferred)

**Driver:** The original design added `completedSideEffects` tracking on the signal record, writing after every successful side-effect.

**Principle applied:** *Defer complexity until you have evidence you need it.* Idempotency tracking means a DDB write on every successful side-effect execution — that's the 99% path paying a tax to protect against the 1% retry case. Idempotent retries are nearly free (a duplicate notification is harmless). The tracking cost is constant and expensive. Ship the simpler model, measure duplicate rates in production, then add tracking only if the data justifies it.

## Consequences

- The signal record has no new fields. No schema migration needed.
- Aurora upserts run on every attempt (first and retry). Cost is negligible — the upsert is a no-op if the row already exists with the same data.
- S3 retagging runs on every attempt. Idempotent PUT operation.
- Side-effects may fire more than once on retry (until idempotency tracking is added later if needed). This is acceptable because: notifications are harmless to duplicate, forwards are rare, and the retry itself is rare.
- The processor queue now carries two message types. Backward-compatible: existing messages without `messageType` route to the signal processing path.
- The `process()` method gains a routing check on `record.messageAttributes.messageType` before dispatching to `processRecord()` or `processSideEffectRecord()`.

## References

- ADR-004: Aurora Cluster Registry and Reindex Strategy (cluster topology)
- ADR-005: neverthrow Error Handling (Result types for the retry flow)
- `_Strategy/patterns/resilience.md` (principles 1–8)
