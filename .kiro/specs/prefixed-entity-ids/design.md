# Design Document: Prefixed Entity IDs

## Overview

Replace bare `randomUUID()` calls with a shared `generateId(prefix)` utility that produces time-ordered, base58-encoded, check-protected IDs. The format is `{prefix}{base58(UUIDv7)}{3 check chars}` — e.g. `arc-mRk3oCMDhFXGF7CzHBt22Xabc` (~29 chars total for a 4-char prefix).

UUIDv7 provides time-ordering (useful for DynamoDB sort keys and debugging). Base58 encoding shortens the representation from 36 hex chars to ~22 chars. The 3 check characters catch single-character transcription errors when IDs are copy-pasted or read aloud.

## Architecture

```
generateId("arc-")
    │
    ├─ 1. uuid.v7()              → "019746a2-..."  (standard UUIDv7 string)
    ├─ 2. short.fromUUID(uuid)   → "mRk3oCMDhFXGF7CzHBt22X"  (22-char base58)
    ├─ 3. sha256(base58)         → filter to base58 alphabet → first 3 chars
    └─ 4. return "arc-" + base58 + checkChars
```

Single utility function, no classes, no state. Pure function (aside from the UUIDv7 timestamp/random source).

### Signal Key Strategy

Signals have a split identity:

- **External ID (`signal.id`):** `sgn-{base58(UUIDv7)}{check}` — what the API returns, what the UI uses, what appears in the GSI SK. Time-ordered, consistent with all other entities.
- **Table PK (internal storage key):** depends on source:
  - Inbound (SES): `ACCT#{accountId}#SIG#ses-{sesMessageId}` — used only for O(1) dedup on inbound processing
  - User/System: `ACCT#{accountId}#SIG#{sgnId}` — uses the `sgn-` ID directly

The `ses-` prefix in the table PK makes it visually clear that this is the SES-sourced storage key, not the signal's public ID.

**Lookup paths:**
- Inbound dedup: direct table get by `ses-{sesMessageId}` PK → O(1)
- All other signal lookups (list signals in arc, get signal by ID, quarantine list): GSI query using the `sgn-` ID in the SK

**GSI SK:** just the `sgn-` ID itself. Since UUIDv7 base58 sorts chronologically, no `RECV#` prefix is needed — the IDs already sort in time order.

## Components and Interfaces

### `src/utils/id.ts`

```typescript
import { v7 as uuidv7 } from "uuid";
import short from "short-uuid";
import { createHash } from "node:crypto";

const translator = short(short.constants.flickrBase58);

const FLICKR_BASE58 = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const BASE58_SET = new Set(FLICKR_BASE58);

export function generateId(prefix: string): string {
  const uuid = uuidv7();
  const encoded = translator.fromUUID(uuid);
  const hash = createHash("sha256").update(encoded).digest("hex");
  const checkChars = [...hash].filter(c => BASE58_SET.has(c)).slice(0, 3).join("");
  return `${prefix}${encoded}${checkChars}`;
}
```

### ID Format

| Component | Length | Source |
|-----------|--------|--------|
| Prefix | 3–5 chars | Entity type (`arc-`, `view-`, `rule-`, `tpl-`, `aud-`, `sgn-`) |
| Base58 body | 22 chars | UUIDv7 encoded to flickrBase58 |
| Check chars | 3 chars | SHA-256 of base58 body, filtered to base58 alphabet |
| **Total** | **28–30 chars** | Depends on prefix length |

### Entity Prefix Table

| Entity | Prefix | Example ID |
|--------|--------|------------|
| Arc | `arc-` | `arc-mRk3oCMDhFXGF7CzHBt22Xabc` |
| View | `view-` | `view-nSj4pDNEiGYHG8DzICu33Ydef` |
| Rule | `rule-` | `rule-oTk5qEOFjHZIH9EzJDv44Zghi` |
| Label | N/A | `receipts` (name is the key) |
| Template | `tpl-` | `tpl-qVm7sGQHlJbKJ1GzLFx66bmno` |
| Alias | N/A | `user@example.com` (address is the key) |
| Forwarding Address | N/A | `user@example.com` (address is the key) |
| Audit Event | `aud-` | `aud-tYp0vJTKoMeNM4JzOIa99evwx` |
| Signal | `sgn-` | `sgn-vAr2xLVMqOgPO6LzQKc11g234` |

### Signal DynamoDB Layout

| Concern | Key | Value |
|---------|-----|-------|
| Table PK (inbound) | `ACCT#{accountId}#SIG#ses-{sesMessageId}` | Full signal record |
| Table PK (user/system) | `ACCT#{accountId}#SIG#{sgnId}` | Full signal record |
| Table SK | `#` (unchanged) | — |
| GSI PK (in arc) | `ACCT#{accountId}#ARC#{arcId}` | — |
| GSI PK (quarantined) | `ACCT#{accountId}#QUARANTINED` | — |
| GSI PK (blocked) | `ACCT#{accountId}#BLOCKED` | — |
| GSI SK | `{sgnId}` (the `sgn-` prefixed ID) | — |
| Signal `id` attribute | `sgn-{base58}{check}` | External-facing ID |
| Signal `signalLookupId` attribute | `ses-{sesMessageId}` (inbound) or `sgn-{id}` (user/system) | Internal PK value |

