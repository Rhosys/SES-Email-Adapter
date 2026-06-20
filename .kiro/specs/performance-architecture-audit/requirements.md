# Requirements Document

## Introduction

A comprehensive performance and architectural audit of the email-catcher backend application. The system was designed for a handful of users and now serves hundreds of thousands. This audit identifies scale bottlenecks, race conditions, edge cases, logic bugs, cost inefficiencies, naming/semantic issues, access pattern violations, convention coupling, API surface problems, and defines formal correctness properties that must hold at any scale.

## Glossary

- **Processor**: The `SignalProcessor` class that handles inbound email signals — parses MIME, classifies workflow, matches/creates arcs, evaluates rules, and dispatches side-effects.
- **Arc**: A materialized aggregate of related signals (emails), grouped by sender domain + workflow + recipient address. Stored in DynamoDB with a GSI for listing.
- **Signal**: An immutable inbound event (email) stored in DynamoDB. Each signal belongs to exactly one arc (or is pre-arc while quarantined/blocked).
- **Grouping_Key**: A deterministic lookup key derived from `(workflow, workflowData, recipientAddress, senderETLD1)` used to match inbound signals to existing arcs without vector search.
- **Arc_Matcher**: The pgvector-based similarity search in Aurora Serverless that finds the best-matching arc for a signal when no grouping key match exists.
- **Side_Effect**: Post-processing actions (forward, notify, pong, auto-draft) dispatched via SQS after the primary signal/arc write succeeds.
- **DynamoDB_Single_Table**: The `SIGNALS_TABLE` that stores arcs, signals, and grouping key pointers in a single-table design with composite keys.
- **Aurora_Data_API**: The RDS Data API used for pgvector similarity search and multi-cluster embedding writes.
- **SQS_Signal_Queue**: The queue that receives inbound email notifications from SES (via SNS) and internal messages (reindex, side-effect, draft-send).
- **Hot_Partition**: A DynamoDB partition that receives disproportionate read/write traffic, causing throttling for items sharing that partition key prefix.
- **Conditional_Write**: A DynamoDB write operation that includes a condition expression, failing if the condition is not met — used for optimistic concurrency control.
- **Access_Pattern_Violation**: A code path that reads or writes a DynamoDB table directly instead of routing through the designated XDatabase class that owns that table.
- **Convention_Coupling**: A design where two or more code locations must be changed in coordination to maintain correctness, with no compile-time or runtime enforcement of that coupling.
- **Pit_of_Failure**: An architectural pattern where the default or easy path leads to bugs, as opposed to a pit of success where the easy path is correct.

## Requirements

### Requirement 1: Scale Bottleneck Identification

**User Story:** As a platform operator, I want to identify all architectural components that will degrade or fail at hundreds of thousands of concurrent users, so that I can prioritize remediation before incidents occur.

#### Acceptance Criteria

1. WHEN the audit examines DynamoDB access patterns, THE Audit SHALL identify all queries that perform client-side filtering after fetching (scan-and-filter anti-pattern) and quantify the read cost at 100K+ accounts.
2. WHEN the audit examines the `listArcs` method, THE Audit SHALL flag the parallel three-status query pattern (`active`, `archived`, `deleted`) that fetches up to `3 × (limit + 1)` items and sorts in-memory as a scale risk.
3. WHEN the audit examines the `searchArcs` method, THE Audit SHALL flag the 500-item fetch with client-side string matching as a pattern that degrades linearly with arc count per account.
4. WHEN the audit examines Aurora Data API usage, THE Audit SHALL identify the per-request transaction overhead (BEGIN + SET LOCAL + query + COMMIT) and quantify connection pool exhaustion risk at high concurrency.
5. WHEN the audit examines the `listAccounts` endpoint, THE Audit SHALL flag the sequential N+1 DynamoDB GetItem calls (one per account) as a pattern that degrades linearly with account count per user.
6. WHEN the audit examines Lambda concurrency, THE Audit SHALL identify the single-Lambda-handles-all-event-types design (API Gateway + SQS + EventBridge + WebSocket + Step Functions) and assess cold start impact at scale.
7. WHEN the audit examines SQS processing, THE Audit SHALL identify the sequential `for...of` loop over SQS batch records as a throughput bottleneck compared to parallel processing.
8. WHEN the audit examines the embedding generation pipeline, THE Audit SHALL identify Bedrock API rate limits as a throughput ceiling and quantify the impact of serial embedding generation per signal.
9. WHEN the audit examines the `scanAllDomains` method, THE Audit SHALL flag the full-table DynamoDB Scan with client-side filtering as a pattern that becomes prohibitively expensive at scale.
10. WHEN the audit examines the `listPreArcSignals` endpoint, THE Audit SHALL identify that client-side filtering by `quarantine_visible` vs `quarantine_hidden` after fetching all quarantined signals wastes read capacity.

