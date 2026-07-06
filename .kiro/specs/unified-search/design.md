# Design Document

## Overview

Replace the DynamoDB scan-and-filter thread search with vector similarity search against the existing Aurora pgvector infrastructure. Unify the two divergent frontend search surfaces (navbar typeahead + /search page) into a single shared `useSearch` composable. Add a sender info popup on thread/quarantine detail screens.

## Architecture

### Search flow

```
Client → GET /accounts/{accountId}/threads?q=...
       → ThreadsApi handler
       → ThreadDatabase.searchThreadsByVector(accountId, query)
           → EmbeddingGenerator.generateForModel(query, primaryModelId)
           → ThreadMatcher.searchByVector(accountId, embedding, limit)
               → Aurora: SET LOCAL app.current_account_id + cosine similarity query
               → Returns threadId[] with distance < 0.5
           → ThreadDatabase.batchGetThreads(accountId, threadIds[])
               → DynamoDB BatchGetItem
               → Filter out missing (orphaned embeddings)
       → Return hydrated Thread[]
```

### Component responsibilities

| Component | Role |
|-----------|------|
| `ThreadsApi` | Route handler — validates `q` param (3–64 chars), dispatches to vector search or list |
| `ThreadDatabase` | New `searchThreadsByVector` method + new `batchGetThreads` helper |
| `EmbeddingGenerator` | Already exists — generates 1024-dim Titan v2 embedding from text |
| `ThreadMatcher` | New `searchByVector` method — account-scoped cosine query returning top-N threadIds |

### Key design decisions

1. **No recipientAddress filter on search** — the existing `findMatch` filters by recipientAddress (for thread grouping during ingest). Search spans all aliases within the account, so the new `searchByVector` method omits this filter.

2. **Reuse existing Aurora infrastructure** — same cluster, same RLS policy, same retry/resume logic. The new method is a sibling to `findMatch`, not a replacement.

3. **BatchGetItem for hydration** — DynamoDB BatchGetItem (up to 100 keys) is cheaper and faster than 10 sequential GetItem calls. Returns only threads that still exist, naturally filtering orphaned embeddings.

4. **503 on infrastructure failure** — if embedding generation or Aurora query fails, return 503 (not 500) to signal transient unavailability. The client can retry or fall back to showing recent threads.

5. **Distance threshold 0.5** — same as `SIMILARITY_THRESHOLD` already used in thread matching. Results with cosine distance ≥ 0.5 are too dissimilar to be useful.

## File changes

### `src/database/thread-matcher.ts`

Add `searchByVector` method to `ThreadMatcher`:

