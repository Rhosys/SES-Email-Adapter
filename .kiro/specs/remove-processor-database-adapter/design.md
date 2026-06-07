# Design Document: Remove Database Adapters

## Overview

This is a mechanical refactoring that removes both the `ProcessorDatabaseAdapter` and `ApiDatabaseAdapter` classes, along with their corresponding interfaces (`ProcessorDatabase` and `ApiDatabase`). Both adapters are passthrough layers where every method is a one-liner delegating to a concrete database class. The one exception is `ApiDatabaseAdapter.updateArc`, which contains bridging logic that maps `UpdateArcRequest` to the 5-arg `ArcDatabase.updateArc` signature — this logic relocates into the API route handler.

The end result is the complete deletion of `src/database/adapters.ts`.

**Scope**: ~20 processor test files, ~10 API test files, 4 source files (processor.ts, handler.ts, adapters.ts, app.ts), and 1 consumer (rule-evaluator.ts).

## Architecture

No architectural change. The dependency graphs simplify from:

**Processor layer:**
```
SignalProcessor → ProcessorDatabase (interface)
                      ↑ implements
              ProcessorDatabaseAdapter → ArcDatabase
                                       → AccountDatabase
                                       → ProcessingDatabase
```

To:
```
SignalProcessor → ArcDatabase
               → AccountDatabase
               → ProcessingDatabase
```

**API layer:**
```
createApp() → ApiDatabase (interface)
                   ↑ implements
           ApiDatabaseAdapter → ArcDatabase
                              → AccountDatabase
                              → AuditDatabase
```

To:
```
createApp() → ArcDatabase
            → AccountDatabase
            → AuditDatabase
```

## Components and Interfaces

### ProcessorDatabase Method-to-Class Mapping

Each method currently on `ProcessorDatabase` maps to exactly one concrete class:

| Method | Target Class |
|--------|-------------|
| `getSignalByMessageId` | ArcDatabase |
| `saveSignal` | ArcDatabase |
| `updateSignalSendStatus` | ArcDatabase |
| `updateSignalRetention` | ArcDatabase |
| `getArc` | ArcDatabase |
| `fastFindArcByAlternativeLookupKey` | ArcDatabase |
| `saveArc` | ArcDatabase |
| `listEnabledRules` | AccountDatabase |
| `getProcessorAccountContext` | AccountDatabase |
| `saveAlias` | AccountDatabase |
| `getSender` | AccountDatabase |
| `saveSender` | AccountDatabase |
| `getTemplate` | AccountDatabase |
| `getDomainByName` | AccountDatabase |
| `incrementStats` | AccountDatabase |
| `annotateRuleError` | AccountDatabase |
| `annotateTemplateError` | AccountDatabase |
| `updateGlobalReputation` | ProcessingDatabase |

### ApiDatabase Method-to-Class Mapping

Each method currently on `ApiDatabase` maps to exactly one concrete class:

