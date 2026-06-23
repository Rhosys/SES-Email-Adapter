# ADR 009: Log Context Must Include Full Entity Objects

## Status

Accepted

## Context

Several early-exit paths in the processor (block, quarantine, DKIM failure) decompose domain entities into individual scalar fields when logging:

```ts
this.logger.track("Blocked email — rule matched with block disposition.", {
  code: "processor.rule_block", accountId, sesMessageId, recipientAddress, ...
});
```

The `blockSignal` object — which contains the `signalId`, `arcId`, full status, and nested data — is already constructed and saved to the database one line above, but is never passed to the log. This means the signalId is absent from the log line, making it impossible to trace the event back to a specific record without a secondary query.

Meanwhile, the side-effects handler correctly passes `{ signal, arc, payload }` to every log emission because those objects are in scope and contain all diagnostic context.

The inconsistency is the gap: some paths pass the entity, some decompose it.

## Decision

1. Every `track`, `warn`, `error`, and `critical` log emission that fires after a domain entity (signal, arc) has been constructed MUST include the full entity object in its context payload.
2. Every `info` log emission MUST include at minimum `accountId`, `arcId`, and `signalId` (the primary identity fields) when those values are in scope.
3. Never decompose an entity into scalar fields when the object is already available — pass the object directly.

## Consequences

- Log lines become self-contained: any single line has enough context to diagnose the event.
- Log payload size increases marginally (the signal object is already serialized for DB writes, so it's in memory).
- All early-exit block/quarantine paths must be updated to pass the constructed signal object.
- Future log emissions are easier to write correctly — "pass the entity" is simpler than "remember which scalar fields to extract."