```typescript
async searchByVector(accountId: string, embedding: number[], limit: number): Promise<Result<string[], DbError>> {
  const cluster = getPrimaryThreadMatcherRegistry();
  const db = getDbForCluster(cluster);

  try {
    const rows = await withRetry(async () => {
      return db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL app.current_account_id = '${accountId.replace(/'/g, "''")}'`));

        return tx
          .select({ threadId: threadEmbeddings.threadId })
          .from(threadEmbeddings)
          .where(and(
            eq(threadEmbeddings.accountId, accountId),
            sql`${threadEmbeddings.embedding} <=> ${toVector(embedding)} < ${SIMILARITY_THRESHOLD}`,
          ))
          .orderBy(sql`${threadEmbeddings.embedding} <=> ${toVector(embedding)}`)
          .limit(limit);
      });
    });

    return ok(rows.map(r => r.threadId));
  } catch (e) {
    return err(dbError(e));
  }
}
```

Key differences from `findMatchForThreadMatcher`:
- No `recipientAddress` filter — searches across all aliases
- Returns `string[]` (threadIds), not a single `Thread | null`
- Configurable `limit` (default 10 from caller)

### `src/database/thread-database.ts`

Add `batchGetThreads` method:

```typescript
async batchGetThreads(accountId: string, threadIds: string[]): Promise<Result<Thread[], DbError>> {
  if (threadIds.length === 0) return ok([]);
  try {
    const keys = threadIds.map(id => ({ pk: threadPk(accountId, id), sk: ITEM_SK }));
    const res = await dynamo.send(new BatchGetCommand({
      RequestItems: { [SIGNALS_TABLE]: { Keys: keys } },
    }));
    const items = (res.Responses?.[SIGNALS_TABLE] ?? []) as Thread[];
    return ok(items.map(hydrateThreadObject));
  } catch (e) {
    return err(dbError(e));
  }
}
```

Replace `searchThreads` implementation:

```typescript
async searchThreadsByVector(accountId: string, query: string, limit: number): Promise<Result<Thread[], DbError>> {
  // 1. Generate embedding from query text
  const embeddingResult = await this.embeddingGenerator.generateForModel(
    query, getPrimaryThreadMatcherRegistry().modelId
  );
  if (embeddingResult.isErr()) return err(dbError(embeddingResult.error));

  // 2. Vector search in Aurora (account-scoped, no recipientAddress filter)
  const threadIdsResult = await this.threadMatcher.searchByVector(
    accountId, embeddingResult.value.vector, limit
  );
  if (threadIdsResult.isErr()) return err(threadIdsResult.error);
  if (threadIdsResult.value.length === 0) return ok([]);

  // 3. Hydrate from DynamoDB (filters out orphaned embeddings)
  return this.batchGetThreads(accountId, threadIdsResult.value);
}
```

Note: `ThreadDatabase` will need `embeddingGenerator` and `threadMatcher` injected. Alternatively, compose this in the API handler directly to avoid coupling ThreadDatabase to Aurora. Decision: **compose in the handler** — ThreadDatabase stays a pure DynamoDB wrapper, the handler orchestrates embedding → Aurora → DynamoDB.

### `src/api/threadsApi.ts`

Update the `q` branch in the GET handler:

```typescript
if (q) {
  if (q.length < 3 || q.length > 64) {
    return err(c, 400, "Query must be between 3 and 64 characters");
  }

  const embeddingResult = await embeddingGenerator.generateForModel(
    q, getPrimaryThreadMatcherRegistry().modelId
  );
  if (embeddingResult.isErr()) {
    logger.error("Embedding generation failed for search.", { code: "api.threads.search_embed_failed", error: embeddingResult.error });
    return err(c, 503, "Search temporarily unavailable");
  }

  const threadIdsResult = await threadMatcher.searchByVector(
    accountId, embeddingResult.value.vector, 10
  );
  if (threadIdsResult.isErr()) {
    logger.error("Vector search failed.", { code: "api.threads.search_vector_failed", error: threadIdsResult.error });
    return err(c, 503, "Search temporarily unavailable");
  }

  if (threadIdsResult.value.length === 0) {
    return c.json(page("threads", [], undefined), 200);
  }

  const threadsResult = await threadDb.batchGetThreads(accountId, threadIdsResult.value);
  if (threadsResult.isErr()) {
    logger.error("Failed to hydrate search results.", { code: "api.threads.search_hydrate_failed", error: threadsResult.error });
    return err(c, 500, "Internal Server Error");
  }

  return c.json(page("threads", threadsResult.value.map(toApiThread), undefined), 200);
}
```

### `src/api/threadsApi.ts` — constructor dependencies

Add `embeddingGenerator: EmbeddingGenerator` and `threadMatcher: ThreadMatcher` to the `ThreadsApi` constructor. These are already instantiated in the Lambda handler bootstrap — wire them through.

### `src/database/thread-database.ts` — remove old `searchThreads`

Delete the existing `searchThreads` method entirely. The vector search path in the handler replaces it. The `listThreads` method (no `q` param) remains unchanged for browsing.

## Interfaces

### `ThreadMatcher` additions

```typescript
// Add to MultiClusterAuroraWriter or directly on ThreadMatcher class:
searchByVector(accountId: string, embedding: number[], limit: number): Promise<Result<string[], DbError>>;
```

### `ThreadDatabase` additions

```typescript
batchGetThreads(accountId: string, threadIds: string[]): Promise<Result<Thread[], DbError>>;
```

### `ThreadDatabase` removals

```typescript
// Remove:
searchThreads(accountId: string, query: string, params: PageParams): Promise<Result<Page<Thread>, DbError>>;
```

## Error handling

| Failure | Response | Retry? |
|---------|----------|--------|
| Embedding generation fails (Bedrock) | 503 | Client retries |
| Aurora query fails (transient) | 503 | Client retries |
| Aurora query fails (cluster not found) | 500 | No — config error |
| DynamoDB BatchGet fails | 500 | Client retries |
| Query < 3 or > 64 chars | 400 | No — client error |

## Testing strategy

1. **Unit test `searchByVector`** — mock Drizzle, verify SQL structure, RLS context, limit, threshold
2. **Unit test `batchGetThreads`** — mock DynamoDB BatchGetCommand, verify key construction, orphan filtering
3. **Unit test handler** — mock embeddingGenerator + threadMatcher + threadDb, verify 400/503/200 paths
4. **Remove old `searchThreads` tests** — the scan-and-filter test coverage is no longer relevant

---

## Frontend Design

### Current state

The navbar typeahead (`AppLayout.vue`) and full search page (`SearchView.vue`) have independent, divergent search logic:
- Different debounce timings (250ms vs 300ms)
- Different category sets (navbar: threads/senders/aliases/rules; page: threads/signals/aliases/rules/templates)
- Senders category always empty in navbar (N+1 avoidance comment)
- Thread search passes query as `sender` param (which the backend ignores — it only reads `q`)
- Direct-ID-lookup only works on the full page (paste handler navigates away on navbar)
- Client-side substring filtering after fetching thread lists

### `useSearch` composable — `site-ui/src/composables/useSearch.ts`

Single composable powering both surfaces.

```typescript
interface UseSearchOptions {
  mode: 'typeahead' | 'full'
}

