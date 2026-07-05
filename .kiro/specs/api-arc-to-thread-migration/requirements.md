# Requirements Document

## Introduction

The frontend (`site-ui`) has fully migrated its naming from the domain term "arc" to "thread": `src/lib/api.ts` now defines `Thread`, `ThreadStatus`, `ThreadListParams`, calls `/accounts/{accountId}/threads...` routes, and reads a `{ threads: [...] }` envelope and a `threadId` field. The backend API surface has not yet fully caught up. Today the backend exposes two parallel route families — the legacy `/arcs` routes (`ArcsApi`) and the newer `/threads` routes (`ThreadsApi`) — and the `/threads` responses still emit `arc`-flavored payloads (`{ arcs: [...] }` list envelopes, an `arcId` field alongside `threadId`, and an `arc` key in the quarantine-response body).

This feature migrates the backend from "arc" terminology to "thread" terminology so that the entire codebase matches the already-migrated frontend contract. Concretely: the API must return `thread`-named payloads, must not expose `arcId` anywhere, must retire the `/arcs` route family (after confirming the `/threads` routes provide full functional parity), and must rename files, classes, variables, methods, routes, and the generated OpenAPI specification from "arc" to "thread".

The rename extends all the way down to the **database-layer code interface**: class names (for example `ArcDatabase` → `ThreadDatabase`), method names (for example `getArc` → `getThread`, `listArcs` → `listThreads`), exported types (for example `UpdateArcFields` → `UpdateThreadFields`), and in-code identifier properties (for example `arcId` → `threadId`) are all migrated to the thread term.

One set of things intentionally does NOT change, and the signals-table index layout changes in exactly one scoped way. First (unchanged), the **physical persistence key schema**: none of the DynamoDB key attributes is named `arcId` — every table (`{service}-accounts`, `{service}-signals`, `{service}-processing`, `{service}-audit`) uses generic `pk` (hash) / `sk` (range) primary keys, with GSI keys `gsi1pk`/`gsi1sk` (`gsi1`). The token "ARC" appears in physical storage only inside partition-key string *values* via the format `ACCT#{accountId}#ARC#{id}`. The persisted `arcId` attribute exists only on PRE-MIGRATION items (thread records and signal records written before this migration); new writes produce only `threadId`. The separate GKEY pointer items (`{ pk: GKEY#{accountId}#{key}, sk: "GKEY", arcId }`) are eliminated by this migration — the grouping-key lookup is served by a `gsi3pk` attribute written directly on the thread item (see Requirement 12).

Second (the scoped index change), this migration **swaps the signals-table `gsi2` index for a new `gsi3` index** — it adds `gsi3`, migrates reads onto `gsi3`, and then removes `gsi2`. The existing `gsi2` global secondary index holds only signal items, is keyed by `gsi2pk` (value format `ACCT#{accountId}#MSGID#{msgId}`, the In-Reply-To signal-threading lookup key), and uses an `INCLUDE` projection listing `arcId`. That index exists solely to serve the In-Reply-To signal-threading lookup `findSignalByEmailMessageId`, which has exactly one call site: Tier 1.5 of the three-tier arc-matching cascade in `src/processor/processor.ts` (Tier 1 = grouping key, Tier 1.5 = In-Reply-To/`gsi2`, Tier 2 = similarity). Because that lookup is best-effort and non-critical (a miss simply falls through to the next tier, and a total miss creates a new thread), the migration can fully swap the index rather than defer.

The new `gsi3` global secondary index is added to the signals DynamoDB table in the OpenTofu/Terraform template (`backend/deploy/storage.tf`), keyed on a new `gsi3pk` attribute and using projection type `ALL` (projects every attribute on the item). The `gsi3pk` attribute is written on BOTH signal items and thread items, serving two distinct access patterns via key-prefix discrimination:

- **Signal items** (In-Reply-To lookup): `gsi3pk = ACCT#{accountId}#MSGID#{msgId}` — same format as today's `gsi2pk`. Written at signal ingestion (`createSignalRecord`) and on send (`updateSignalSendStatus`). Queried by `findSignalByEmailMessageId`.
- **Thread items** (grouping-key lookup): `gsi3pk = ACCT#{accountId}#GKEY#{groupingKey}` — written when a thread has a `groupingKey`. Queried by `findThreadByGroupingKey` (replacing `fastFindArcByAlternativeLookupKey`).

