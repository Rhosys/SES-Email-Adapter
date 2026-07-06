# Technical Design

## Overview

Add per-account signal statistics tracking to the email-catcher backend. A single DynamoDB row (`sk: STATS`) on the ACCOUNTS_TABLE stores lifetime, daily, monthly, and yearly counters. The processor increments counters atomically after determining signal outcome. An API endpoint exposes the stats.

## Architecture

### Components

1. **`StatsWriter`** — Pure function that builds a DynamoDB `UpdateCommand` from an account ID, signal status, and current UTC date. Called by the processor after signal outcome is determined.

2. **`AccountDatabase.incrementStats()`** — Executes the UpdateCommand built by StatsWriter. Lives in `account-database.ts` alongside other ACCOUNTS_TABLE operations.

3. **`AccountDatabase.getStats()`** — Single `GetItem` that retrieves the STATS row. Returns raw DDB item.

4. **`parseStatsRow()`** — Pure function that transforms the flat DDB attributes into the structured API response shape.

5. **API route** — `GET /accounts/:accountId/stats` in `app.ts`.

### Data Flow

```
Signal processed → processor determines status
  → statsWriter.buildUpdateParams(accountId, status, now)
  → accountDb.incrementStats(params)  [fire-and-forget, log on failure]

GET /stats → accountDb.getStats(accountId)
  → parseStatsRow(item)
  → JSON response
```

### DynamoDB Item Schema

```
pk: ACCT#${accountId}
sk: STATS

// Lifetime
totalSignals: N
totalAllowed: N
totalBlocked: N
totalQuarantined: N
totalreported: N

// Daily (last 7 days) — pruned on write
d_2026-05-16_allowed: N
d_2026-05-16_blocked: N
d_2026-05-16_quarantined: N
d_2026-05-16_reported: N
...

// Monthly (last 2 months) — pruned on write
m_2026-05_allowed: N
...

// Yearly (never pruned)
y_2026_allowed: N
...

updatedAt: S
```

### Status → Category Mapping

| SignalStatus | Category |
|---|---|
| `active` | `allowed` |
| `quarantine_visible` | `quarantined` |
| `quarantine_hidden` | `quarantined` |
| `block_hidden` | `blocked` |
| `block_reject` | `blocked` |
| `report_violation` | `reported` |
| `draft` | (skip — no increment) |

Enforced exhaustively via TypeScript `satisfies Record<Exclude<SignalStatus, 'draft'>, StatsCategory>`.

### UpdateCommand Shape

```typescript
UpdateExpression: `
  ADD totalSignals :one, #totalCat :one,
      #day :one, #month :one, #year :one
  SET updatedAt = :now
  REMOVE #staleDay8, #staleDay9, ..., #staleMonth3, #staleMonth4
`
```

- `ADD` on non-existent attributes initializes to 0.
- `REMOVE` on non-existent attributes is a no-op (DDB behaviour).
- Single round-trip, no condition expression, no read-before-write.

### Pruning Window

- Daily: remove day-8 through day-14 (7 attributes × 4 categories = 28 REMOVE targets max)
- Monthly: remove month-3 and month-4 (2 months × 4 categories = 8 REMOVE targets max)

### API Response Shape

```typescript
interface StatsResponse {
  lifetime: {
    totalSignals: number;
    totalAllowed: number;
    totalBlocked: number;
    totalQuarantined: number;
    totalreported: number;
  };
  daily: Array<{ date: string; allowed: number; blocked: number; quarantined: number; reported: number }>;
  monthly: Array<{ month: string; allowed: number; blocked: number; quarantined: number; reported: number }>;
  yearly: Array<{ year: string; allowed: number; blocked: number; quarantined: number; reported: number }>;
}
```

### Failure Handling

- `incrementStats` is fire-and-forget: the processor logs a warning on failure and continues.
- Stats are best-effort — a missed increment means the dashboard is slightly behind, not that email processing fails.
- No application-level retries beyond the SDK's built-in retry strategy.

## Files Changed

| File | Change |
|---|---|
| `src/database/account-database.ts` | Add `incrementStats()` and `getStats()` methods |
| `src/database/stats-writer.ts` | New file — pure functions: `buildStatsUpdateParams`, `parseStatsRow`, `statusToCategory`, pruning helpers |
| `src/database/stats-writer.test.ts` | New file — unit tests for all pure functions |
| `src/api/app.ts` | Add `GET /accounts/:accountId/stats` route |
| `src/processor/processor.ts` | Call `incrementStats` after signal save (3 call sites: allowed, blocked, quarantined) |
| `src/types/index.ts` | Add `StatsCategory` type |