interface SearchResults {
  threads: Thread[]
  aliases: Alias[]
  rules: Rule[]
  templates: EmailTemplate[]
}

interface UseSearchReturn {
  query: Ref<string>
  results: Ref<SearchResults>
  loading: Ref<boolean>
  searched: Ref<boolean>
  error: Ref<string | null>
  onPaste: (event: ClipboardEvent) => void
}
```

**Behavior:**
- `query` is a writable ref. Watcher debounces at 250ms, min 3 chars, max 64 chars (truncates on input).
- On query change ≥ 3 chars: calls `api.listThreads(accountId, { q: query })` for threads + `api.listAliases`, `api.listRules`, `api.listTemplates` in parallel. Client-side filters aliases/rules/templates by substring match.
- Stale-query guard: tracks `activeQuery` string, discards responses for superseded queries.
- `onPaste` handler: if pasted text matches a known ID prefix, bypasses debounce and does direct lookup via `api.getThread`/`api.getSignal`/etc.
- In `typeahead` mode: limits results (threads: 4, aliases: 3, rules: 3, templates: 3).
- In `full` mode: returns up to 50 per category.

**Fix for thread search:** replace `{ sender: q }` with `{ q }` in the `api.listThreads` call. The backend reads `query["q"]` for search — `sender` was always ignored.

### `site-ui/src/lib/api.ts` change

Add `q` to `ThreadListParams`:

```typescript
export interface ThreadListParams {
  q?: string          // ← NEW: vector search query (mutually exclusive with workflow/status/sender)
  workflow?: string
  status?: string
  sender?: string     // keep for inbox filtering by sender
  // ...
}
```

Wire `q` in `listThreads`:
```typescript
if (params.q) qs.set('q', params.q)
```

When `q` is provided, the composable SHALL NOT include `workflow`, `status`, or `sender` params — they are mutually exclusive. The backend ignores them when `q` is present (per R7.3), but not sending them keeps the contract explicit.

### `AppLayout.vue` changes

- Remove all inline search logic (debounce, fetchSuggestions, suggestions ref, stale-query guard, category toggles)
- Replace with `const { query, results, loading, searched, onPaste } = useSearch({ mode: 'typeahead' })`
- Keep the template structure (dropdown, category sections) but bind to `results.threads`, `results.aliases`, `results.rules`, `results.templates`
- Remove senders section entirely from the dropdown
- Add templates section to the dropdown
- Input: add `maxlength="64"` attribute
- Paste handler: delegate to `onPaste` from composable

### `SearchView.vue` changes

- Remove all inline search logic (doSearch, directLookup, auto-search watcher, debounce)
- Replace with `const { query, results, loading, searched, error, onPaste } = useSearch({ mode: 'full' })`
- Remove signals section (no signal-text-search endpoint exists)
- Remove senders section
- Add templates section (already existed)
- Input: add `maxlength="64"` attribute
- Bind query to route query param (`/search?q=...`) for shareability

### Sender info popup — `site-ui/src/components/SenderInfoPopup.vue`

New component shown on ThreadDetailView and quarantine signal detail.

**Props:**
```typescript
interface SenderInfoPopupProps {
  senderAddress: string      // full sender email (from signal.data.from.address)
  aliasAddress: string       // receiving alias (recipientAddress)
  accountId: string
}
```

**Behavior:**
1. On mount: fetches sender config via `api.listAliasSenders(accountId, aliasAddress)` + alias config via existing account data.
2. Displays: sender domain, current policy (allow/block_hidden/block_reject/report_violation), alias unknownSenderPolicy.
3. Policy change: calls `api.updateAliasSender(accountId, aliasAddress, senderDomain, { policy })` on select.
4. Alias policy change: calls `api.updateAlias(accountId, aliasAddress, { unknownSenderPolicy })`.
5. Shows toast on save via `useToast().notify(...)`.

**Trigger in ThreadDetailView.vue:**
- The sender address line (currently plain text) becomes a clickable element with `cursor-pointer` + `hover:text-ctp-mauve` + `hover:underline`.
- Click opens the popup (popover positioned below the sender text).

**Trigger in QuarantineSignalCard.vue (or equivalent):**
- Same pattern — sender address becomes clickable, opens popup.

### Category toggle removal

Both surfaces currently have category toggle pills. With senders removed and the unified set being fixed (threads/aliases/rules/templates), the toggles add complexity without value. **Remove them** — all categories always visible, hidden only when they have zero results.

## Components and Interfaces

### Backend

| Component | Interface | Purpose |
|-----------|-----------|---------|
| `ThreadMatcher` | `searchByVector(accountId, embedding, limit) → Result<string[], DbError>` | Account-scoped cosine similarity search in Aurora, returns threadIds |
| `ThreadDatabase` | `batchGetThreads(accountId, threadIds) → Result<Thread[], DbError>` | DynamoDB BatchGetItem hydration |
| `EmbeddingGenerator` | `generateForModel(text, modelId) → Result<EmbeddingResult, BedrockError>` | Bedrock Titan text → 1024-dim vector (existing) |
| `ThreadsApi` | GET `/accounts/{accountId}/threads?q=...` | Orchestrates embed → vector search → hydrate |

### Frontend

| Component | Interface | Purpose |
|-----------|-----------|---------|
| `useSearch` composable | `useSearch(opts: { mode }) → { query, results, loading, searched, error, onPaste }` | Shared search logic for navbar + search page |
| `SenderInfoPopup` | `<SenderInfoPopup :senderAddress :aliasAddress :accountId />` | Inline sender/alias config editor |
| `AppLayout.vue` | Consumes `useSearch({ mode: 'typeahead' })` | Navbar search dropdown |
| `SearchView.vue` | Consumes `useSearch({ mode: 'full' })` | Full search page |

## Data Models

### Aurora `thread_embeddings` table (unchanged)

| Column | Type | Notes |
|--------|------|-------|
| `thread_id` | text | PK component |
| `account_id` | text | PK component, RLS filter |
| `recipient_address` | text | PK component (ignored in search queries) |
| `embedding` | vector(1024) | HNSW-indexed, cosine distance |
| `updated_at` | timestamptz | TTL cleanup via pg_cron |

### Search API response shape (unchanged)

```typescript
{ threads: Thread[], pagination: { cursor: string | null } }
```

The vector search path returns no cursor (max 10 results, no pagination). The non-search list path continues to support cursor-based pagination.

## Correctness Properties

### Property 1: Account isolation
A user's search can never return threads from another account. Enforced by both SQL WHERE clause and PostgreSQL RLS policy.
**Validates: Requirement 2.1, 2.2**

### Property 2: Orphan safety
If a thread embedding exists but the DDB thread was deleted, the result is silently omitted (BatchGetItem returns nothing for that key).
**Validates: Requirement 1.3**

### Property 3: Stale-query consistency
The frontend never displays results from a superseded query. The composable's `activeQuery` guard ensures only the latest response is applied.
**Validates: Requirement 3.6**

### Property 4: Input bounds
Query must be 3–64 characters. Enforced both client-side (composable won't fire, input truncated at 64) and server-side (400 response).
**Validates: Requirement 1.4, 3.7, 3.8**

### Property 5: Graceful degradation
If Bedrock or Aurora is unavailable, the user sees "Search temporarily unavailable" rather than a broken page. The list/browse path remains functional independently.
**Validates: Requirement 1.5**

