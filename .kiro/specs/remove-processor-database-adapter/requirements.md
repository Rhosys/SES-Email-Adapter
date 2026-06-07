# Requirements Document

## Introduction

Remove both the `ProcessorDatabaseAdapter` and `ApiDatabaseAdapter` classes, along with their corresponding interfaces (`ProcessorDatabase` and `ApiDatabase`). Both adapters are passthrough layers — every method is a one-liner delegating to `ArcDatabase`, `AccountDatabase`, `ProcessingDatabase`, or `AuditDatabase`. The one exception is `ApiDatabaseAdapter.updateArc`, which contains bridging logic to map `UpdateArcRequest` optional fields to the 5-arg `ArcDatabase.updateArc` signature. This refactoring eliminates the unnecessary indirection by having consumers accept the concrete database classes directly, and relocates the `updateArc` bridging logic into the API route handler.

The end goal is to delete `src/database/adapters.ts` entirely.

## Glossary

- **Processor**: The `SignalProcessor` class in `src/processor/processor.ts` that handles inbound email signals.
- **API_App**: The Hono application created by `createApp()` in `src/api/app.ts` that serves the REST API.
- **ArcDatabase**: The concrete database class in `src/database/arc-database.ts` responsible for arc and signal persistence.
- **AccountDatabase**: The concrete database class in `src/database/account-database.ts` responsible for account, alias, rule, domain, sender, and template persistence.
- **ProcessingDatabase**: The concrete database class in `src/database/processing-database.ts` responsible for global reputation tracking.
- **AuditDatabase**: The concrete database class in `src/database/audit-database.ts` responsible for audit event persistence.
- **ProcessorDatabase**: The interface in `src/processor/processor.ts` that currently defines the database contract for the Processor (to be removed).
- **ProcessorDatabaseAdapter**: The class in `src/database/adapters.ts` that implements ProcessorDatabase by delegating to ArcDatabase, AccountDatabase, and ProcessingDatabase (to be removed).
- **ApiDatabase**: The interface in `src/api/app.ts` that currently defines the database contract for the API layer (to be removed).
- **ApiDatabaseAdapter**: The class in `src/database/adapters.ts` that implements ApiDatabase by delegating to ArcDatabase, AccountDatabase, and AuditDatabase (to be removed).
- **UpdateArcRequest**: The request type in `src/api/requests.ts` representing a partial arc update from the API.
- **UpdateArcFields**: The type in `src/database/arc-database.ts` representing the optional fields passed to `ArcDatabase.updateArc`.

## Requirements

### Requirement 1: Remove ProcessorDatabase interface

**User Story:** As a developer, I want the ProcessorDatabase interface removed, so that the codebase has less unnecessary abstraction.

#### Acceptance Criteria

1. WHEN the refactoring is complete, THE Processor SHALL accept ArcDatabase, AccountDatabase, and ProcessingDatabase as separate constructor parameters instead of a single ProcessorDatabase parameter.
2. THE Processor SHALL call methods directly on ArcDatabase for arc and signal operations (saveArc, getArc, fastFindArcByAlternativeLookupKey, saveSignal, getSignalByMessageId, updateSignalRetention, updateSignalSendStatus).
3. THE Processor SHALL call methods directly on AccountDatabase for account operations (listEnabledRules, getProcessorAccountContext, saveAlias, getSender, saveSender, getTemplate, getDomainByName, incrementStats, annotateRuleError, annotateTemplateError).
4. THE Processor SHALL call methods directly on ProcessingDatabase for reputation operations (updateGlobalReputation).
5. WHEN the refactoring is complete, THE ProcessorDatabase interface definition SHALL no longer exist in the codebase.

### Requirement 2: Remove ProcessorDatabaseAdapter class

**User Story:** As a developer, I want the ProcessorDatabaseAdapter class removed, so that there is no passthrough adapter layer adding complexity without value.

#### Acceptance Criteria

1. WHEN the refactoring is complete, THE ProcessorDatabaseAdapter class SHALL no longer exist in the codebase.
2. WHEN the refactoring is complete, THE handler wiring in `src/handler.ts` SHALL pass ArcDatabase, AccountDatabase, and ProcessingDatabase directly to the Processor constructor instead of wrapping them in ProcessorDatabaseAdapter, and SHALL remove the `processorStore` variable entirely.
3. WHEN the refactoring is complete, THE handler wiring in `src/handler.ts` SHALL pass the concrete database instances directly to any other consumer that previously received the ProcessorDatabaseAdapter instance (such as JsonLogicRuleEvaluator), replacing the single adapter parameter with the required concrete database parameters.

### Requirement 3: Update processor constructor and internal references

**User Story:** As a developer, I want the processor to use named database fields, so that call sites are clear about which database handles each operation.

#### Acceptance Criteria

1. THE Processor SHALL declare exactly three database fields — `private readonly arcDb: ArcDatabase`, `private readonly accountDb: AccountDatabase`, and `private readonly processingDb: ProcessingDatabase` — and SHALL NOT declare a `store` field.
2. WHEN a method previously called via `this.store` is invoked, THE Processor SHALL call the equivalent method on the concrete database field designated by Requirement 1 criteria 2–4 (arcDb for arc/signal operations, accountDb for account operations, processingDb for reputation operations).
3. THE Processor SHALL accept `arcDb` as a required (non-optional) constructor parameter typed as `ArcDatabase`, consolidating the previously optional `arcDb` field (used for `updateArc`) with the arc/signal operations formerly routed through `this.store`.

### Requirement 4: Update processor test mocks

**User Story:** As a developer, I want tests to mock the concrete database classes directly, so that test setup reflects the actual dependency structure.

#### Acceptance Criteria