With `ALL` projection, both signal and thread items are returned in full from `gsi3` — no second base-table read is needed for either access pattern. Because `gsi2` is being dropped, the migration MAY write `gsi3pk` in place of `gsi2pk` (no `gsi2pk`/`gsi3pk` lockstep dual-write is required). It migrates `findSignalByEmailMessageId` to query `gsi3` (IndexName `"gsi3"`) and resolve the owning thread directly from the returned `threadId`. It then drops the `gsi2` index (and, once nothing writes it, the now-unused `gsi2pk` attribute declaration) from the template. Because DynamoDB permits only one GSI add or delete per `UpdateTable` operation, the `gsi3` addition and read cutover SHALL be deployed before the `gsi2` removal, which may require a separate apply. Apart from adding `gsi3` and removing `gsi2` (and the `gsi2pk` attribute declaration), the infrastructure under `backend/deploy/` is otherwise untouched, because it manages real deployed resources.

The In-Reply-To lookup remains **best-effort and non-critical**. When the `gsi3` lookup returns no match (or raises an error, which is logged and treated as a miss), the arc-matching cascade falls back to the remaining tiers (grouping key, similarity) and, failing all, creates a new thread. Signals persisted before this migration carry no `gsi3pk` and are therefore not matchable via the In-Reply-To tier after the swap; this degradation is ACCEPTED as non-critical, because the other tiers still match and the index self-heals as new mail arrives. A one-off historical `gsi3pk` backfill is explicitly OUT OF SCOPE and OPTIONAL, tracked in `backend/TODO.md`.

To bridge the thread-named code and the arc-named physical storage, all "arc" awareness is confined to a single persistence boundary inside `backend/src/database/`. On WRITE, that boundary writes ONLY the `threadId` attribute on base-table thread and signal items. The persisted `arcId` attribute exists only on pre-migration rows; new writes do not produce it. On READ, the boundary resolves the identifier as `record.threadId || record.arcId` — preferring the migrated field and falling back to the persisted `arcId` for historical records written before this migration. This base-table read fallback remains mandatory because historical thread and signal items carry only the physical `arcId` attribute and no `threadId`. Records served via the `gsi3` `ALL` projection carry all attributes including `threadId` (on post-migration items) or `arcId` (on pre-migration items), so the same fallback applies. Every layer above the database module speaks only "thread".

## Glossary

