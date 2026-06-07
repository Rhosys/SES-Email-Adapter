# Implementation Tasks

## Task 1: Status-to-category mapping and types

- [x] Write `src/database/stats-writer.test.ts` — test `statusToCategory` maps each non-draft SignalStatus to the correct category, and returns `null` for `draft`
- [x] Create `src/database/stats-writer.ts` — export `statusToCategory` with exhaustive `satisfies` check
- [x] Add `StatsCategory` type to `src/types/index.ts`
- [x] Run `npm run check` — tests pass, types check

## Task 2: Build UpdateCommand params (pure function)

- [x] Add tests to `stats-writer.test.ts` — `buildStatsUpdateParams` returns correct `ADD` expression names/values for each category, includes `totalSignals`, uses correct date-prefixed attribute names for daily/monthly/yearly based on a given date
- [x] Implement `buildStatsUpdateParams(accountId, category, now)` in `stats-writer.ts` — returns `{ Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues }`
- [x] Run `npm run check` — tests pass

## Task 3: Pruning logic (pure function)

- [x] Add tests to `stats-writer.test.ts` — `buildPruneNames` returns REMOVE targets for day-8 through day-14 and month-3 through month-4, returns empty when no stale attributes exist (e.g. first day of operation)
- [x] Implement `buildPruneNames(now)` in `stats-writer.ts` — returns `{ removeExpression, attributeNames }` for stale daily and monthly attributes
- [x] Verify `buildStatsUpdateParams` integrates the prune expression into the final UpdateCommand
- [x] Run `npm run check` — tests pass

## Task 4: Parse stats row (pure function)

- [x] Add tests to `stats-writer.test.ts` — `parseStatsRow` transforms a raw DDB item (with flat attributes) into the structured `StatsResponse` shape, handles missing row (null → zeroed response), sorts daily desc, monthly desc, yearly desc
- [x] Implement `parseStatsRow(item)` in `stats-writer.ts`
- [x] Run `npm run check` — tests pass

## Task 5: Database methods (incrementStats + getStats)

- [x] Add `incrementStats` and `getStats` methods to `AccountDatabase` in `account-database.ts`
- [x] `incrementStats` calls `buildStatsUpdateParams` + `buildPruneNames`, merges them, sends a single `UpdateCommand`
- [x] `getStats` does a `GetCommand` with `pk: ACCT#${accountId}`, `sk: STATS` and returns the raw item
- [x] Run `npm run check` — types check

## Task 6: Wire stats increment into processor

- [x] Add `incrementStats` to the `ProcessorDatabase` interface in `processor.ts`
- [x] Call `incrementStats` at each signal outcome point in `processMessage`
- [x] Wrap each call in try/catch — log warning on failure, never propagate
- [x] Update `ProcessorDatabaseAdapter` in `adapters.ts` to delegate to `AccountDatabase.incrementStats`
- [x] Run `npm run check` — types check, existing tests pass

## Task 7: API route

- [x] Add `GET /accounts/:accountId/stats` route to `app.ts` with `authz("stats:read", ...)`
- [x] Route calls `store.getStats(accountId)`, pipes through `parseStatsRow`, returns 200
- [x] Add `getStats` to the `ApiDatabaseAdapter` in `adapters.ts`
- [x] Run `npm run check` — types check, tests pass

## Task 8: Integration test

- [x] Write integration test in `src/database/stats-writer.integration.spec.ts` — mock DynamoDB, call `incrementStats` for multiple statuses, then `getStats` and verify the parsed response matches expected shape and values
- [x] Run `npm run check` — all tests pass