### Requirement 2: Race Condition Identification

**User Story:** As a platform operator, I want to identify all race conditions that can occur when multiple Lambda invocations process signals concurrently, so that I can prevent data corruption and lost updates.

#### Acceptance Criteria

1. WHEN the audit examines arc creation, THE Audit SHALL identify the race condition where two concurrent signals with the same grouping key both fail `fastFindArcByAlternativeLookupKey`, both create new arcs, and produce duplicate arcs for the same logical conversation.
2. WHEN the audit examines the grouping key pointer write, THE Audit SHALL identify that `saveArc` writes the arc item and the GKEY pointer item in parallel without a transaction, allowing a crash between writes to leave an orphaned pointer or a pointer-less arc.
3. WHEN the audit examines arc update during signal processing, THE Audit SHALL identify that `updateArc` uses no conditional expression, allowing a concurrent signal to overwrite another signal's arc update (last-writer-wins on `lastSignalAt`, `summary`, `labels`).
4. WHEN the audit examines the retry path in `processRecord`, THE Audit SHALL identify that the "signal exists in DDB" check followed by "arc guaranteed to exist" assumption can fail if the arc was deleted between signal write and retry.
5. WHEN the audit examines side-effect dispatch, THE Audit SHALL identify that SQS message delivery is at-least-once, meaning side-effects (forward, notify, pong) can execute multiple times without idempotency guards.
6. WHEN the audit examines WebSocket connection management, THE Audit SHALL identify the race between `$disconnect` handler deleting the device record and a concurrent notification attempting to deliver to that connection.
7. WHEN the audit examines the quarantine-to-active flow (`quarantineResponse`), THE Audit SHALL identify that the arc creation + signal unblock sequence is not atomic, allowing a concurrent signal to match the newly-created arc before the quarantined signal is moved to it.
8. WHEN the audit examines the `renameAlias` method, THE Audit SHALL identify that the multi-step sequence (read old → create new → copy senders → delete old → delete old senders) is not atomic and can leave partial state on failure at any step.

### Requirement 3: Edge Case Identification

**User Story:** As a platform operator, I want to identify edge cases that are invisible at low scale but surface as bugs or failures at hundreds of thousands of users, so that I can harden the system proactively.

#### Acceptance Criteria

1. WHEN the audit examines email parsing, THE Audit SHALL identify edge cases in MIME handling: emails exceeding S3 object size limits, attachments with zero-length filenames, nested MIME parts exceeding recursion depth, and RFC-2047 encoded headers with invalid charset declarations.
2. WHEN the audit examines the classifier, THE Audit SHALL identify edge cases where Bedrock returns malformed JSON, times out, or returns a workflow not in the WORKFLOWS array, and verify that all code paths handle these gracefully.
3. WHEN the audit examines DynamoDB item sizes, THE Audit SHALL identify signals where `data.htmlBody` or `data.textBody` combined with `data.embeddings` can exceed the 400KB DynamoDB item size limit.
4. WHEN the audit examines the GSI sort key `LASTACT#{status}#{lastSignalAt}#{id}`, THE Audit SHALL identify that ISO-8601 timestamps with varying timezone offsets or sub-second precision can produce incorrect sort order.
5. WHEN the audit examines account ID generation, THE Audit SHALL identify the collision probability at 100K+ accounts and verify the retry loop (5 attempts) is sufficient.
6. WHEN the audit examines the SQS retry threshold (30 receives), THE Audit SHALL identify scenarios where legitimate processing repeatedly fails (e.g., Bedrock outage) and messages cycle indefinitely without reaching the DLQ.
7. WHEN the audit examines the `deriveGroupingKey` function, THE Audit SHALL identify edge cases where workflow data fields used in the key contain special characters, empty strings, or undefined values that produce key collisions across unrelated conversations.
8. WHEN the audit examines cursor-based pagination, THE Audit SHALL identify that DynamoDB `LastEvaluatedKey` cursors become invalid if items are inserted or deleted between pages, potentially causing skipped or duplicated results.
9. WHEN the audit examines the `base64url` cursor encoding, THE Audit SHALL identify that cursors expose internal DynamoDB key structure to clients, enabling crafted cursors that could access other accounts' data if partition key validation is missing.
10. WHEN the audit examines the `reindexWorker` parallel scan, THE Audit SHALL identify that segment boundaries are non-deterministic and items can be missed or double-processed if the table is actively written during a scan.

