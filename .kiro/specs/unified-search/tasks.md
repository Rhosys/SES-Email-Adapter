# Implementation Plan: Unified Search

## Overview

Replace the DynamoDB scan-and-filter thread search with vector similarity search via Aurora pgvector, unify the two frontend search surfaces into a shared `useSearch` composable, and add a sender info popup on thread/quarantine detail screens. Backend changes land in `email-catcher/backend`, frontend changes in `email-catcher/site-ui`.

## Tasks

- [x] 1. Backend: Add vector search and batch hydration methods
  - [x] 1.1 Add `searchByVector` method to `ThreadMatcher` class
    - Add method to `src/database/thread-matcher.ts` that accepts `(accountId, embedding, limit)` and returns `Result<string[], DbError>`
    - Uses `SET LOCAL app.current_account_id` for RLS, filters by `accountId` in WHERE, orders by cosine distance ascending, applies `SIMILARITY_THRESHOLD`, returns up to `limit` threadIds
    - No `recipientAddress` filter — searches across all aliases in the account
    - Uses existing `withRetry`, `getDbForCluster`, `getPrimaryThreadMatcherRegistry` patterns
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4_

  - [x] 1.2 Add `batchGetThreads` method to `ThreadDatabase` class
    - Add method to `src/database/thread-database.ts` that accepts `(accountId, threadIds)` and returns `Result<Thread[], DbError>`
    - Uses DynamoDB `BatchGetCommand` with keys built from `threadPk(accountId, id)` + `ITEM_SK`
    - Applies `hydrateThreadObject` to each returned item
    - Returns empty array for empty input, naturally filters orphaned embeddings (missing keys return nothing)
    - _Requirements: 1.3, 1.6_

  - [x] 1.3 Remove old `searchThreads` method from `ThreadDatabase`
    - Delete the `searchThreads` method from `src/database/thread-database.ts`
    - Remove any imports or types only used by this method
    - _Requirements: 7.1, 7.2_

  - [x] 1.4 Write unit tests for `searchByVector`
    - Test in `tests/database/thread-matcher-search.spec.ts`
    - Mock Drizzle transaction, verify RLS `SET LOCAL` is called, verify WHERE includes accountId, verify ordering by cosine distance, verify limit applied, verify `SIMILARITY_THRESHOLD` used
    - Test error path returns `err(DbError)`
    - _Requirements: 1.2, 2.1, 2.2_

  - [x] 1.5 Write unit tests for `batchGetThreads`
    - Test in `tests/database/thread-database-batch.spec.ts`
    - Mock DynamoDB BatchGetCommand, verify key construction, verify `hydrateThreadObject` applied, verify empty input returns `ok([])`, verify missing items are filtered out
    - _Requirements: 1.3_

- [x] 2. Backend: Wire vector search into ThreadsApi handler
  - [x] 2.1 Add `embeddingGenerator` and `threadMatcher` to `ThreadsApi` constructor and wiring
    - Add `embeddingGenerator: EmbeddingGenerator` and `threadMatcher: ThreadMatcher` to constructor params in `src/api/threadsApi.ts`
    - Add both to `AppDeps` interface in `src/api/app.ts`
    - Pass `embeddingGenerator` and `searchDatabase` (as `threadMatcher`) from `createApp` to `new ThreadsApi(...)`
    - Add `embeddingGenerator` and `searchDatabase` to `createApp` call in `src/handler.ts`
    - _Requirements: 7.2_

  - [x] 2.2 Replace `q` branch in GET threads handler with vector search orchestration
    - In `src/api/threadsApi.ts`, replace the `searchThreads` call in the `q` branch with:
      1. Validate `q` length (3–64 chars) → 400 if invalid
      2. Call `embeddingGenerator.generateForModel(q, getPrimaryThreadMatcherRegistry().modelId)` → 503 on failure
      3. Call `threadMatcher.searchByVector(accountId, embedding, 10)` → 503 on failure
      4. Call `threadDb.batchGetThreads(accountId, threadIds)` → 500 on failure
      5. Return `page("threads", results.map(toApiThread), undefined)` with 200
    - When `q` is present, ignore `workflow`, `label`, `status` params
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 7.1, 7.2, 7.3, 7.4_

  - [x] 2.3 Write unit tests for the updated GET threads `q` handler
    - Update `tests/api/api.spec.ts` search test to mock `embeddingGenerator.generateForModel` and `threadMatcher.searchByVector` instead of `threadDb.searchThreads`
    - Test 400 for query < 3 or > 64 chars
    - Test 503 when embedding generation fails
    - Test 503 when vector search fails
    - Test 500 when batchGetThreads fails
    - Test 200 with empty results
    - Test 200 with hydrated results
    - Update all `makeThreadDb()` mocks across test files to remove `searchThreads` and add `batchGetThreads`
    - _Requirements: 1.4, 1.5, 1.6_

- [x] 3. Checkpoint - Backend tests pass
  - Ensure all tests pass with `npm test` in the backend directory, ask the user if questions arise.

