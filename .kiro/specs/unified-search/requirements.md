# Requirements Document

## Introduction

Unify the two divergent search surfaces in the email-catcher frontend (navbar typeahead in AppLayout.vue and full /search page in SearchView.vue) into a single shared composable, and replace the backend DynamoDB scan-and-filter thread search with vector similarity search via the existing Aurora pgvector infrastructure.

## Glossary

- **Search_Composable**: A Vue composable (`useSearch`) that encapsulates all search logic (debouncing, API calls, stale-query handling, direct-ID lookup) shared by both the navbar typeahead and the SearchView page.
- **Navbar_Typeahead**: The inline search dropdown in AppLayout.vue that shows top-N results per category as the user types.
- **Search_Page**: The full `/search` route (SearchView.vue) that shows complete results across all categories.
- **Thread_Search_API**: The `GET /accounts/{accountId}/threads?q=...` endpoint backed by `searchThreads` in thread-database.ts.
- **Vector_Search**: Cosine similarity search against Aurora pgvector's `thread_embeddings` table using HNSW index.
- **Embed_Service**: The Bedrock Titan embedding service (`amazon.titan-embed-text-v2:0`) that converts query text into a 1024-dimension vector.
- **Stale_Query_Guard**: Logic that discards results from a superseded request when a newer query has been issued before the older one resolved.
- **Direct_ID_Lookup**: A lookup mode triggered when pasted text matches a known ID format, bypassing text search and fetching resources by ID directly.
- **Category**: A result type group displayed in search (threads, aliases, rules, templates).

## Requirements

### Requirement 1: Vector-based thread search

**User Story:** As a user, I want thread search to find semantically relevant threads, so that I can locate threads even when my query doesn't exactly match the thread summary text.

#### Acceptance Criteria

1. WHEN a search query of 3 to 64 characters is received on the Thread_Search_API, THE Embed_Service SHALL generate a 1024-dimension embedding vector from the query text.
2. WHEN an embedding vector is generated, THE Vector_Search SHALL query the `thread_embeddings` table filtered by `accountId` only, returning the top 10 most similar threadIds with cosine distance less than 0.5, ordered by ascending cosine distance.
3. WHEN similar threadIds are returned from Aurora, THE Thread_Search_API SHALL batch-get the corresponding Thread items from DynamoDB and return only the threads that still exist as hydrated thread objects, omitting any threadIds that no longer resolve.
4. IF the query is fewer than 3 characters or more than 64 characters, THEN THE Thread_Search_API SHALL return an HTTP 400 response with message "Query must be between 3 and 64 characters".
5. IF the search infrastructure is temporarily unavailable, THEN THE Thread_Search_API SHALL return an HTTP 503 response with message "Search temporarily unavailable" and no error code.
6. IF no threads have cosine distance less than 0.5, THEN THE Thread_Search_API SHALL return an empty result set with HTTP 200.

### Requirement 2: Account isolation in vector search

**User Story:** As a user, I want search results scoped to my account only, so that I never see threads belonging to other accounts.

#### Acceptance Criteria

1. THE Vector_Search SHALL set the RLS context (`app.current_account_id`) via `SET LOCAL` within the same database transaction as the similarity query.
2. THE Vector_Search SHALL filter results by `accountId` in the WHERE clause in addition to relying on the RLS policy.
3. THE Vector_Search SHALL NOT filter by `recipientAddress` — results span all aliases within the account.
4. IF setting the RLS context fails, THEN THE Vector_Search SHALL abort the transaction and return an error without executing the similarity query.

### Requirement 3: Unified search composable

**User Story:** As a developer, I want a single composable that powers both search surfaces, so that search behavior is consistent and logic is not duplicated.

#### Acceptance Criteria

1. THE Search_Composable SHALL expose a reactive query string, loading state, error state, and result sets for all four categories (threads, aliases, rules, templates).
2. THE Search_Composable SHALL accept a configuration option distinguishing typeahead mode (top-N per category) from full-page mode (paginated results up to 50 items per category per page).
3. WHEN the query changes, THE Search_Composable SHALL debounce the search request by 250ms.
4. IF the query length drops below 3 characters, THEN THE Search_Composable SHALL cancel any pending request, clear all category result sets, and reset loading state to false.
5. THE Search_Composable SHALL NOT issue an API call when the query is fewer than 3 characters.
6. WHEN a search request completes after a newer query has been issued, THE Stale_Query_Guard SHALL discard the stale response and retain the existing displayed results until the newer request resolves.
7. THE Search_Composable SHALL require a minimum of 3 characters before issuing a search request.
8. THE Search_Composable SHALL enforce a maximum query length of 64 characters — if the user enters more, the input SHALL be truncated to the first 64 characters automatically.