| Method | Target Class | Notes |
|--------|-------------|-------|
| `listArcs` | ArcDatabase | |
| `getArc` | ArcDatabase | |
| `updateArc` | ArcDatabase | Has bridging logic — see below |
| `updateArcDirect` | ArcDatabase | Removed — callers use `arcDb.updateArc` directly |
| `createArc` | ArcDatabase | |
| `listSignals` | ArcDatabase | |
| `listPreArcSignals` | ArcDatabase | |
| `getSignalById` | ArcDatabase | |
| `createSignal` | ArcDatabase | |
| `updateSignal` | ArcDatabase | |
| `updateSignalSendStatus` | ArcDatabase | |
| `deleteSignal` | ArcDatabase | |
| `updateSignalStatus` | ArcDatabase | |
| `unblockSignal` | ArcDatabase | |
| `fastFindArcByAlternativeLookupKey` | ArcDatabase | |
| `searchArcs` | ArcDatabase | |
| `getAccount` | AccountDatabase | |
| `createAccount` | AccountDatabase | |
| `updateAccount` | AccountDatabase | |
| `listViews` | AccountDatabase | |
| `getView` | AccountDatabase | |
| `createView` | AccountDatabase | |
| `updateView` | AccountDatabase | |
| `deleteView` | AccountDatabase | |
| `reorderViews` | AccountDatabase | |
| `listLabels` | AccountDatabase | |
| `createLabel` | AccountDatabase | |
| `updateLabel` | AccountDatabase | |
| `deleteLabel` | AccountDatabase | |
| `listRules` | AccountDatabase | |
| `createRule` | AccountDatabase | |
| `updateRule` | AccountDatabase | |
| `deleteRule` | AccountDatabase | |
| `listDomains` | AccountDatabase | |
| `getDomain` | AccountDatabase | |
| `createDomain` | AccountDatabase | |
| `deleteDomain` | AccountDatabase | |
| `updateDomainHealth` | AccountDatabase | |
| `listAliases` | AccountDatabase | |
| `getAlias` | AccountDatabase | |
| `createAlias` | AccountDatabase | |
| `saveAlias` | AccountDatabase | |
| `upsertAlias` | AccountDatabase | |
| `deleteAlias` | AccountDatabase | |
| `renameAlias` | AccountDatabase | |
| `saveSender` | AccountDatabase | |
| `removeSender` | AccountDatabase | |
| `getSender` | AccountDatabase | |
| `listSenders` | AccountDatabase | |
| `listAliasesForDomain` | AccountDatabase | |
| `createTemplate` | AccountDatabase | |
| `getTemplate` | AccountDatabase | |
| `updateTemplate` | AccountDatabase | |
| `deleteTemplate` | AccountDatabase | |
| `listTemplates` | AccountDatabase | |
| `getStats` | AccountDatabase | |
| `listVerifiedForwardingAddresses` | AccountDatabase | |
| `getVerifiedForwardingAddress` | AccountDatabase | |
| `saveVerifiedForwardingAddress` | AccountDatabase | |
| `deleteVerifiedForwardingAddress` | AccountDatabase | |
| `listAuditEvents` | AuditDatabase | |
| `saveAuditEvent` | AuditDatabase | |
| `listResourceHistory` | AuditDatabase | |

### Processor Constructor Change

**Before:**
```typescript
interface SignalProcessorOptions {
  store: ProcessorDatabase;
  arcDb?: ArcDatabase;  // only used for updateArc
  // ...other deps
}
```

**After:**
```typescript
interface SignalProcessorOptions {
  arcDb: ArcDatabase;        // required, replaces both store (arc methods) and optional arcDb
  accountDb: AccountDatabase; // replaces store (account methods)
  processingDb: ProcessingDatabase; // replaces store (reputation methods)
  // ...other deps unchanged
}
```

The `store` field and `ProcessorDatabase` interface are deleted entirely.

### Internal Reference Changes (Processor)

All `this.store.xxx()` calls become:
- `this.arcDb.xxx()` for arc/signal methods
- `this.accountDb.xxx()` for account methods
- `this.processingDb.xxx()` for reputation methods

The existing `this.arcDb` field (previously optional, used only for `updateArc`) becomes the single required `arcDb` field that handles all arc operations.

### JsonLogicRuleEvaluator Change

The `RuleAnnotationStore` interface in rule-evaluator.ts has a single method (`annotateRuleError`). The evaluator currently receives the `ProcessorDatabaseAdapter` instance cast to this interface.

**After**: Pass `accountDb` directly (it already has `annotateRuleError`). The `RuleAnnotationStore` interface can remain as a narrow type constraint, or the evaluator can accept `Pick<AccountDatabase, "annotateRuleError">`. Either works — the key change is the wiring in handler.ts passes `accountDb` instead of `processorStore`.

### API App Constructor Change (AppDeps)

**Before:**
```typescript
interface AppDeps {
  store: ApiDatabase;
  auth: AuthService;
  access?: AccessService;
  // ...other deps
}
```

**After:**
```typescript
interface AppDeps {
  arcDb: ArcDatabase;
  accountDb: AccountDatabase;
  auditDb: AuditDatabase;
  auth: AuthService;
  access?: AccessService;
  // ...other deps unchanged
}
```

The `store` field and `ApiDatabase` interface are deleted entirely.

### Internal Reference Changes (API App)

All `store.xxx()` calls in `createApp()` become:
- `arcDb.xxx()` for arc/signal methods
- `accountDb.xxx()` for account/view/label/rule/domain/alias/sender/template/stats/forwarding methods
- `auditDb.xxx()` for audit methods

### updateArc Bridging Logic Relocation

The `ApiDatabaseAdapter.updateArc` method contains actual logic:

```typescript
updateArc(accountId: string, id: string, update: UpdateArcRequest) {
  const fields: UpdateArcFields = {};
  if (update.urgency !== undefined) fields.urgency = update.urgency;
  if (update.labels !== undefined) fields.labels = update.labels;
  return this.arc.updateArc(accountId, id, update.status ?? "active", update.lastSignalAt ?? new Date().toISOString(), fields);
}
```