- **API_Layer**: The backend HTTP surface under `backend/src/api/` (route registrations, request/response schemas, transforms) plus the OpenAPI generation script `backend/scripts/openapi.ts`. This is the surface being migrated.
- **Database_Layer**: The persistence code under `backend/src/database/` (notably `arc-database.ts` / `ArcDatabase` / `UpdateArcFields` today). Its code interface — class, method, exported type, and in-code identifier property names — is migrated to the thread term. The physical persisted data it writes is retained (see Physical_Persistence_Keys).
- **Infrastructure_Layer**: Infrastructure-as-code, primarily the OpenTofu/Terraform templates under `backend/deploy/` (notably the signals-table definition in `backend/deploy/storage.tf`). The changes permitted in this migration are BOTH (a) adding the `Gsi3_Index` and (b) removing the existing `gsi2` global secondary index (and, once nothing writes it, the now-unused `gsi2pk` attribute declaration) from the signals table (see Requirements 11 and 12); every other file, resource, and setting under `backend/deploy/` is out of scope for any change.
- **Gsi3_Index**: A new global secondary index named `gsi3`, added by this migration to the signals DynamoDB table in `backend/deploy/storage.tf`, replacing the removed `gsi2` index. It is keyed on the `Gsi3_Partition_Key` attribute and uses projection type `ALL` (projects every attribute on the item). This migration populates `gsi3` by writing `Gsi3_Partition_Key` on both signal items (for the In-Reply-To lookup) and thread items (for the grouping-key lookup) from this migration onward. The index serves two access patterns via key-prefix discrimination: signal items use `ACCT#{accountId}#MSGID#{msgId}` (queried by `findSignalByEmailMessageId`), and thread items use `ACCT#{accountId}#GKEY#{groupingKey}` (queried by `findThreadByGroupingKey`). With `ALL` projection, items are returned in full — no second base-table read is needed. A one-off backfill of historical signal items (those with no `gsi3pk`) is OPTIONAL and OUT OF SCOPE, tracked in `backend/TODO.md`.
- **Gsi3_Partition_Key**: A new signals-table attribute named `gsi3pk`, declared as a DynamoDB attribute of type `S` and used as the `Gsi3_Index` hash key. It serves two access patterns via key-prefix discrimination: (1) on signal items, value format `ACCT#{accountId}#MSGID#{msgId}` (mirrors the `gsi2pk` message-id value) for the In-Reply-To signal-threading lookup; (2) on thread items, value format `ACCT#{accountId}#GKEY#{groupingKey}` for the grouping-key thread lookup. This migration writes `gsi3pk` on signals at ingestion (`createSignalRecord`) and on send (`updateSignalSendStatus`), and on threads in `saveThread` when a `groupingKey` is present. Because `gsi2` is being dropped, the migration MAY write `gsi3pk` in place of `gsi2pk` rather than dual-writing both. Backfilling historical items (those with no `gsi3pk`) is OPTIONAL and OUT OF SCOPE, tracked in `backend/TODO.md`.
- **Processor**: The signal-processing code in `src/processor/processor.ts` that assigns each incoming signal to a thread via the Arc_Matching_Cascade.
- **Arc_Matching_Cascade**: The three-tier thread-matching logic in the Processor: Tier 1 (grouping key), Tier 1.5 (In_Reply_To_Lookup, now served by `Gsi3_Index`), and Tier 2 (similarity). Selection priority is Tier 1 > Tier 1.5 > Tier 2; when all tiers miss, the Processor creates a new thread.
- **In_Reply_To_Lookup**: The best-effort signal-threading lookup `findSignalByEmailMessageId`, the sole call site of the message-id GSI, used as Tier 1.5 of the Arc_Matching_Cascade. This migration migrates it from querying `gsi2` to querying the `Gsi3_Index` and resolving the owning thread from the returned `threadId`.
- **Thread**: The domain concept for a grouped conversation, used consistently throughout the codebase.
- **Thread_Identifier**: The identifier for a Thread, named `threadId` everywhere in code (API request paths, response bodies, application objects, and the Database_Layer code interface).
- **Physical_Persistence_Keys**: The names and formats of stored data in DynamoDB that are retained unchanged because real persisted data already uses them. NONE of these is a table or index *key* attribute — every table uses generic `pk`/`sk` primary keys and `gsi1pk`/`gsi1sk` GSI keys. The retained "arc"-flavored items are: (1) the partition-key *value* format `ACCT#{accountId}#ARC#{id}` (the "ARC" token appears inside a string value, not an attribute name); and (2) the persisted `arcId` attribute — a regular stored (non-key) attribute that exists ONLY on pre-migration items (signal records and thread records written before this migration). New writes produce only `threadId`. These are the only places the "arc" term remains in physical storage. (The former signals-table `gsi2` INCLUDE projection entry `arcId` is NOT retained, because `gsi2` is removed by this migration; the replacement `Gsi3_Index` uses `ALL` projection.)
- **Legacy_Arc_Attribute**: The historically persisted `arcId` attribute on a stored record, written before this migration (i.e. records that carry `arcId` but no `threadId`).
- **Persistence_Boundary**: The Database_Layer code that maps between thread-named application objects (using `threadId`) and the physical stored records (which retain the Physical_Persistence_Keys). On write it stores ONLY the `threadId` attribute (new writes do not produce `arcId`); on read it resolves the identifier as `record.threadId || record.arcId` — preferring `threadId` and falling back to `arcId` for pre-migration records — before returning a thread-named object to any caller outside the Database_Layer.
- **Threads_Routes**: The HTTP routes under `/accounts/{accountId}/threads...` registered by `ThreadsApi`.
- **Arcs_Routes**: The legacy HTTP routes under `/accounts/{accountId}/arcs...` registered by `ArcsApi`.
- **Signals_Routes**: The HTTP routes that are NOT nested under an arc/thread path segment — namely `/accounts/{accountId}/signals`, `/accounts/{accountId}/signals/{id}`, `/accounts/{accountId}/signals/{id}/raw`, `/accounts/{accountId}/signals/{id}/quarantineResponse`, `/accounts/{accountId}/signals/{id}/reprocess`, and the `DELETE`/`PATCH` variants — which currently live in the `ArcsApi` source file but are not arc-scoped.
- **List_Envelope**: The JSON object wrapping a paginated collection, e.g. `{ "threads": [...], "pagination": {...} }`.
- **OpenAPI_Generator**: The script `backend/scripts/openapi.ts` that instantiates the app and serializes the OpenAPI document.
- **OpenAPI_Document**: The OpenAPI specification produced by the OpenAPI_Generator, including path definitions, tags, schema (component) names, and error codes.
- **Quarantine_Response_Body**: The JSON body returned by `POST /accounts/{accountId}/signals/{id}/quarantineResponse` when a signal is approved, which references the thread the signal was placed into.