1. WHEN the refactoring is complete, THE test files SHALL mock ArcDatabase, AccountDatabase, and ProcessingDatabase as separate mock objects instead of mocking a single ProcessorDatabase interface.
2. THE test helper functions (makeStore or equivalent) SHALL be replaced or updated to return separate objects typed to ArcDatabase, AccountDatabase, and ProcessingDatabase, with each object containing only the methods belonging to that concrete class.
3. WHEN the refactoring is complete, THE test processor-construction helpers (buildProcessor or equivalent) SHALL pass the separate database mocks to the Processor constructor matching the new multi-parameter signature defined in Requirement 3.
4. IF any test file mocks ProcessorDatabaseAdapter (e.g. via vi.mock of the adapters module), THEN THE refactoring SHALL remove that mock and replace it with direct references to the concrete database classes where needed.
5. WHEN the refactoring is complete, THE test suite SHALL pass with zero failures.

### Requirement 5: Remove ApiDatabase interface

**User Story:** As a developer, I want the ApiDatabase interface removed, so that the API layer uses concrete database classes directly without an unnecessary abstraction layer.

#### Acceptance Criteria

1. WHEN the refactoring is complete, THE ApiDatabase interface definition SHALL no longer exist in `src/api/app.ts`.
2. WHEN the refactoring is complete, THE `AppDeps` interface in `src/api/app.ts` SHALL accept `arcDb: ArcDatabase`, `accountDb: AccountDatabase`, and `auditDb: AuditDatabase` as separate fields instead of a single `store: ApiDatabase` field.
3. THE API_App SHALL call methods directly on ArcDatabase for arc and signal operations (listArcs, getArc, updateArc, createArc, listSignals, listPreArcSignals, getSignalById, createSignal, updateSignal, updateSignalSendStatus, deleteSignal, updateSignalStatus, unblockSignal, fastFindArcByAlternativeLookupKey, searchArcs).
4. THE API_App SHALL call methods directly on AccountDatabase for account, view, label, rule, domain, alias, sender, template, stats, and verified-forwarding-address operations.
5. THE API_App SHALL call methods directly on AuditDatabase for audit operations (listAuditEvents, saveAuditEvent, listResourceHistory).

### Requirement 6: Remove ApiDatabaseAdapter class

**User Story:** As a developer, I want the ApiDatabaseAdapter class removed, so that the entire `src/database/adapters.ts` file can be deleted.

#### Acceptance Criteria

1. WHEN the refactoring is complete, THE ApiDatabaseAdapter class SHALL no longer exist in the codebase.
2. WHEN the refactoring is complete, THE handler wiring in `src/handler.ts` SHALL pass ArcDatabase, AccountDatabase, and AuditDatabase directly to `createApp()` instead of wrapping them in ApiDatabaseAdapter.
3. WHEN the refactoring is complete, THE `src/database/adapters.ts` file SHALL be deleted entirely.

### Requirement 7: Relocate updateArc bridging logic

**User Story:** As a developer, I want the `updateArc` bridging logic (mapping `UpdateArcRequest` optional fields to the 5-arg `ArcDatabase.updateArc` signature) preserved in the API layer, so that the API route continues to work correctly after the adapter is removed.

#### Acceptance Criteria

1. THE PATCH /arcs/:id handler SHALL read the current arc first, then use `arc.status` as the default when the request does not provide a `status` field — it SHALL NOT default to `"active"`.
2. THE PATCH /arcs/:id handler SHALL use `arc.lastSignalAt` as the default when the request does not provide a `lastSignalAt` field — it SHALL NOT default to `new Date().toISOString()`.
3. THE PATCH /arcs/:id handler SHALL extract `urgency` and `labels` from `UpdateArcRequest` into `UpdateArcFields`, then call `arcDb.updateArc(accountId, id, status, lastSignalAt, fields)` with the resolved arguments.
4. THE `updateArcDirect` method on ApiDatabase SHALL be removed — callers that need the 5-arg signature SHALL call `arcDb.updateArc` directly.

### Requirement 8: Update API test mocks

**User Story:** As a developer, I want API tests to mock the concrete database classes directly, so that test setup reflects the actual dependency structure.

#### Acceptance Criteria

1. WHEN the refactoring is complete, THE API test files SHALL mock ArcDatabase, AccountDatabase, and AuditDatabase as separate mock objects instead of mocking a single ApiDatabase interface.
2. WHEN the refactoring is complete, THE test helpers that construct the app (via `createApp`) SHALL pass `arcDb`, `accountDb`, and `auditDb` as separate fields matching the new `AppDeps` signature.
3. IF any test file mocks ApiDatabaseAdapter (e.g. via vi.mock of the adapters module), THEN THE refactoring SHALL remove that mock entirely.
4. WHEN the refactoring is complete, THE test suite SHALL pass with zero failures.

### Requirement 9: Preserve existing behaviour

**User Story:** As a developer, I want the refactoring to be purely structural with no behaviour changes, so that no regressions are introduced.

#### Acceptance Criteria

1. THE Processor SHALL preserve the public method signatures of `processRecord` and `processSideEffect` — same parameter types, same return types (`Result<void, DbError>`), and same error-wrapping logic.
2. THE Processor SHALL invoke the same database methods in the same order with the same arguments as before the refactoring, so that observable side-effect sequencing is unchanged.
3. THE API_App SHALL preserve all existing route handlers with the same request/response contracts — same HTTP methods, paths, request bodies, and response shapes.
4. IF any other module imports ProcessorDatabase, ProcessorDatabaseAdapter, ApiDatabase, or ApiDatabaseAdapter, THEN THE refactoring SHALL update those modules to accept and use the concrete database classes directly.
5. WHEN the refactoring is complete, THE existing test suite SHALL pass with zero failures and zero type errors, confirming no regression in behaviour.