### Requirement 4: Conflicting State and Logic Bug Identification

**User Story:** As a platform operator, I want to identify all code paths that can leave the system in an inconsistent state, so that I can add guards or reconciliation mechanisms.

#### Acceptance Criteria

1. WHEN the audit examines the arc state machine, THE Audit SHALL identify all valid and invalid state transitions (active → archived → deleted, active → deleted, etc.) and verify that `updateArc` enforces valid transitions rather than accepting any status value.
2. WHEN the audit examines signal status transitions, THE Audit SHALL identify that `updateSignalStatus` accepts any target status without validating the current status, allowing transitions like `sent → block_hidden` that are semantically invalid.
3. WHEN the audit examines the dual-write pattern (DynamoDB signal + Aurora embedding + S3 retention tag), THE Audit SHALL identify all failure modes where one write succeeds and another fails, leaving the system in a partially-committed state.
4. WHEN the audit examines the `report_violation` flow, THE Audit SHALL identify that the arc is updated to `deleted` status but the sender block is written to a different alias address than the one that received the signal, if the arc contains signals from multiple recipient addresses.
5. WHEN the audit examines rule evaluation order, THE Audit SHALL identify that the "first-rule-wins" semantics for status-changing actions depend on `priorityOrder` being unique and contiguous, and verify what happens when two rules share the same priority.
6. WHEN the audit examines the `assign_workflow` action within rule evaluation, THE Audit SHALL identify that mutating `context.arc.workflow` during iteration affects subsequent rule evaluations in the same batch, creating order-dependent behavior that is invisible to the user.
7. WHEN the audit examines the feedback processor (bounce/complaint handling), THE Audit SHALL identify scenarios where a bounce notification arrives before the original signal is fully processed, causing the lookup by `sesMessageId` to fail and the bounce to be lost.
8. WHEN the audit examines the `annotateTemplateError` method, THE Audit SHALL identify that it hardcodes `functions[0].lastError` which only annotates the first function regardless of which function actually failed.
9. WHEN the audit examines the stats writer, THE Audit SHALL identify that stats updates are fire-and-forget with no reconciliation mechanism, meaning stats can drift from actual signal counts permanently after any transient failure.

### Requirement 5: Cost Optimization Identification

**User Story:** As a platform operator, I want to identify areas where the current design wastes money at scale, so that I can reduce operational costs without sacrificing reliability.

#### Acceptance Criteria