## Requirements

### Requirement 1: Thread list envelope

**User Story:** As a frontend developer, I want thread-listing endpoints to return a `threads`-keyed envelope, so that the client can consume responses using the migrated `ThreadListWire` shape without special-casing an `arcs` key.

#### Acceptance Criteria

1. WHEN a client requests `GET /accounts/{accountId}/threads`, THE API_Layer SHALL return a List_Envelope whose collection key is `threads`.
2. WHEN a client requests `GET /accounts/{accountId}/threads` with a search query parameter `q`, THE API_Layer SHALL return a List_Envelope whose collection key is `threads`.
3. THE API_Layer SHALL NOT include a key named `arcs` in any thread-listing response body.
4. WHEN a client requests `GET /accounts/{accountId}/threads`, THE API_Layer SHALL include a `pagination` object in the response body.

### Requirement 2: Thread identifiers only on the API surface

**User Story:** As an API consumer, I want every thread-related identifier to be named `threadId`, so that no legacy `arcId` field leaks into the public contract.

#### Acceptance Criteria

1. WHEN the API_Layer serializes a Thread object, THE API_Layer SHALL include a `threadId` field.
2. WHEN the API_Layer serializes a Thread object, THE API_Layer SHALL NOT include an `arcId` field.
3. WHEN the API_Layer serializes a Signal object that is associated with a Thread, THE API_Layer SHALL include a `threadId` field identifying the associated Thread.
4. IF the API_Layer serializes a Signal object that has no Thread association, THEN THE API_Layer SHALL include the `threadId` field with a `null` value.
5. WHEN the API_Layer serializes a Signal object, THE API_Layer SHALL NOT include an `arcId` field.
6. THE API_Layer SHALL NOT define any request field, response field, or path parameter named `arcId`.
7. WHERE an endpoint path identifies a single thread, THE API_Layer SHALL name the path parameter `threadId`.

### Requirement 3: Thread endpoints provide full functional parity before Arcs_Routes removal

**User Story:** As a maintainer, I want confirmation that the Threads_Routes cover every capability the Arcs_Routes provided, so that removing the Arcs_Routes does not drop any functionality clients depend on.

#### Acceptance Criteria

1. THE Threads_Routes SHALL expose an operation to list threads for an account, equivalent to the legacy `GET /accounts/{accountId}/arcs`.
2. THE Threads_Routes SHALL expose an operation to retrieve a single thread, equivalent to the legacy `GET /accounts/{accountId}/arcs/{id}`.
3. THE Threads_Routes SHALL expose an operation to update a single thread, equivalent to the legacy `PATCH /accounts/{accountId}/arcs/{id}`.
4. THE Threads_Routes SHALL expose an operation to list signals for a thread, equivalent to the legacy `GET /accounts/{accountId}/arcs/{arcId}/signals`.
5. THE Threads_Routes SHALL expose an operation to create a draft signal on a thread, equivalent to the legacy `POST /accounts/{accountId}/arcs/{arcId}/signals`.
6. THE Threads_Routes SHALL expose an operation to replace a draft signal on a thread, equivalent to the legacy `PUT /accounts/{accountId}/arcs/{arcId}/signals/{id}`.
7. THE Threads_Routes SHALL expose an operation to send a draft signal on a thread, equivalent to the legacy `POST /accounts/{accountId}/arcs/{arcId}/signals/{id}/send`.
8. THE Threads_Routes SHALL expose an operation to unsubscribe a thread, equivalent to the legacy `POST /accounts/{accountId}/arcs/{arcId}/unsubscribe`.
9. THE Threads_Routes SHALL expose an operation to RSVP to a calendar signal on a thread, equivalent to the legacy `POST /accounts/{accountId}/arcs/{arcId}/signals/{id}/rsvp`.
10. IF any capability enumerated in criteria 1 through 9 lacks a Threads_Routes equivalent, THEN THE migration SHALL add the missing Threads_Routes operation before any Arcs_Routes are removed.

