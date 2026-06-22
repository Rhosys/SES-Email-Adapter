# Technical Design

## Overview

Introduces a GSI2-based `In-Reply-To` arc lookup as Tier 1.5 in the processor's arc matching pipeline. All three tiers (grouping key, In-Reply-To, similarity) execute in parallel on every inbound signal. The system selects the match from the highest-priority tier, and logs discrepancies when tiers disagree.

## Architecture

### Data Flow

```
Inbound email arrives
  │
  ├─── Parallel execution ────────────────────────────────────┐
  │                                                           │
  │  Tier 1: Grouping Key (DDB GetItem on GKEY# pointer)     │
  │  Tier 1.5: In-Reply-To (DDB Query on GSI2)     ← NEW     │
  │  Tier 2: Embedding + Similarity (Bedrock + Aurora)        │
  │                                                           │
  ├───────────────────────────────────────────────────────────┘
  │
  ├─ Compare results, log discrepancies (TRACK)
  ├─ Select arc by priority: Tier 1 > Tier 1.5 > Tier 2
  │
  └─ Signal saved with gsi2pk = ACCT#{accountId}#MSGID#{msgId}
```

### GSI2 Schema

| Attribute | Role | Example |
|-----------|------|---------|
| `gsi2pk` (String) | Hash key | `ACCT#acc-123#MSGID#<unique-id@gmail.com>` |
| `arcId` | Projected | `arc-abc123` |
| `accountId` | Projected | `acc-123` |
| `id` | Projected | `sgn-xyz789` |
| `signalLookupId` | Projected | `ses-0102abc...` |
| `source` | Projected | `email` |
| `status` | Projected | `active` |
| `type` | Projected | `email` |

Projection type: `INCLUDE`. No sort key — each `gsi2pk` maps to exactly one signal (Message-IDs are globally unique per RFC 5322).

### Key Construction

```typescript
const GSI2_PREFIX = "ACCT#";
const MSGID_SEPARATOR = "#MSGID#";
const MAX_GSI2PK_LENGTH = 1024;

/** Extract msg-id from a raw Message-ID header value (strip angle brackets). */
function extractMsgId(raw: string): string | null {
  const match = raw.match(/<([^>]+)>/);
  if (match) return match[1];
  const trimmed = raw.trim();
  return trimmed || null;
}

function buildGsi2pk(accountId: string, msgId: string): string {
  const key = `${GSI2_PREFIX}${accountId}${MSGID_SEPARATOR}${msgId}`;
  return key.slice(0, MAX_GSI2PK_LENGTH);
}
```

### Outbound Message-ID Construction

SES overrides the `Message-ID` header on outbound emails. The format is stable:
```
<{sesMessageId}@{region}.amazonses.com>
```

The msg-id (without brackets) is `{sesMessageId}@{region}.amazonses.com`.

```typescript
function buildOutboundMsgId(sesMessageId: string, sesRegion: string): string {
  return `${sesMessageId}@${sesRegion}.amazonses.com`;
}
```

`SES_REGION` is an environment variable set at deployment time (same region as the SESv2 client).

## Components Modified

### 1. `src/processor/processor.ts` — processMessage()

**Step 6 (Arc Matching) restructured — parallel execution:**

```
Current:
  6a. deriveGroupingKey → grouping key lookup
  6b. If no grouping key → similarity search

New:
  6a. Execute all three tiers in parallel:
      - Tier 1: deriveGroupingKey → DDB GetItem (if key exists)
      - Tier 1.5: extract In-Reply-To msg-id → GSI2 Query (if header exists)
      - Tier 2: buildEmbedText → generate embedding → Aurora similarity search
  6b. Await all results
  6c. Compare: if multiple tiers matched different arcs → log TRACK discrepancy
  6d. Select arc by priority: Tier 1 > Tier 1.5 > Tier 2 > create new arc
```

The In-Reply-To lookup:
1. Extract `in-reply-to` from `parsed.headers`
2. If absent or empty → Tier 1.5 result is null
3. Extract first msg-id: regex `/<([^>]+)>/` on the header value
4. Build GSI2 key: `buildGsi2pk(accountId, firstMsgId)`
5. Query GSI2 via `arcDb.findSignalByMessageId(gsi2pk)`
6. If result has `arcId` → Tier 1.5 matched
7. If no result or no `arcId` → Tier 1.5 result is null

**Signal save — add `gsi2pk`:**

When constructing the signal item before `arcDb.saveSignal()`:
- Extract `message-id` from `parsed.headers`
- Extract msg-id via `extractMsgId(rawHeader)`
- If non-null, compute `gsi2pk` via `buildGsi2pk(accountId, msgId)` and include on the signal item

### 2. `src/processor/draft-send-worker.ts`

After successful SES send, when updating the signal to `status: "sent"`:
- Compute outbound Message-ID: `buildOutboundMessageId(messageId, SES_REGION)`
- Compute `gsi2pk`: `buildGsi2pk(accountId, outboundMessageId)`
- Include `gsi2pk` in the DDB update expression

### 3. `src/database/arc-database.ts`

New method:

```typescript
async findSignalByMessageId(gsi2pk: string): Promise<Result<{ arcId?: string; id: string; signalLookupId: string; status: string } | null, DbError>>
```

Implementation: DynamoDB `Query` on `gsi2` index with `KeyConditionExpression: gsi2pk = :val`, `Limit: 1`.

### 4. `email-catcher/infrastructure/` — Terraform

Add GSI2 to the signals table resource:

```hcl
global_secondary_index {
  name            = "gsi2"
  hash_key        = "gsi2pk"
  projection_type = "INCLUDE"
  non_key_attributes = ["arcId", "accountId", "id", "signalLookupId", "source", "status", "type"]
}
```

Add `gsi2pk` to the table's `attribute` block:

```hcl
attribute {
  name = "gsi2pk"
  type = "S"
}
```

### 5. `src/types/index.ts`

Add `gsi2pk?: string` to `SignalBase` interface (optional — absent when no Message-ID available or for non-email signal types).

## Error Handling

| Scenario | Behavior |
|----------|----------|
| GSI2 query throws transient error | Log WARN, treat as miss, fall through to similarity |
| `In-Reply-To` header malformed | Use raw value as-is (DDB handles arbitrary strings) — likely miss, falls through |
| GSI2 hit but `arcId` is undefined | Treat as miss (signal was quarantined/blocked without arc assignment) |
| GSI2 hit but arc not found in DDB | Log WARN (orphan reference), treat as miss |
| `message-id` header missing on inbound | Signal saved without `gsi2pk` — future replies can't match via this path |

## Performance Impact

| Operation | Before | After |
|-----------|--------|-------|
| All inbound signals | Bedrock ~300ms + Aurora ~50ms (when similarity needed) | Same + 1 DDB GSI2 query (~5ms) in parallel |
| Signal write | DDB PutItem | Same PutItem with one extra attribute |

Net: no latency savings — all tiers run unconditionally. The GSI2 query adds ~5ms but executes in parallel with Tier 2 so does not extend the critical path. The value is correctness validation (discrepancy detection) and the foundation for future short-circuit optimization once confidence is established.

## Testing Strategy

- Unit test `buildGsi2pk` — empty/null/whitespace/long/normal cases
- Unit test `buildOutboundMessageId` — format correctness
- Processor integration test: mock `arcDb.findSignalByMessageId` to return a signal with arcId → verify embedding generation is skipped
- Processor integration test: In-Reply-To miss → verify fall-through to similarity
- Processor integration test: grouping key hit → verify In-Reply-To lookup never called
- Draft-send-worker test: verify `gsi2pk` included in the update after successful send