This logic moves inline into the API route handler that calls `store.updateArc(...)`. **Bug fix**: the current defaults (`status ?? "active"`, `lastSignalAt ?? now`) are incorrect — a PATCH that only changes labels should not silently flip status to active. The route handler already reads the arc via `getArc`, so the correct defaults are `arc.status` and `arc.lastSignalAt`:

```typescript
// In the PATCH /arcs/:id handler (arc already read via getArc):
const fields: UpdateArcFields = {};
if (body.urgency !== undefined) fields.urgency = body.urgency;
if (body.labels !== undefined) fields.labels = body.labels;
const status = body.status ?? arc.status;
const lastSignalAt = body.lastSignalAt ?? arc.lastSignalAt;
const updateResult = await arcDb.updateArc(accountId, arc.id, status, lastSignalAt, fields);
```

The `updateArcDirect` method is removed — any caller that needs the raw 5-arg signature calls `arcDb.updateArc(...)` directly.

### handler.ts Wiring Change

**Before:**
```typescript
const processorStore = new ProcessorDatabaseAdapter(arcDb, accountDb, processingDb);
const processor = new SignalProcessor({ store: processorStore, arcDb, ... });
const ruleEvaluator = new JsonLogicRuleEvaluator(logger, userCodeExecutor, processorStore);

const app = createApp({
  store: new ApiDatabaseAdapter(arcDb, accountDb, auditDb),
  ...
});
```

**After:**
```typescript
// processorStore deleted entirely
// ApiDatabaseAdapter deleted entirely
const ruleEvaluator = new JsonLogicRuleEvaluator(logger, userCodeExecutor, accountDb);
const processor = new SignalProcessor({ arcDb, accountDb, processingDb, ... });

const app = createApp({
  arcDb,
  accountDb,
  auditDb,
  ...
});
```

### adapters.ts Deletion

The entire file `src/database/adapters.ts` is deleted. Both classes and all their imports are removed.

## Data Models

No data model changes. This is a purely structural refactoring — the same database methods are called with the same arguments in the same order.

## Error Handling

No changes. All methods already return `Result<T, DbError>` and the error-handling logic in both the processor and API layer is unchanged.

## Testing Strategy

### Processor Test Mock Migration

~15 processor test files define a `makeStore(): ProcessorDatabase` helper that returns a mock object with all 18 methods. These need splitting into three separate mock factories.

**Recommended approach — shared test helper:**

Create or update a test helper (e.g. `tests/processor/_helpers.ts`) that exports:

```typescript
function makeArcDbMock(): Partial<ArcDatabase> { ... }
function makeAccountDbMock(): Partial<AccountDatabase> { ... }
function makeProcessingDbMock(): Partial<ProcessingDatabase> { ... }
```

Each test file replaces its local `makeStore()` with calls to these three helpers. The `buildProcessor` helpers pass the three mocks separately.

**Migration pattern per processor test file:**

1. Replace `import type { ProcessorDatabase }` with imports of the three concrete types
2. Replace `makeStore(): ProcessorDatabase` with three mock factories (or import shared ones)
3. Update `buildProcessor` / `new SignalProcessor(...)` calls to pass `arcDb`, `accountDb`, `processingDb` instead of `store`
4. Remove any `arcDb: mockArcDb as never` hacks (the mock is now the primary `arcDb`)

### API Test Mock Migration

API test files that mock `ApiDatabase` need updating to mock the three concrete classes separately.

**Migration pattern per API test file:**

1. Replace `import type { ApiDatabase }` with imports of ArcDatabase, AccountDatabase, AuditDatabase
2. Replace the single store mock with three separate mocks
3. Update `createApp(...)` calls to pass `arcDb`, `accountDb`, `auditDb` instead of `store`
4. For `updateArc` tests: the mock is now on `arcDb.updateArc` with the 5-arg signature; test assertions may need updating to verify the bridging logic (field extraction, defaults)

### http-authorizer.test.ts

This file mocks the adapters module:
```typescript
vi.mock("../src/database/adapters.js", () => ({
  ProcessorDatabaseAdapter: vi.fn().mockImplementation(() => ({})),
  ApiDatabaseAdapter: vi.fn().mockImplementation(() => ({})),
}));
```

After refactoring, remove the entire `vi.mock("../src/database/adapters.js", ...)` call since the file no longer exists.

### Verification

Run `npm test` (type-check + vitest) after the refactoring. Zero failures confirms no regression.