### Requirement 4: Removal of the Arcs_Routes

**User Story:** As an API consumer, I want the legacy arc-prefixed routes gone, so that there is a single canonical route family and no ambiguity about which endpoints to use.

#### Acceptance Criteria

1. WHEN the migration is complete, THE API_Layer SHALL NOT register any route whose path contains the segment `arcs`.
2. WHEN a client requests any path under `/accounts/{accountId}/arcs`, THE API_Layer SHALL respond with HTTP status 404.
3. THE OpenAPI_Document SHALL NOT contain any path beginning with `/accounts/{accountId}/arcs`.

### Requirement 5: Preservation of the Signals_Routes

**User Story:** As an API consumer, I want the account-level signal endpoints to keep working, so that quarantine review, signal retrieval, raw-email access, reprocessing, and signal deletion remain available after the Arcs_Routes are removed.

#### Acceptance Criteria

1. THE API_Layer SHALL continue to expose `GET /accounts/{accountId}/signals`.
2. THE API_Layer SHALL continue to expose `GET /accounts/{accountId}/signals/{id}`.
3. THE API_Layer SHALL continue to expose `GET /accounts/{accountId}/signals/{id}/raw`.
4. THE API_Layer SHALL continue to expose `PATCH /accounts/{accountId}/signals/{id}`.
5. THE API_Layer SHALL continue to expose `DELETE /accounts/{accountId}/signals/{id}`.
6. THE API_Layer SHALL continue to expose `POST /accounts/{accountId}/signals/{id}/quarantineResponse`.
7. THE API_Layer SHALL continue to expose `POST /accounts/{accountId}/signals/{id}/reprocess`.
8. WHEN the Arcs_Routes source file is removed or renamed, THE migration SHALL relocate the Signals_Routes to a retained API_Layer module so that criteria 1 through 7 remain satisfied.

### Requirement 6: Quarantine-response body uses thread terminology

**User Story:** As a frontend developer, I want the quarantine-approval response to reference a `thread`, so that the client can read `thread.threadId` as defined in the migrated contract.

#### Acceptance Criteria

1. WHEN `POST /accounts/{accountId}/signals/{id}/quarantineResponse` approves a signal into a thread, THE API_Layer SHALL return a Quarantine_Response_Body containing a `thread` object.
2. WHEN the API_Layer returns a Quarantine_Response_Body, THE `thread` object SHALL include a `threadId` field.
3. WHEN the API_Layer returns a Quarantine_Response_Body, THE API_Layer SHALL NOT include a key named `arc` in that body, regardless of any other fields present in the body.

### Requirement 7: Rename of API-layer identifiers, files, and routes

**User Story:** As a maintainer, I want API-layer files, classes, variables, and route definitions renamed from "arc" to "thread", so that the codebase consistently reflects the thread domain term on the API side.

#### Acceptance Criteria

1. THE API_Layer SHALL provide a route-registration class named for threads (for example `ThreadsApi`) as the single owner of thread routes.
2. THE API_Layer SHALL NOT retain a route-registration class named `ArcsApi`.
3. WHERE an API_Layer request or response schema represents a Thread, THE API_Layer SHALL name that schema using the thread term (for example `Thread`, `ThreadStatus`, `ThreadUrgency`, `ListThreadsResponse`, `UpdateThreadRequest`).
4. WHERE an API_Layer transform produces a Thread payload, THE API_Layer SHALL name that transform using the thread term (for example `toApiThread`).
5. THE API_Layer SHALL name API-facing route tags using the thread term rather than the `Arcs` tag.
6. THE API_Layer SHALL name error codes that refer to a missing or mismatched thread using the thread term (for example `THREAD_NOT_FOUND` and `SIGNAL_THREAD_MISMATCH`) rather than `ARC_NOT_FOUND` or `SIGNAL_ARC_MISMATCH`.

### Requirement 8: OpenAPI specification migration

**User Story:** As an API consumer, I want the generated OpenAPI specification to use thread terminology, so that generated clients and documentation reflect the thread contract.

#### Acceptance Criteria