1. WHEN the audit examines the processor pipeline, THE Audit SHALL identify that every inbound signal triggers a Bedrock embedding generation call regardless of whether the signal will be blocked or quarantined, wasting embedding compute on signals that never reach an arc.
2. WHEN the audit examines DynamoDB read patterns, THE Audit SHALL identify all GetItem calls that fetch full items when only a subset of attributes is needed (missing ProjectionExpression), and quantify the excess RCU cost.
3. WHEN the audit examines the Aurora Data API transaction pattern, THE Audit SHALL quantify the cost of 4 API calls per similarity search (BEGIN + SET LOCAL + query + COMMIT) versus a single call with a session-level parameter.
4. WHEN the audit examines S3 operations, THE Audit SHALL identify that presigned URL generation happens synchronously during signal processing even when the URL may never be used (e.g., blocked signals), adding latency without value.
5. WHEN the audit examines the `listArcs` no-status-filter path, THE Audit SHALL quantify the cost of three parallel DynamoDB queries (one per status) when most users only view active arcs, and identify that the unused status results are discarded after merge-sort.
6. WHEN the audit examines Lambda memory/timeout configuration, THE Audit SHALL identify whether the single Lambda's memory allocation is optimized for the heaviest workload (embedding generation) at the expense of lightweight workloads (API responses), and quantify the cost of over-provisioning.
7. WHEN the audit examines the notification pipeline, THE Audit SHALL identify that `DeviceNotifier` queries all devices for an account on every signal, even when the signal's urgency is `silent` and no notification will be sent.
8. WHEN the audit examines the `getProcessorAccountContext` method, THE Audit SHALL identify that it performs 3 sequential DynamoDB calls (getAccount + getAlias + listDomains) on every signal, when a single BatchGetItem or cached result would suffice for repeated signals to the same account.

### Requirement 6: Naming and Semantic Clarity

**User Story:** As a developer maintaining this codebase, I want function and class names to accurately describe their behavior and responsibility, so that I can understand the system without reading every implementation.

#### Acceptance Criteria

1. WHEN the audit examines class naming, THE Audit SHALL identify `ProcessingDatabase` as misleadingly named — it handles suppression lists and global sender reputation, not "processing" in the signal-processing sense.
2. WHEN the audit examines method naming, THE Audit SHALL identify `fastFindArcByAlternativeLookupKey` as a name that obscures its purpose — it performs a grouping key lookup via a pointer item, not a "fast find" or "alternative" lookup.
3. WHEN the audit examines method naming, THE Audit SHALL identify `getProcessorAccountContext` as a method that bundles unrelated concerns (retention, filtering, alias config, domains, billing plan) into a single grab-bag return type rather than letting callers request what they need.
4. WHEN the audit examines method naming, THE Audit SHALL identify `saveArc` vs `createArc` as semantically identical methods (createArc delegates to saveArc) that create confusion about when to use which.
5. WHEN the audit examines the `ExternalEmailSignalHandler` class, THE Audit SHALL identify that it handles both forwarding and reply-sending — two distinct responsibilities conflated under a name that suggests only one.
6. WHEN the audit examines the `DynamoDeviceStore` class, THE Audit SHALL identify that it lives in `notifier/` but directly accesses `ACCOUNTS_TABLE`, making its table ownership ambiguous — is it part of the account domain or the notification domain?
7. WHEN the audit examines the `SignalProcessor` class, THE Audit SHALL identify that it is a 1400+ line god class that handles parsing, classification, arc matching, rule evaluation, side-effect dispatch, retention, and Aurora writes — violating single-responsibility.
8. WHEN the audit examines the `SqsDispatcher` interface name, THE Audit SHALL identify that it dispatches side-effect messages specifically, not arbitrary SQS messages — the name is too generic for its actual responsibility.
9. WHEN the audit examines the `multiClusterWriter` singleton, THE Audit SHALL identify that the name implies multi-region writes but the implementation uses a single-region client cache keyed by registry ID — the "multi-cluster" concept is aspirational, not actual.
10. WHEN the audit examines the `SYSTEM_RULES` constant, THE Audit SHALL identify that system rules are defined as code constants but evaluated as if they were user rules, creating a confusing hybrid where "system" rules can be "disabled" by users but never deleted.

### Requirement 7: Database Access Pattern Violations

**User Story:** As a developer, I want all database access to flow through designated XDatabase classes so that access patterns are centralized, auditable, and cannot silently diverge.

#### Acceptance Criteria

