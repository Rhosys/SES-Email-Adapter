# Requirements Document

## Introduction

The email-catcher backend uses DynamoDB across four tables (accounts, signals, processing, audit). A storage-layer audit identified three optimization opportunities that reduce redundant writes and reads on the hot path, plus a search observability improvement. This spec covers: batching multiple `saveArc` calls in the processor into a single write, using `ReturnValues: "ALL_NEW"` to eliminate follow-up reads after mutations, adding a direct-lookup item for domain-by-name resolution, and logging when `searchArcs` fetches a large result set.

## Glossary

- **Processor**: The `SignalProcessor` class in `src/processor/processor.ts` that handles inbound email signals end-to-end.
- **Arc**: A conversation thread grouping related signals, stored in the signals DynamoDB table.
- **Signal**: An individual inbound email event associated with an arc.
- **saveArc**: A method on `ArcDatabase` that performs a full `PutCommand` overwriting the entire arc item plus its grouping-key pointer.
- **SIGNALS_TABLE**: The DynamoDB table storing arcs, signals, and grouping-key lookup items.
- **ACCOUNTS_TABLE**: The DynamoDB table storing account metadata, aliases, views, labels, rules, domains, and templates.
- **GKEY**: A direct-lookup item pattern using a composite partition key (`GKEY#accountId#key`) for O(1) resolution of arcs by grouping key.
- **DNAME**: A direct-lookup item pattern using a composite partition key (`DNAME#accountId#domainName`) for O(1) resolution of domains by name.
- **ReturnValues**: A DynamoDB UpdateCommand option that returns the item state after mutation, eliminating the need for a separate GetCommand.
- **processMessage**: The core method in `SignalProcessor` that processes a single inbound email through classification, arc matching, rule evaluation, and persistence.

## Requirements

### Requirement 1: Batch Arc Writes in Processor

**User Story:** As a system operator, I want the processor to accumulate arc mutations and perform a single `saveArc` call at the end of `processMessage`, so that DynamoDB write capacity is not wasted on redundant full-item overwrites.

#### Acceptance Criteria

1. WHEN `processMessage` completes successfully for a non-blocked, non-quarantined signal, THE Processor SHALL call `saveArc` exactly once.
2. WHEN the retention step updates the arc TTL, THE Processor SHALL apply the TTL mutation to the in-memory arc object without issuing a separate `saveArc` call.
3. WHEN auto-reply sends succeed and append to `sentMessageIds`, THE Processor SHALL accumulate all message IDs on the in-memory arc object and persist them in the single final `saveArc` call.
4. WHEN pong reply succeeds and appends to `sentMessageIds`, THE Processor SHALL accumulate the message ID on the in-memory arc object without issuing a separate `saveArc` call.
5. THE Processor SHALL preserve the existing behavior where blocked and quarantined signals do not trigger any `saveArc` call.
6. FOR ALL valid processing paths that reach the final `saveArc`, THE arc item written to DynamoDB SHALL contain the union of all mutations (TTL, sentMessageIds, status, labels, urgency) accumulated during `processMessage`.

### Requirement 2: Eliminate Redundant Reads via ReturnValues

**User Story:** As a system operator, I want API mutation handlers to use DynamoDB's `ReturnValues: "ALL_NEW"` option, so that each mutation requires one round-trip instead of two.

#### Acceptance Criteria

1. WHEN `updateArc` performs an UpdateCommand, THE ArcDatabase SHALL specify `ReturnValues: "ALL_NEW"` and return the item from the UpdateCommand response without issuing a subsequent GetCommand.
2. WHEN `updateSignal` performs an UpdateCommand, THE ArcDatabase SHALL specify `ReturnValues: "ALL_NEW"` and return the item from the UpdateCommand response without issuing a subsequent GetCommand.
3. WHEN `updateView` performs an UpdateCommand, THE AccountDatabase SHALL specify `ReturnValues: "ALL_NEW"` and return the item from the UpdateCommand response without issuing a subsequent GetCommand.
4. WHEN `updateLabel` performs an UpdateCommand, THE AccountDatabase SHALL specify `ReturnValues: "ALL_NEW"` and return the item from the UpdateCommand response without issuing a subsequent GetCommand.
5. WHEN `updateRule` performs an UpdateCommand, THE AccountDatabase SHALL specify `ReturnValues: "ALL_NEW"` and return the item from the UpdateCommand response without issuing a subsequent GetCommand.
6. WHEN `updateTemplate` performs an UpdateCommand, THE AccountDatabase SHALL specify `ReturnValues: "ALL_NEW"` and return the item from the UpdateCommand response without issuing a subsequent GetCommand.
7. WHEN `updateAccount` performs an UpdateCommand, THE AccountDatabase SHALL specify `ReturnValues: "ALL_NEW"` and return the item from the UpdateCommand response without issuing a subsequent GetCommand.
8. WHEN `blockSignal` performs an UpdateCommand, THE ArcDatabase SHALL specify `ReturnValues: "ALL_NEW"` and return the item from the UpdateCommand response without issuing a subsequent GetCommand.
9. FOR ALL mutation methods using `ReturnValues: "ALL_NEW"`, THE returned item SHALL exclude DynamoDB internal key attributes (`pk`, `sk`, `gsi1pk`, `gsi1sk`) from the domain object returned to callers.

### Requirement 3: Re-key Domains by Name

**User Story:** As a system operator, I want domains keyed by their domain name instead of a synthetic UUID, so that `getDomainByName` is a direct GetCommand and no lookup indirection is needed.

#### Acceptance Criteria

1. WHEN a domain is created via `createDomain`, THE AccountDatabase SHALL store it with sort key `DOMAIN#${domainName}` instead of `DOMAIN#${uuid}`.
2. THE Domain type's `id` field SHALL be the domain name itself (e.g. `"example.com"`), not a UUID.
3. WHEN `getDomainByName` is called, THE AccountDatabase SHALL perform a single GetCommand with key `pk: ACCT#${accountId}, sk: DOMAIN#${domainName}` instead of querying all domains and filtering in memory.
4. WHEN `getDomain` is called with a domain name as the ID, THE AccountDatabase SHALL perform a direct GetCommand using that name as the sort key suffix.
5. WHEN `deleteDomain` is called, THE AccountDatabase SHALL delete the item keyed by `DOMAIN#${domainName}`.
6. THE API routes SHALL accept the domain name as the `:id` parameter (e.g. `GET /accounts/:accountId/domains/example.com`).
7. ALL existing references to `domain.id` in the codebase SHALL continue to work because `id` now equals the domain name.

### Requirement 4: Search Observability Logging

**User Story:** As a system operator, I want `searchArcs` to log a warning when it fetches more than 200 arcs for in-memory filtering, so that I have a signal indicating a proper search index is needed.

#### Acceptance Criteria

1. WHEN `searchArcs` fetches more than 200 items from DynamoDB before applying the in-memory filter, THE ArcDatabase SHALL emit a structured log entry at warn level.
2. THE log entry SHALL include the account ID, the query string, and the number of items fetched.
3. WHILE the fetched item count is 200 or fewer, THE ArcDatabase SHALL not emit the warning log entry.
