# Design: Domain/Alias/Sender DynamoDB Schema Refactor

## DynamoDB Item Layout (after)

### Primary Table (ses-accounts)

| Item Type | pk | sk | gsi1pk | gsi1sk |
|-----------|----|----|--------|--------|
| Account | `ACCT#{accountId}` | `META` | — | — |
| Domain | `ACCT#{accountId}` | `DOMAIN#{domain}` | `DOMAIN#{domain}` | `ACCT#{accountId}` |
| Alias | `ACCT#{accountId}` | `DOMAIN#{domain}#ALIAS#{alias}` | `DOMAIN#{domain}#ALIAS#{alias}` | `ACCT#{accountId}` |
| Sender | `ACCT#{accountId}` | `DOMAIN#{domain}#ALIAS#{alias}#SENDER#{senderDomain}` | `SENDER#{senderDomain}` | `ACCT#{accountId}#DOMAIN#{domain}#ALIAS#{alias}` |
| Rule | `ACCT#{accountId}` | `RULE#{id}` | `ACCT#{accountId}` | `RULE#{status}#{priority}#{id}` |
| View | `ACCT#{accountId}` | `VIEW#{id}` | — | — |
| Label | `ACCT#{accountId}` | `LABEL#{name}` | — | — |
| Template | `ACCT#{accountId}` | `TEMPLATE#{id}` | — | — |
| FwdAddr | `ACCT#{accountId}` | `FWDADDR#{address}` | — | — |
| WsConn | `ACCT#{accountId}` | `CONN#{connId}` | — | — |
| Stats | `ACCT#{accountId}` | `STATS` | — | — |

### Key Terminology
- `domain` = full domain (e.g. `acme.com`)
- `alias` = local part before @ (e.g. `me` from `me@acme.com`)
- `senderDomain` = eTLD+1 of sender (e.g. `github.com`)

## Query Patterns

| Use Case | Table/Index | Key Condition |
|----------|-------------|---------------|
| Get domain record | Primary | `pk=ACCT#X, sk=DOMAIN#acme.com` |
| List all domains for account | Primary | `pk=ACCT#X, sk begins_with DOMAIN#` + filter only bare `DOMAIN#` items |
| Get alias + all senders | Primary | `pk=ACCT#X, sk begins_with DOMAIN#acme.com#ALIAS#me` |
| Get specific sender | Primary | `pk=ACCT#X, sk=DOMAIN#acme.com#ALIAS#me#SENDER#github.com` |
| Resolve domain→accountId | GSI | `gsi1pk=DOMAIN#acme.com` → sort results by createdAt, first = owner |
| Resolve alias→accountId | GSI | `gsi1pk=DOMAIN#acme.com#ALIAS#me` |

## Type-Safe Refactoring Strategy (025-REFACT)

### Phase 1: Break the types
Alias methods currently take `address: string` (full email like `me@acme.com`). Change to a structured parameter:

```typescript
interface AliasKey {
  domain: string;  // "acme.com"
  alias: string;   // "me"
}
```

Similarly, sender methods take `(accountId, address, domain)`. Change to:

```typescript
interface SenderKey {
  domain: string;       // "acme.com" (the alias's domain)
  alias: string;        // "me" (local part)
  senderDomain: string; // "github.com" (eTLD+1 of sender)
}
```

### Phase 2: Compiler enumerates broken sites
Run `tsc --noEmit` — every caller of alias/sender methods will fail. The error list is the migration checklist.

### Phase 3: Fix all sites
Migrate each caller to provide the new structured parameters. Where callers have `recipientAddress` (full email), split it: `const [alias, domain] = address.split("@")`.

### Phase 4: Zero errors = done

## Inbound Routing Change

### Before (broken)
```
handler.ts → accountId = notification.accountId ?? mail.destination[0]
```

### After
```
handler.ts → recipientAddress = mail.destination[0]
           → domain = recipientAddress.split("@")[1]
           → accountId = await resolveAccountForDomain(domain)
           → if (!accountId) → log + drop message
```

## Domain Creation Flow (after)

```
POST /accounts/{accountId}/domains
  1. Query GSI: gsi1pk = DOMAIN#{domain}
  2. Fetch all results, sort by createdAt ascending
  3. If results[0] exists AND results[0].accountId !== requestingAccountId → 409 Conflict
  4. If results[0] exists AND results[0].accountId === requestingAccountId → return existing (no-op)
  5. Otherwise → register SES identity + PutCommand with ConditionExpression
```

## Files Modified

- `src/database/account-database.ts` — all alias/sender/domain methods rewritten
- `src/handler.ts` — remove `notification.accountId`, add domain resolution
- `src/processor/processor.ts` — callers of getSender, getAlias adapted
- `src/api/app.ts` — callers of alias/sender/domain methods adapted
- `src/types/index.ts` — Alias type gains `domain` + `alias` fields, drops standalone `address`
- `src/onboarding/onboarding-task-handler.ts` — listDomains caller
- `src/jobs/domain-health-job.ts` — scanAllDomains caller
- `tests/**` — all mocks updated to match new signatures