### Signal Lookup Patterns (pseudocode)

```
// DEDUP CHECK (inbound only) — table direct get by signalLookupId
getSignalByMessageId(accountId, sesMessageId):
  GET pk=ACCT#{accountId}#SIG#ses-{sesMessageId}, sk=#

// LIST SIGNALS IN ARC — GSI query
listSignals(accountId, arcId, cursor, limit):
  QUERY gsi1 WHERE gsi1pk=ACCT#{accountId}#ARC#{arcId}
  ScanIndexForward=false, Limit=limit

// LIST QUARANTINED SIGNALS — GSI query
listPreArcSignals(accountId, "quarantined", cursor, limit):
  QUERY gsi1 WHERE gsi1pk=ACCT#{accountId}#QUARANTINED
  ScanIndexForward=false, Limit=limit

// SAVE SIGNAL — table put
saveSignal(signal):
  pk = ACCT#{accountId}#SIG#{signal.signalLookupId}
  gsi1pk = signal.arcId
    ? ACCT#{accountId}#ARC#{signal.arcId}
    : signal.status in [quarantine_visible, quarantine_hidden]
      ? ACCT#{accountId}#QUARANTINED
      : ACCT#{accountId}#BLOCKED
  gsi1sk = signal.id   // the sgn- ID (sorts chronologically)
  PUT { ...signal, pk, sk=#, gsi1pk, gsi1sk }

// UPDATE SIGNAL STATUS (block) — table update by signalLookupId
updateSignalStatus(accountId, signalLookupId, status):
  UPDATE pk=ACCT#{accountId}#SIG#{signalLookupId}, sk=#
  SET status=status, gsi1pk=ACCT#{accountId}#BLOCKED

// UNBLOCK SIGNAL (quarantine → arc) — table update by signalLookupId
unblockSignal(accountId, signalLookupId, arcId):
  UPDATE pk=ACCT#{accountId}#SIG#{signalLookupId}, sk=#
  SET arcId=arcId, status=active, gsi1pk=ACCT#{accountId}#ARC#{arcId}

// UPDATE SIGNAL (edit draft) — table update by signalLookupId
updateSignal(accountId, signalLookupId, fields):
  UPDATE pk=ACCT#{accountId}#SIG#{signalLookupId}, sk=#
  SET ...fields

// UPDATE SIGNAL SEND STATUS — table update by signalLookupId
updateSignalSendStatus(accountId, signalLookupId, update):
  UPDATE pk=ACCT#{accountId}#SIG#{signalLookupId}, sk=#
  SET status, sentAt, sesMessageId, etc.

// DELETE SIGNAL — table delete by signalLookupId
deleteSignal(accountId, signalLookupId):
  DELETE pk=ACCT#{accountId}#SIG#{signalLookupId}, sk=#

// ADD EMBEDDING TO CACHE — table update by signalLookupId
addEmbeddingToCache(accountId, signalLookupId, modelId, vector):
  UPDATE pk=ACCT#{accountId}#SIG#{signalLookupId}, sk=#
  SET embeddings.{modelId} = vector

// HAS SIGNALS (onboarding) — queries arcs, not signals
hasSignals(accountId):
  QUERY gsi1 WHERE gsi1pk=ACCT#{accountId} AND begins_with(gsi1sk, LASTACT#)
  Limit=1, Select=COUNT
```

### Caller Pattern for Updates

When a caller needs to update/delete a signal:
1. If the caller already has the signal object → use `signal.signalLookupId`
2. If the caller only has the `sgn-` ID → fetch via GSI first (query the arc partition with a filter on `id`), then use the returned `signalLookupId`

For user/system signals, `signalLookupId` equals `id` (both are the `sgn-` value). The distinction only matters for inbound SES signals where `signalLookupId = ses-{messageId}` and `id = sgn-{...}`.

### Changes Per File