1. WHEN the OpenAPI_Generator produces the OpenAPI_Document, THE OpenAPI_Document SHALL expose thread paths under `/accounts/{accountId}/threads`.
2. THE OpenAPI_Document SHALL NOT contain a component schema named `Arc`.
3. THE OpenAPI_Document SHALL NOT contain a tag named `Arcs`.
4. THE OpenAPI_Document SHALL NOT contain the identifier `arcId` in any path parameter, schema property, or request body.
5. WHEN the OpenAPI_Generator is executed, THE OpenAPI_Generator SHALL complete successfully and serialize a valid OpenAPI_Document.

### Requirement 9: Persistence boundary bridges thread code and arc-named physical storage

**User Story:** As a maintainer, I want the database module to write only `threadId` on new records while resolving reads with a fallback to `arcId`, so that the code speaks "thread" everywhere, new writes are clean, and historical records stay readable.

#### Acceptance Criteria

1. WHEN the Database_Layer writes a thread or signal record, THE Persistence_Boundary SHALL store the identifier under a `threadId` attribute.
2. WHEN the Database_Layer writes a thread or signal record, THE Persistence_Boundary SHALL NOT write an `arcId` attribute. The `arcId` attribute exists only on pre-migration rows.
3. WHEN the Database_Layer writes a thread or signal record, THE Persistence_Boundary SHALL use the existing partition-key value format `ACCT#{accountId}#ARC#{id}`.
4. WHEN the Persistence_Boundary writes the `threadId` attribute, THE Persistence_Boundary SHALL NOT alter any `pk`, `sk`, `gsi1pk`, or `gsi1sk` key attribute, because `threadId` is a non-key attribute.
5. WHEN the Database_Layer performs any read, get, or query that returns a stored record and maps it to an application object, THE Persistence_Boundary SHALL resolve the identifier as `record.threadId ?? record.arcId`, preferring `threadId` and falling back to the Legacy_Arc_Attribute, and SHALL apply this resolution universally on every read/get/query path in the Database_Layer.
6. WHERE a record returned by any read, get, or query has no `threadId` property, THE Persistence_Boundary SHALL read the identifier from the `arcId` property.
7. WHEN the Database_Layer reads a record served via `gsi3`, THE Persistence_Boundary SHALL apply the same `record.threadId ?? record.arcId` fallback, because `gsi3` uses `ALL` projection and returns whatever attributes the item carries.
8. WHEN the Database_Layer reads a record written before this migration that carries only a Legacy_Arc_Attribute, THE Persistence_Boundary SHALL resolve the identifier from `record.arcId`.
9. WHEN the Persistence_Boundary returns an object to a caller outside the Database_Layer, THE Persistence_Boundary SHALL populate that object's `threadId` field.
10. THE threadId-only write applies to ALL write sites: `saveSignal`, `saveThread`, `unblockSignal`, `updateThread`, and `updateSignalSendStatus`.

### Requirement 10: Database code interface migrated to thread; physical persistence retained

**User Story:** As a maintainer, I want the database module's code interface renamed to "thread" while its persisted data shape is retained, so that the whole codebase uses one term without risking a data migration or breaking existing records.

#### Acceptance Criteria

1. THE Database_Layer SHALL provide a database class named using the thread term (for example `ThreadDatabase`) rather than `ArcDatabase`.
2. THE Database_Layer SHALL name its methods using the thread term (for example `getThread`, `listThreads`, `updateThread`, `createThread`, `searchThreads`) rather than the arc term.
3. THE Database_Layer SHALL name its exported types using the thread term (for example `UpdateThreadFields`) rather than the arc term.
4. WHERE Database_Layer code references an in-code identifier property for a thread, THE Database_Layer SHALL name that property `threadId` rather than `arcId`.
5. WHERE a Database_Layer source file name uses the arc term (for example `arc-database.ts`), THE migration SHALL rename that file using the thread term.
6. THE Database_Layer SHALL retain the Physical_Persistence_Keys, including the `ACCT#{accountId}#ARC#{id}` partition-key value format, the generic key attributes (`pk`, `sk`, `gsi1pk`, `gsi1sk`), and the `gsi1` index name. The persisted `arcId` attribute exists only on pre-migration rows; new writes produce `threadId` only.
7. WHEN the Database_Layer writes a record, THE Database_Layer SHALL store the identifier under `threadId` only (not `arcId`), per Requirement 9.
8. WHEN the Database_Layer reads a record that was persisted before the migration with only a Legacy_Arc_Attribute, THE Database_Layer SHALL return that record successfully via the read fallback defined in Requirement 9.
9. WHERE the "arc" term appears in the codebase after the migration, THE migration SHALL confine that term to the Persistence_Boundary within `backend/src/database/`.
10. THE code outside `backend/src/database/` SHALL reference the entity using only the thread term.