1. WHEN the audit examines the `DynamoDeviceStore` class, THE Audit SHALL identify that it directly imports `dynamo` and `ACCOUNTS_TABLE` from `database/shared.ts` and performs reads/writes to the accounts table outside of `AccountDatabase`, creating a parallel access path that bypasses any future middleware, caching, or access control added to `AccountDatabase`.
2. WHEN the audit examines the `ReindexWorker` class, THE Audit SHALL identify that it directly imports `dynamo` and `SIGNALS_TABLE` from `database/shared.ts` and performs a full-table Scan outside of `ArcDatabase`, bypassing the designated owner of that table.
3. WHEN the audit examines the `database/shared.ts` module, THE Audit SHALL identify that it exports raw `dynamo` client and table name constants publicly, making it trivially easy for any module to bypass the XDatabase classes — the pit of failure is that the easy path (import shared, write directly) is the wrong path.
4. WHEN the audit examines the `FeedbackProcessor` class, THE Audit SHALL identify that it receives a `FeedbackSignalStore` interface that mirrors a subset of `ArcDatabase` methods — this is a correct pattern but creates a maintenance burden where interface changes must be synchronized manually.
5. WHEN the audit examines the `handler.ts` wiring, THE Audit SHALL identify that the `feedbackProcessor` is constructed with inline lambdas that delegate to `arcDb` methods, creating an indirection layer that obscures which database class actually owns the operation.
6. WHEN the audit examines the `multiClusterWriter` singleton, THE Audit SHALL identify that it duplicates the Aurora Data API transaction pattern from `ArcDatabase.findMatch` and `ArcDatabase.upsertEmbedding`, creating two independent implementations of the same RLS-scoped transaction logic that must be kept in sync.
7. WHEN the audit examines the `processor.ts` file, THE Audit SHALL identify all places where it calls `arcDb` methods that could be replaced by a higher-level domain operation, revealing that the processor knows too much about the database schema (e.g., constructing GSI keys, knowing about signalLookupId format).

### Requirement 8: Convention Coupling and Coordination Requirements

**User Story:** As a developer, I want to identify all places where two or more code locations must be changed in coordination without compile-time enforcement, so that I can add structural guards or consolidate the representations.

#### Acceptance Criteria

1. WHEN the audit examines the GSI sort key construction, THE Audit SHALL identify that the format `LASTACT#{status}#{lastSignalAt}#{id}` is constructed in `saveArc`, `updateArc`, and potentially in query filters — any format change requires coordinated updates across all locations with no type-level enforcement.
2. WHEN the audit examines the `WORKFLOWS` array, THE Audit SHALL identify all locations that must be updated when a workflow is added or removed: the array itself, the `WorkflowData` union type, the classifier prompt, the system rules, the `deriveGroupingKey` function, and the `assignSystemLabels` function — with no compile-time check that all are in sync.
3. WHEN the audit examines the `SQS_MESSAGE_TYPES` array, THE Audit SHALL identify that the handler's destructuring `[MSG_TYPE_REINDEX, MSG_TYPE_SIDE_EFFECT, MSG_TYPE_DRAFT_SEND]` depends on array order matching the constant definition — reordering the array silently breaks message routing.
4. WHEN the audit examines the DynamoDB key format conventions, THE Audit SHALL identify that key prefixes (`ACCT#`, `ARC#`, `SIG#`, `GKEY#`, `ALIAS#`, `SENDER#`, `DOMAIN#`, `VIEW#`, `RULE#`, `LABEL#`, `DEVICE#`, `TEMPLATE#`) are string literals scattered across multiple files with no central registry or type-safe key builder.
5. WHEN the audit examines the `SYSTEM_RULES` array, THE Audit SHALL identify that system rule IDs (SR-01 through SR-25) are hardcoded constants that must never collide with user-created rule IDs, but there is no namespace enforcement — a user rule could theoretically be assigned an ID starting with "SR-".
6. WHEN the audit examines the `RuleActionType` union, THE Audit SHALL identify that adding a new action type requires coordinated changes in: the type definition, the `deriveOutcome` switch statement, the rule validation logic, the API request schema, and the frontend — with no single source of truth that drives all of them.
7. WHEN the audit examines the signal status lifecycle, THE Audit SHALL identify that valid transitions are implicitly encoded across multiple methods (`updateSignalStatus`, `updateSignalSendStatus`, `unblockSignal`, `quarantineResponse`) rather than defined in a single state machine definition.
8. WHEN the audit examines the `SignalBase.signalLookupId` field, THE Audit SHALL identify that the convention "ses-{sesMessageId} for inbound, same as id for user/system" is documented in a comment but enforced only by the code that creates signals — any new signal creation path must know this convention.
9. WHEN the audit examines the `gsi1pk`/`gsi1sk` patterns, THE Audit SHALL identify that the same GSI is used for completely different access patterns across different item types (arcs use `ACCT#{id}` + `LASTACT#...`, signals use `ACCT#{id}#ARC#{arcId}`, rules use `ACCT#{id}` + `RULE#...`) — adding a new item type requires understanding all existing GSI usage to avoid key collisions.