| File | Current | New |
|------|---------|-----|
| `src/api/app.ts` (arc creation) | `randomUUID()` | `generateId("arc-")` |
| `src/api/app.ts` (template creation, 2 sites) | `randomUUID()` | `generateId("tpl-")` |
| `src/api/app.ts` (alias creation) | `randomUUID()` | Remove — address is the natural key |
| `src/api/app.ts` (forwarding address creation) | `randomUUID()` | Remove — address is the natural key |
| `src/api/app.ts` (draft signal `USR#`) | `USR#${randomUUID()}` | `generateId("sgn-")` |
| `src/processor/processor.ts` (arc creation) | `randomUUID()` | `generateId("arc-")` |
| `src/processor/processor.ts` (alias creation) | `randomUUID()` | Remove — address is the natural key |
| `src/processor/processor.ts` (inbound signal) | `SES#${sesMessageId}` | `generateId("sgn-")` (table PK uses `ses-{sesMessageId}` separately) |
| `src/processor/processor.ts` (draft signal `USR#`) | `USR#${randomUUID()}` | `generateId("sgn-")` |
| `src/notifier/feedback-processor.ts` (`SYS#`) | `SYS#${randomUUID()}` | `generateId("sgn-")` |
| `src/processor/system-signal-creator.ts` | `randomUUID()` | `generateId("sgn-")` |
| `src/database/account-database.ts` (view) | `randomUUID()` | `generateId("view-")` |
| `src/database/account-database.ts` (rule) | `randomUUID()` | `generateId("rule-")` |
| `src/database/account-database.ts` (label) | `randomUUID()` | Use label name as key — no generated ID |
| `src/database/audit-database.ts` (event) | `randomUUID()` | `generateId("aud-")` |
| `src/jobs/reindex/reindex-dispatcher.ts` (job) | `randomUUID()` | `logger.invocationId` — Lambda invocation ID is the natural correlation key |
| `src/database/arc-database.ts` (saveSignal) | `gsi1sk = RECV#${signal.receivedAt}#${signal.id}` | `gsi1sk = signal.id` (the `sgn-` ID sorts chronologically) |
| `src/database/arc-database.ts` (saveSignal) | `gsi1pk = ARCSIG#${signal.arcId}` | `gsi1pk = ACCT#${signal.accountId}#ARC#${signal.arcId}` |
| `src/database/arc-database.ts` (sigPk) | `ACCT#${accountId}#SIG#${id}` | For inbound: `ACCT#${accountId}#SIG#ses-${sesMessageId}`, for others: `ACCT#${accountId}#SIG#${sgnId}` |

### Unchanged Sites

| File | ID | Reason |
|------|-----|--------|
| `src/api/app.ts` (forwarding address `token`) | `randomUUID()` | Secret verification token, not a public ID |
| `src/logger.ts` (container ID) | `randomUUID().slice(0, 8)` | Internal cold-start correlation, not entity ID |

## Data Models

No schema changes to entity fields. The ID field on each entity remains a string. Old UUIDs and new prefixed IDs coexist — DynamoDB stores whatever string is provided.

### GSI Key Changes (Signals Table)

All signal GSI PKs now include `ACCT#{accountId}#` for tenant isolation:

| Before | After |
|--------|-------|
| `ARCSIG#{arcId}` | `ACCT#{accountId}#ARC#{arcId}` |
| `QUARANTINED#{accountId}` | `ACCT#{accountId}#QUARANTINED` |
| `BLOCKED#{accountId}` | `ACCT#{accountId}#BLOCKED` |

This affects:
- `saveSignal` — writes `gsi1pk` based on signal status
- `unblockSignal` — updates `gsi1pk` when promoting from quarantine to arc
- `updateSignalStatus` — updates `gsi1pk` when blocking
- `listSignalsForArc` — queries by `gsi1pk`
- `listPreArcSignals` — queries quarantined signals

Arc items in the same table are unaffected — they already use `gsi1pk = ACCT#{accountId}` with `gsi1sk = LASTACT#...`.

## Correctness Properties

### Property 1: Generated IDs are unique

For any two calls to `generateId` with the same or different prefixes, the returned strings SHALL be distinct (UUIDv7 guarantees uniqueness via timestamp + random bits).

### Property 2: Generated IDs are time-sortable within the same prefix

For two IDs generated at different times with the same prefix, lexicographic comparison of the base58 body SHALL reflect chronological order (earlier < later). This holds because UUIDv7's most significant bits are the timestamp, and base58 encoding preserves numeric ordering.

### Property 3: Check characters detect single-character errors

For any generated ID, changing exactly one character in the base58 body SHALL (with high probability) produce a different set of check characters, making the corruption detectable.

### Property 4: IDs contain the correct prefix

For any call `generateId(prefix)`, the returned string SHALL start with exactly `prefix`.

## Error Handling

`generateId` is a pure computation (crypto random + hash). It cannot fail in any recoverable way — if `crypto.randomUUID()` or `createHash` fail, the process is in an unrecoverable state. No try/catch needed.

## Testing Strategy

### Unit Tests (`tests/utils/id.spec.ts`)

1. **Format validation** — `it.each` over all prefixes: generated ID starts with prefix, base58 body is 22 chars, check chars are 3 chars from the base58 alphabet.
2. **Uniqueness** — generate 1000 IDs, all distinct.
3. **Time ordering** — generate two IDs with a small delay, verify lexicographic order of the base58 portion matches chronological order.
4. **Check character correctness** — generate an ID, recompute check chars from the base58 body, verify they match.
5. **Check character sensitivity** — generate an ID, flip one character in the base58 body, verify check chars no longer match.

### Integration verification

After replacing all `randomUUID()` sites, run the full test suite (`npm run check`). Existing tests that create entities will exercise the new ID generation implicitly — any test that asserts on ID format (e.g. exact UUID regex) will need updating.
