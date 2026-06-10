# Requirements: Domain/Alias/Sender DynamoDB Schema Refactor

## Problem

1. **No inbound routing** — when SES delivers an email to `user@acme.com`, the handler sets `accountId = mail.destination[0]` (the raw email address). There's no domain→accountId lookup, so the processor runs without proper account context.
2. **No duplicate domain protection** — `createDomain` uses unconditional `PutCommand`. Same user re-adding a domain overwrites (resets timestamps/health). Different user adding the same domain succeeds silently.
3. **Dead `notification.accountId` field** — the handler checks a property that SES never populates. Must be removed.
4. **Inefficient query patterns** — getting an alias with its senders requires two separate queries. No way to fetch all aliases under a domain in one call.
5. **Dead code** — `listAliasesForDomain` has zero callers.

## Requirements

### R1: New SK hierarchy
All domain/alias/sender items under an account must use hierarchical sort keys:
- Domain: `SK = DOMAIN#{domain}`
- Alias: `SK = DOMAIN#{domain}#ALIAS#{alias}` (alias = local part before @)
- Sender: `SK = DOMAIN#{domain}#ALIAS#{alias}#SENDER#{senderDomain}`

### R2: GSI for domain→account resolution
Domain items must write `gsi1pk: DOMAIN#{domain}`, `gsi1sk: ACCT#{accountId}` so that inbound routing can query the GSI to resolve which account owns a domain.

### R3: GSI for alias→account resolution
Alias items must write `gsi1pk: DOMAIN#{domain}#ALIAS#{alias}`, `gsi1sk: ACCT#{accountId}`.

### R4: GSI for sender items
Sender items must write `gsi1pk: SENDER#{senderDomain}`, `gsi1sk: ACCT#{accountId}#DOMAIN#{domain}#ALIAS#{alias}` to avoid hot partitions (high-cardinality key required).

### R5: Domain ownership enforcement
On `POST /domains`, query GSI `DOMAIN#{domain}`. If results exist, sort by `createdAt` ascending — oldest registrant wins. If the requesting account isn't the owner, reject with 409. If it IS the owner, no-op (idempotent).

### R6: Idempotent domain creation
`createDomain` must use `ConditionExpression: "attribute_not_exists(sk)"` so re-adds by the owning account are no-ops that return the existing record.

### R7: Remove dead code
- Delete `notification.accountId` property from handler type assertion
- Delete `listAliasesForDomain` method

### R8: Inbound routing resolution
Add `resolveAccountForDomain(domain: string)` method that queries GSI, returns the accountId of the oldest registrant (sorted by `createdAt`). The handler must use this to resolve accountId before calling the processor.

### R9: Type-safe refactoring
Use 025-REFACT pattern — change method signatures so old call sites fail to compile. The compiler must catch every migration site.

### R10: Single-query alias+senders fetch
Enable fetching an alias and all its senders in one DynamoDB query via `begins_with(sk, "DOMAIN#{domain}#ALIAS#{alias}")`.