### Requirement 11: Infrastructure changes are limited to swapping `gsi2` for `gsi3`

**User Story:** As a maintainer, I want infrastructure-as-code limited to the scoped swap of `gsi2` for `gsi3` (adding `gsi3` and removing `gsi2`), so that the migration cannot alter any other deployed resource.

#### Acceptance Criteria

1. THE Infrastructure_Layer changes THE migration SHALL make are limited to BOTH: (a) adding the `Gsi3_Index` (with its `gsi3pk` attribute of type `S` and projection type `ALL`) to the signals table, and (b) removing the existing `gsi2` global secondary index and, once nothing writes it, the now-unused `gsi2pk` attribute declaration from the signals table, as specified in Requirement 12.
2. Apart from adding the `Gsi3_Index` and removing the `gsi2` index (and the `gsi2pk` attribute declaration), THE migration SHALL NOT otherwise modify any file under `backend/deploy/` or any other Terraform/OpenTofu configuration.
3. THE migration SHALL NOT modify the key schema of the `{service}-accounts`, `{service}-signals`, `{service}-processing`, or `{service}-audit` tables, which each use `pk` (hash) and `sk` (range).
4. THE migration SHALL NOT modify the `gsi1` global secondary index definition (keys `gsi1pk`/`gsi1sk`, projection `ALL`) on any table.
5. THE migration SHALL NOT modify the DynamoDB table settings, including the `ttl` attribute, point-in-time recovery, deletion protection, DynamoDB streams, and the `eu-central-2` replica.
6. Because DynamoDB permits only one global-secondary-index add or delete per `UpdateTable` operation, THE migration SHALL deploy the `gsi3` addition and the In-Reply-To read cutover onto `gsi3` before removing the `gsi2` index, which MAY require a separate apply.
7. WHEN the `gsi2` index is removed, THE migration SHALL have already cut the In_Reply_To_Lookup over onto the `Gsi3_Index`, so that no read depends on `gsi2` at the time of its removal.

### Requirement 12: Swap `gsi2` for `gsi3` — create, populate, read, and drop

**User Story:** As a maintainer, I want the migration to add a new `gsi3` global secondary index with `ALL` projection, populate it by writing `gsi3pk` on both signal items and thread items, migrate the In-Reply-To and grouping-key reads onto `gsi3`, and drop `gsi2`, so that both lookups are served by a single index that returns full items and no legacy `arcId`-projecting index remains.

#### Acceptance Criteria

1. THE migration SHALL add a new `gsi3` global secondary index to the signals DynamoDB table in the OpenTofu template `backend/deploy/storage.tf`.
2. THE migration SHALL declare a new signals-table attribute named `gsi3pk` of DynamoDB type `S` and use `gsi3pk` as the `gsi3` hash key.
3. THE `gsi3` index SHALL use projection type `ALL` (projects every attribute on the item).
4. WHEN a signal is created at ingestion (`createSignalRecord` / signal creation in `src/processor/processor.ts`), THE migration SHALL write the `gsi3pk` attribute onto the signal item with the value format `ACCT#{accountId}#MSGID#{msgId}`.
5. WHEN a signal is sent (`updateSignalSendStatus`), THE migration SHALL write the `gsi3pk` attribute onto the signal item with the value format `ACCT#{accountId}#MSGID#{msgId}`.
6. WHEN a thread is saved (`saveThread`) and the thread has a `groupingKey`, THE migration SHALL write the `gsi3pk` attribute onto the thread item with the value format `ACCT#{accountId}#GKEY#{groupingKey}`.
7. WHERE the `gsi2pk` attribute was written before this migration, THE migration MAY stop writing `gsi2pk` and write `gsi3pk` in its place, because `gsi2` is being dropped and no `gsi2pk`/`gsi3pk` lockstep dual-write is required.
8. WHEN the Persistence_Boundary writes the `gsi3pk` attribute, THE Persistence_Boundary SHALL NOT alter any `pk`, `sk`, `gsi1pk`, or `gsi1sk` key attribute, because `gsi3pk` is a non-key attribute.
9. THE migration SHALL migrate the In_Reply_To_Lookup (`findSignalByEmailMessageId`) to query the `gsi3` index (IndexName `"gsi3"`) with `gsi3pk = ACCT#{accountId}#MSGID#{msgId}` and SHALL resolve the owning thread identifier from the returned `threadId`.
10. THE migration SHALL provide a `findThreadByGroupingKey` query (replacing `fastFindArcByAlternativeLookupKey`) that queries `gsi3` with `gsi3pk = ACCT#{accountId}#GKEY#{groupingKey}` and returns the thread item in full (no second base-table read needed, because `ALL` projection returns every attribute).
11. THE migration SHALL eliminate the separate GKEY pointer items (`{ pk: GKEY#{accountId}#{key}, sk: "GKEY", arcId }`). `saveThread` SHALL stop writing the GKEY pointer item; instead it writes `gsi3pk` directly on the thread item per criterion 6.
12. Historical GKEY pointer items SHALL remain in the table until their TTL expires or they are cleaned up. No code reads them after this migration; they are harmless dead rows.
13. THE migration SHALL drop the `gsi2` global secondary index from the OpenTofu template `backend/deploy/storage.tf`.
14. THE migration SHALL deploy the `gsi3` addition and the read cutover before removing the `gsi2` index, per the deploy-sequencing constraint in Requirement 11.
15. THE migration SHALL record the optional one-off backfill of `gsi3pk` onto historical signal items (those written before this migration with no `gsi3pk`) as OUT OF SCOPE in `backend/TODO.md`.