### Requirement 4: Consistent categories across surfaces

**User Story:** As a user, I want to see the same result categories in both the navbar dropdown and the search page, so that search is predictable regardless of where I start.

#### Acceptance Criteria

1. THE Navbar_Typeahead SHALL display results in four categories in fixed order: threads, aliases, rules, templates.
2. THE Search_Page SHALL display results in the same four categories in the same fixed order: threads, aliases, rules, templates.
3. WHILE in typeahead mode, THE Search_Composable SHALL limit threads to 4, aliases to 3, rules to 3, templates to 3.
4. WHILE in full-page mode, THE Search_Composable SHALL return up to 50 matching results per category.
5. IF a category contains zero matching results, THEN THE Search_Page SHALL hide that category from the displayed results.
6. IF a category contains zero matching results, THEN THE Navbar_Typeahead SHALL hide that category from the displayed results.

### Requirement 5: Sender info popup on thread/quarantine detail

**User Story:** As a user, I want to click a sender address on the thread detail or quarantine signal detail screen and see/edit that sender's configuration inline, so that I don't have to navigate away to manage sender policies.

#### Acceptance Criteria

1. ON the Thread Detail screen AND the Quarantine Signal Detail screen, THE sender address display SHALL show a pointer cursor and a hover highlight.
2. WHEN the sender address is clicked, A popup SHALL appear showing the sender configuration (policy: allow/block/report) and the alias configuration (unknownSenderPolicy) for the receiving alias.
3. THE popup SHALL allow the user to change the sender policy (allow, block_hidden, block_reject, report_violation) and save the change inline without navigating away.
4. THE popup SHALL allow the user to change the alias unknownSenderPolicy and save the change inline without navigating away.
5. WHEN a change is saved, THE popup SHALL show a brief confirmation and update the displayed state.

### Requirement 6: Direct-ID lookup on paste

**User Story:** As a user, I want to paste an entity ID into either search surface and immediately see the matching resource, so that I can quickly navigate to a specific item.

#### Acceptance Criteria

1. WHEN text is pasted into the Navbar_Typeahead, THE Search_Composable SHALL trim leading and trailing whitespace from the pasted text and attempt a Direct_ID_Lookup before executing text search.
2. WHEN text is pasted into the Search_Page input, THE Search_Composable SHALL trim leading and trailing whitespace from the pasted text and attempt a Direct_ID_Lookup before executing text search.
3. WHEN text is pasted, THE Search_Composable SHALL bypass the 250ms debounce delay and issue the Direct_ID_Lookup immediately.
4. THE Search_Composable SHALL recognize pasted text as a candidate for Direct_ID_Lookup when the trimmed value passes checksum validation for any known entity ID prefix (thr-, sgn-, rule-, tpl-, view-, acc-).
5. WHEN a Direct_ID_Lookup finds at least one matching resource, THE Search_Composable SHALL display only the direct-match results and SHALL NOT execute a text search.
6. IF a Direct_ID_Lookup finds no matching resource for a valid-format ID, THEN THE Search_Composable SHALL fall through to the normal text search.
7. IF the trimmed pasted text does not match any known ID format, THEN THE Search_Composable SHALL skip Direct_ID_Lookup and proceed with normal text search subject to the standard debounce.

### Requirement 7: Remove DynamoDB scan-and-filter for thread search

**User Story:** As a developer, I want the old scan-and-filter implementation removed, so that the system does not degrade as thread counts grow.

#### Acceptance Criteria

1. IF the `q` parameter is provided, THEN THE Thread_Search_API SHALL NOT execute a DynamoDB Query with Limit 500 followed by client-side substring filtering.
2. IF the `q` parameter is provided, THEN THE Thread_Search_API SHALL delegate to Vector_Search as the sole thread-search mechanism.
3. IF the `q` parameter is provided, THEN THE Thread_Search_API SHALL ignore the `workflow`, `label`, and `status` query parameters.
4. WHEN the `q` parameter is absent, THE Thread_Search_API SHALL list threads using the existing DynamoDB index-based query, preserving support for `workflow`, `label`, `status`, `cursor`, and `limit` parameters.