- [x] 4. Frontend: Create `useSearch` composable
  - [x] 4.1 Add `q` param support to `api.listThreads` in `site-ui/src/lib/api.ts`
    - Add `q?: string` to `ThreadListParams` interface (or equivalent params type)
    - Wire `q` into the query string: `if (params.q) qs.set('q', params.q)`
    - When `q` is provided, do not include `workflow`, `status`, or `sender` params
    - _Requirements: 7.2, 3.1_

  - [x] 4.2 Create `site-ui/src/composables/useSearch.ts`
    - Implement `useSearch(opts: { mode: 'typeahead' | 'full' })` returning `{ query, results, loading, searched, error, onPaste }`
    - `results` contains `{ threads, aliases, rules, templates }` — fixed category set
    - Debounce query changes by 250ms, minimum 3 chars to fire, max 64 chars (truncate)
    - On query ≥ 3 chars: call `api.listThreads({ q })` for threads + `api.listAliases`, `api.listRules`, `api.listTemplates` in parallel; client-side substring filter for aliases/rules/templates
    - Stale-query guard: track `activeQuery`, discard responses for superseded queries
    - `onPaste` handler: trim whitespace, check for known ID prefixes (thr-, sgn-, rule-, tpl-, view-, acc-) with checksum validation, bypass debounce for direct lookup, fall through to text search if not found
    - Typeahead mode limits: threads 4, aliases 3, rules 3, templates 3
    - Full mode limits: up to 50 per category
    - Clear results and cancel pending when query drops below 3 chars
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [x] 5. Frontend: Integrate `useSearch` into both surfaces
  - [x] 5.1 Refactor `AppLayout.vue` navbar search to use `useSearch`
    - Remove all inline search logic (debounce, fetchSuggestions, suggestions ref, stale-query guard, category toggles)
    - Replace with `const { query, results, loading, searched, onPaste } = useSearch({ mode: 'typeahead' })`
    - Bind dropdown sections to `results.threads`, `results.aliases`, `results.rules`, `results.templates`
    - Remove senders section from dropdown
    - Add templates section to dropdown
    - Add `maxlength="64"` to search input
    - Delegate paste handler to `onPaste` from composable
    - Hide categories with zero results
    - _Requirements: 3.1, 3.2, 4.1, 4.3, 4.6_

  - [x] 5.2 Refactor `SearchView.vue` to use `useSearch`
    - Remove all inline search logic (doSearch, directLookup, auto-search watcher, debounce)
    - Replace with `const { query, results, loading, searched, error, onPaste } = useSearch({ mode: 'full' })`
    - Remove signals and senders sections
    - Add templates section
    - Add `maxlength="64"` to search input
    - Bind query to route query param (`/search?q=...`) for shareability
    - Hide categories with zero results
    - Remove category toggle pills
    - _Requirements: 3.1, 3.2, 4.2, 4.4, 4.5_

- [x] 6. Frontend: Sender info popup
  - [x] 6.1 Create `site-ui/src/components/SenderInfoPopup.vue`
    - Props: `senderAddress`, `aliasAddress`, `accountId`
    - On mount: fetch sender config via `api.listAliasSenders(accountId, aliasAddress)` + alias config from account data
    - Display: sender domain, current policy (allow/block_hidden/block_reject/report_violation), alias unknownSenderPolicy
    - Policy change: call `api.updateAliasSender(...)` on select
    - Alias policy change: call `api.updateAlias(...)` on select
    - Show toast on save via `useToast().notify(...)`
    - _Requirements: 5.2, 5.3, 5.4, 5.5_

  - [x] 6.2 Add sender click trigger to `ThreadDetailView.vue`
    - Make sender address line clickable with `cursor-pointer`, `hover:text-ctp-mauve`, `hover:underline`
    - Click opens `SenderInfoPopup` as a popover below sender text
    - _Requirements: 5.1_

  - [x] 6.3 Add sender click trigger to quarantine signal detail
    - Same pattern as ThreadDetailView — sender address becomes clickable, opens `SenderInfoPopup`
    - _Requirements: 5.1_

- [x] 7. Checkpoint - Frontend tests pass
  - Ensure all tests pass with `npm test` in the site-ui directory, ask the user if questions arise.

- [x] 8. Final checkpoint - Both test gates pass
  - Run `npm test` in backend directory
  - Run `npm test` in site-ui directory
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The backend and frontend are separate git repos — changes can be committed independently
- `embeddingGenerator` and `searchDatabase` (ThreadMatcher) already exist in `handler.ts` — they just need wiring through `createApp` → `ThreadsApi`
- The old `searchThreads` method uses DynamoDB Query + client-side filter — it is fully replaced by vector search
- Test mocks across multiple test files reference `searchThreads` — those mocks need updating to `batchGetThreads`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "4.1"] },
    { "id": 1, "tasks": ["1.3", "1.4", "1.5", "4.2"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "5.1", "5.2"] },
    { "id": 4, "tasks": ["2.3", "6.1"] },
    { "id": 5, "tasks": ["6.2", "6.3"] }
  ]
}
```