### Requirement 9: API Surface and Information Leakage

**User Story:** As a platform operator, I want the API to return user-focused error messages and codes rather than exposing internal implementation details, so that the API is secure, stable, and decoupled from backend changes.

#### Acceptance Criteria

1. WHEN the audit examines error responses, THE Audit SHALL identify that the vast majority of database failures return a generic `500 "Internal Server Error"` with no error code, making it impossible for clients to distinguish between transient failures (retry) and permanent failures (don't retry).
2. WHEN the audit examines the error helper function, THE Audit SHALL identify that it includes `errorId: logger.getInvocationId()` in every error response — while useful for support, this exposes the internal request correlation ID format to clients.
3. WHEN the audit examines successful responses, THE Audit SHALL identify that arc and signal responses include internal DynamoDB attributes (`pk`, `sk`, `gsi1pk`, `gsi1sk`) that leak the database schema to API consumers.
4. WHEN the audit examines the `getArc` and `getSignalById` methods, THE Audit SHALL identify that they return raw DynamoDB items cast to domain types without stripping internal attributes, meaning any attribute added to the DynamoDB item automatically appears in the API response.
5. WHEN the audit examines the `updateArc` response, THE Audit SHALL identify that it returns `ALL_NEW` from DynamoDB and passes the entire item to the client, including any internal bookkeeping fields that should not be part of the API contract.
6. WHEN the audit examines the cursor pagination, THE Audit SHALL identify that the cursor is a base64url-encoded DynamoDB `LastEvaluatedKey` containing internal key structure — clients can decode it to learn partition key formats and potentially craft cursors to access other partitions.
7. WHEN the audit examines the `quarantineResponse` endpoint, THE Audit SHALL identify that it returns the full arc object and full signal object including all internal fields, rather than a minimal confirmation response.
8. WHEN the audit examines the WebSocket authorizer, THE Audit SHALL identify that it returns `accountId` and `userId` in the authorizer context which is accessible to any WebSocket route handler — if a new handler is added without proper scoping, it inherits full account access.
9. WHEN the audit examines the CORS configuration, THE Audit SHALL identify that the `Access-Control-Allow-Origin` header reflects the request's `Origin` header verbatim without validation, allowing any origin to make credentialed requests.
10. WHEN the audit examines the `listArcs` response, THE Audit SHALL identify that it returns full arc objects including potentially large `labels` arrays and `sentMessageIds` arrays when the client may only need summary fields for a list view.

### Requirement 10: Architectural Pits of Failure

**User Story:** As a developer, I want to identify architectural patterns where the default or easy path leads to bugs, so that I can restructure toward pits of success where correctness is the path of least resistance.

#### Acceptance Criteria

1. WHEN the audit examines the handler.ts singleton initialization, THE Audit SHALL identify that all AWS SDK clients, database instances, and service objects are instantiated at module load time — any initialization failure (missing env var, network issue) crashes the entire Lambda cold start with no graceful degradation or retry.
2. WHEN the audit examines the `handler.ts` event routing, THE Audit SHALL identify that the single entry point dispatches to 7+ different event types via sequential type-guard checks — adding a new event type requires modifying the god-handler rather than registering a handler in a registry.
3. WHEN the audit examines the `createApp` function, THE Audit SHALL identify that it is a 1500+ line function that defines all API routes inline — adding a new route requires modifying this single file, creating merge conflicts and making it impossible to understand route ownership at a glance.
4. WHEN the audit examines the error handling pattern, THE Audit SHALL identify that every route handler repeats the same `if (result.isErr()) return err(c, 500, "Internal Server Error")` pattern dozens of times — a missed check silently passes `undefined` to the next operation, and there is no middleware that handles Result types automatically.
5. WHEN the audit examines the `AccountDatabase` class, THE Audit SHALL identify that it owns too many concerns (accounts, aliases, senders, views, labels, rules, domains, templates, forwarding addresses, stats) — it is a second god class where any change to one entity risks breaking another.
6. WHEN the audit examines the authorization pattern, THE Audit SHALL identify that the `authorizationGuard` middleware is a safety net for forgotten `authorize()` calls, but the pit of failure is that forgetting `authz()` on a new route silently allows unauthorized access until the guard catches it at runtime.
7. WHEN the audit examines the `SYSTEM_RULES` evaluation, THE Audit SHALL identify that system rules are evaluated alongside user rules in the same loop with the same `applyRules` function — a bug in system rule evaluation (e.g., malformed JSONLogic) can block all signal processing for all accounts.
8. WHEN the audit examines the DynamoDB item structure, THE Audit SHALL identify that domain objects (Arc, Signal, Account) are stored with DynamoDB key attributes (`pk`, `sk`, `gsi1pk`, `gsi1sk`) mixed into the domain object — there is no separation between the storage representation and the domain model.
9. WHEN the audit examines the `processor.processRecord` method, THE Audit SHALL identify that it has multiple early-return paths where a failure in one step (e.g., account context fetch) causes the entire signal to be retried, even if the failure is permanent (account deleted) — there is no distinction between retryable and non-retryable failures.
10. WHEN the audit examines the `FeedbackProcessor` constructor, THE Audit SHALL identify that `signalStore` is optional (`signalStore?: FeedbackSignalStore`) meaning bounce correlation silently does nothing when the store is not provided — a wiring mistake in handler.ts would disable bounce handling with no error or warning.
11. WHEN the audit examines the `env var` pattern, THE Audit SHALL identify that environment variables are read with `!` non-null assertions (`process.env["EMAIL_BUCKET"]!`) at module scope — a missing env var produces a runtime crash with an unhelpful "Cannot read properties of undefined" error rather than a clear "EMAIL_BUCKET environment variable is required" message.
12. WHEN the audit examines the `DateTime.utc().toISO()!` pattern, THE Audit SHALL identify that this non-null assertion is used pervasively but `toISO()` can return null for invalid DateTime instances — if any upstream code produces an invalid DateTime, the assertion masks the bug.

### Requirement 11: Testability and Observability Gaps

**User Story:** As a developer, I want to identify areas where the system is difficult to test or observe in production, so that I can add the instrumentation and seams needed to maintain confidence at scale.

#### Acceptance Criteria

1. WHEN the audit examines the `SignalProcessor` class, THE Audit SHALL identify that its constructor requires 18+ dependencies, making unit testing require extensive mocking and making it impossible to test individual processing stages in isolation.
2. WHEN the audit examines the singleton pattern, THE Audit SHALL identify that `multiClusterWriter`, `dynamo`, and AWS SDK clients are module-level singletons that cannot be replaced in tests without module mocking — the system has no dependency injection container or factory pattern.
3. WHEN the audit examines the logging pattern, THE Audit SHALL identify that `logger.trackPoint` calls mark processing stages but there is no structured way to reconstruct the full processing timeline for a single signal from logs — correlation requires manual log searching.
4. WHEN the audit examines the error types, THE Audit SHALL identify that `DbError` is a single opaque type for all database failures — there is no way to distinguish between "item not found", "conditional check failed", "throughput exceeded", and "network timeout" without parsing error messages.
5. WHEN the audit examines the `handler.ts` wiring, THE Audit SHALL identify that the entire application is wired together at module scope with no way to override individual components for integration testing — testing the API requires the full processor, classifier, and all AWS clients to be available.
6. WHEN the audit examines the `ArcDatabase` class, THE Audit SHALL identify that it mixes DynamoDB operations (signals, arcs) with Aurora Data API operations (embeddings) in a single class, making it impossible to test DynamoDB logic without mocking Aurora and vice versa.

### Requirement 12: Security Boundary Violations

**User Story:** As a platform operator, I want to identify all places where tenant isolation can be violated or security boundaries are insufficiently enforced, so that I can prevent cross-tenant data access.

#### Acceptance Criteria

1. WHEN the audit examines the `accountId` extraction in the API, THE Audit SHALL identify that `accountId` is extracted from the URL path (`/accounts/:accountId/...`) and set in the auth context — a mismatch between the URL accountId and the user's actual permissions is caught only by the authorization middleware, which can be forgotten on new routes.
2. WHEN the audit examines the `getSignalById` method without `arcId`, THE Audit SHALL identify that it queries multiple GSI partitions and falls back to a direct table get — if the `accountId` in the partition key is not validated against the requesting user's account, cross-tenant signal access is possible.
3. WHEN the audit examines the Aurora RLS pattern, THE Audit SHALL identify that `SET LOCAL app.current_account_id` is the sole tenant isolation mechanism for pgvector queries — if a code path forgets to call `withAccountContext`, the query runs without RLS and can return any account's embeddings.
4. WHEN the audit examines the `decodeCursor` function, THE Audit SHALL identify that it deserializes arbitrary JSON from the client without validation — a crafted cursor containing a different account's partition key could bypass tenant isolation if the query does not independently filter by accountId.
5. WHEN the audit examines the WebSocket `$default` route, THE Audit SHALL identify that it returns 200 for any message without processing — if a future handler is added to `$default`, it inherits the accountId from the authorizer context without re-validation.
6. WHEN the audit examines the `CF_ORIGIN_SECRET` check, THE Audit SHALL identify that it is only applied when the env var is set — in development or misconfigured deployments, the entire API is accessible without CloudFront, bypassing WAF rules and rate limiting.

### Requirement 13: Formal Correctness Properties

**User Story:** As a platform operator, I want to define formal invariants that must hold at all times, so that I can build monitoring, alerting, and reconciliation jobs that detect violations.

#### Acceptance Criteria

1. THE Audit SHALL define the invariant: every signal with `status: "active"` has a non-null `arcId` that references an existing arc in the same account.
2. THE Audit SHALL define the invariant: no two arcs within the same account share the same non-null `groupingKey`.
3. THE Audit SHALL define the invariant: for every GKEY pointer item `GKEY#{accountId}#{key}`, the referenced `arcId` exists and that arc's `groupingKey` equals `key`.
4. THE Audit SHALL define the invariant: every arc's `lastSignalAt` is greater than or equal to the `createdAt` of the most recent signal in that arc.
5. THE Audit SHALL define the invariant: the GSI1 sort key of every arc item equals `LASTACT#{arc.status}#{arc.lastSignalAt}#{arc.id}` — any mismatch means the arc is invisible in list queries.
6. THE Audit SHALL define the invariant: every signal with `source: "email"` has a `signalLookupId` of the form `ses-{sesMessageId}`, and no two signals in the same account share the same `signalLookupId`.
7. THE Audit SHALL define the invariant: for every arc embedding row in Aurora, the referenced `arc_id` exists in DynamoDB and the `account_id` matches the arc's `accountId`.
8. THE Audit SHALL define the invariant: the sum of signals with `gsi1pk = ACCT#{accountId}#ARC#{arcId}` equals the actual number of signals belonging to that arc — no orphaned signals exist outside their arc's GSI partition.
9. THE Audit SHALL define the invariant: every signal with `status: "quarantine_visible"` or `status: "quarantine_hidden"` has `arcId` undefined and `gsi1pk = ACCT#{accountId}#QUARANTINED`.
10. THE Audit SHALL define the invariant: no signal transitions backward in the status lifecycle (e.g., `sent` cannot become `draft`, `block_hidden` cannot become `active` except via the explicit `quarantineResponse` unblock flow).
11. THE Audit SHALL define the invariant: for every `DEVICE#` item in `ACCOUNTS_TABLE`, the `accountId` attribute matches the account derived from the partition key — no device record can reference a different account than its storage partition.
12. THE Audit SHALL define the invariant: for every rule with `status: "enabled"`, its GSI1 sort key begins with `RULE#enabled#` — any mismatch means the rule is invisible to `listEnabledRules` and will not fire during processing.