### Requirement 13: Test suite reflects the migrated surface

**User Story:** As a maintainer, I want the API test suite updated to exercise the thread surface, so that the migrated contract is verified and the build stays green.

#### Acceptance Criteria

1. THE API test suite SHALL exercise the Threads_Routes rather than the removed Arcs_Routes.
2. THE API test suite SHALL assert that thread-listing responses use the `threads` List_Envelope key.
3. THE API test suite SHALL assert that serialized Thread and Signal payloads contain `threadId` and do not contain `arcId`.
4. WHEN the test suite is executed after the migration, THE test suite SHALL pass.

### Requirement 14: In-Reply-To lookup is best-effort; historical degradation accepted

**User Story:** As a maintainer, I want the In-Reply-To lookup to stay best-effort after moving onto `gsi3`, and the loss of In-Reply-To matching for pre-migration signals to be an explicitly accepted, non-critical tradeoff, so that swapping the index cannot cause a critical failure and the accepted degradation is documented.

#### Acceptance Criteria

1. THE Arc_Matching_Cascade SHALL select a thread match by priority Tier 1 (grouping key) > Tier 1.5 (In_Reply_To_Lookup via `gsi3`) > Tier 2 (similarity).
2. WHEN the In_Reply_To_Lookup (`findSignalByEmailMessageId` querying `gsi3`) returns no match, THE Arc_Matching_Cascade SHALL fall back to the remaining tiers (grouping key, similarity).
3. IF every tier of the Arc_Matching_Cascade fails to match, THEN THE Processor SHALL create a new thread rather than raising a critical failure.
4. IF the In_Reply_To_Lookup raises an error while querying `gsi3`, THEN THE Processor SHALL log the error, treat it as a lookup miss, and continue the Arc_Matching_Cascade.
5. WHERE a signal was persisted before this migration and carries no `gsi3pk`, THE In_Reply_To_Lookup SHALL NOT match that signal, and this degradation is ACCEPTED as non-critical because the remaining tiers still match and `gsi3` self-heals as new mail arrives.
6. THE migration SHALL record the optional one-off historical `gsi3pk` backfill as OUT OF SCOPE in `backend/TODO.md`.

### Requirement 15: No error code contains "ARC" substring

**User Story:** As a maintainer, I want a catch-all validation that no error code in the API layer contains the substring `ARC`, so that no unmigrated arc-flavored codes slip through beyond the two specifically named renames.

#### Acceptance Criteria

1. THE API_Layer error code enum SHALL NOT contain any value that includes the substring `ARC` (case-sensitive) anywhere in the string — prefix, infix, or suffix.
2. THE migration SHALL rename `ARC_NOT_FOUND` to a thread-named equivalent (for example `THREAD_NOT_FOUND`).
3. THE migration SHALL rename `SIGNAL_ARC_MISMATCH` to a thread-named equivalent (for example `SIGNAL_THREAD_MISMATCH`).
4. THE migration SHALL verify by test that no error code value in the enum contains the substring `ARC`.
