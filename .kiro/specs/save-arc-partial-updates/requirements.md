# Requirements Document

## Introduction

Replace misuse of `saveArc` (full DynamoDB PutItem) with `updateArc` (targeted UpdateExpression) at call sites that only modify a subset of arc fields. After this refactoring, `saveArc` is used exclusively for initial arc creation, while all subsequent field mutations go through `updateArc`. This reduces write amplification, makes intent explicit at each call site, and prevents accidental overwrites of concurrently-modified fields.

## Glossary

- **Arc_Database**: The `ArcDatabase` class in `src/database/arc-database.ts` that provides DynamoDB operations for arcs and signals.
- **Processor**: The `SignalProcessor` class in `src/processor/processor.ts` that handles inbound email processing and arc creation/update.
- **API_Layer**: The Hono route handlers in `src/api/app.ts` that serve REST endpoints for arc operations.
- **UpdateArcRequest**: The Zod-validated type defining the fields that `updateArc` accepts: `status`, `urgency`, `labels`, and `lastSignalAt`.
- **saveArc**: The method that performs a full DynamoDB PutItem, writing all arc fields plus GSI keys unconditionally.
- **updateArc**: The method that performs a targeted DynamoDB UpdateExpression, modifying only the specified fields.
- **Write_Amplification**: The overhead of writing all fields when only a subset changed, consuming unnecessary DynamoDB write capacity units.

## Requirements

### Requirement 1: Restrict saveArc to initial arc creation

**User Story:** As a developer, I want `saveArc` to be used only when creating a new arc, so that the intent of each call site is unambiguous and full-item writes only happen once per arc lifecycle.

#### Acceptance Criteria

1. THE Processor SHALL call `saveArc` only when `matchedArc` is null (the arc is newly created).
2. WHEN `matchedArc` is not null, THE Processor SHALL call `updateArc` with only the fields that changed (status, labels, urgency, lastSignalAt) instead of `saveArc`.
3. THE API_Layer SHALL not call `saveArc` for partial field updates (e.g. bumping `lastSignalAt` on an existing arc during signal unblock).
4. THE Arc_Database SHALL retain `saveArc` as a public method for use by `createArc`.

### Requirement 2: Extend updateArc to support processor-originated fields

**User Story:** As a developer, I want `updateArc` to accept all fields the processor may mutate on an existing arc, so that partial updates cover every mutation path.

#### Acceptance Criteria

1. THE UpdateArcRequest type SHALL support the required parameters `status` and `lastSignalAt`, plus optional fields: `labels`, `urgency`, `summary`, `workflow`, `retentionDuration`, and `sentMessageIds`.
2. THE Arc_Database `updateArc` method SHALL build a DynamoDB UpdateExpression that always sets `status`, `lastSignalAt`, `gsi1sk`, and `updatedAt`, plus any optional fields present in the request.
3. THE Arc_Database `updateArc` method SHALL always recompute `gsi1sk` from the provided `status` and `lastSignalAt`.
4. THE Arc_Database `updateArc` method SHALL set `updatedAt` to the current ISO timestamp on every call.

### Requirement 3: Convert processor saveArc call site for existing arcs

**User Story:** As a developer, I want the processor to use `updateArc` when appending a signal to an existing arc, so that only the mutated fields are written to DynamoDB.

#### Acceptance Criteria

1. WHEN the processor matches an existing arc, THE Processor SHALL always set `status: "active"` and `lastSignalAt` to the signal's timestamp (reactivation).
2. THE Processor SHALL compute the delta of optional fields (labels, urgency, summary, workflow, retentionDuration, sentMessageIds) between the matched arc and the mutated arc.
3. THE Processor SHALL call `arcDb.updateArc(accountId, arcId, "active", lastSignalAt, delta)`.
4. IF a rule sets `outcome.archive`, THE Processor SHALL pass `status: "archived"` instead of `"active"`.

### Requirement 4: Convert API layer saveArc call site

**User Story:** As a developer, I want the unblock-signal handler to use `updateArc` instead of `saveArc` when bumping `lastSignalAt`, so that the write is targeted.

#### Acceptance Criteria

1. WHEN the unblock-signal handler adds a signal to an existing arc, THE API_Layer SHALL call `arcDb.updateArc(accountId, arcId, "active", signal.receivedAt, {})`.
2. THE API_Layer SHALL not spread the full arc object into a PutItem for this operation.

### Requirement 5: Maintain GSI consistency for updateArc

**User Story:** As a developer, I want `updateArc` to keep the GSI1 sort key consistent with the arc's status and lastSignalAt, so that list queries continue to return correct ordering.

#### Acceptance Criteria

1. THE Arc_Database `updateArc` SHALL always recompute `gsi1sk` as `LASTACT#${status}#${lastSignalAt}#${id}` since both are required parameters.
2. THE Arc_Database SHALL use `ReturnValues: "ALL_NEW"` to return the complete updated arc to the caller.

### Requirement 6: Remove dead `delete` rule action from processor

**User Story:** As a developer, I want the `delete` rule action removed from the processor's rule evaluation, since arcs are never deleted by automation — only by the user.

#### Acceptance Criteria

1. THE Processor SHALL NOT set `arc.status = "deleted"` in response to any rule action.
2. THE `outcome.delete` branch SHALL be removed from rule evaluation in the processor.
3. THE `delete` action type SHALL be removed from the rule action types available to users (if exposed in the API/UI).

### Requirement 7: Test coverage for updateArc field combinations

**User Story:** As a developer, I want tests that verify `updateArc` correctly handles each supported field individually and in combination, so that regressions are caught.

#### Acceptance Criteria

1. THE test suite SHALL verify that calling `updateArc` with status + lastSignalAt only recomputes `gsi1sk` and sets `updatedAt`.
2. THE test suite SHALL verify that calling `updateArc` with additional `labels` updates labels alongside the required fields.
3. THE test suite SHALL verify that calling `updateArc` with `summary` and `workflow` updates both fields.
4. THE test suite SHALL verify that `updatedAt` is set on every `updateArc` call regardless of which optional fields are provided.
5. THE test suite SHALL verify that the processor calls `updateArc` (not `saveArc`) when processing a signal onto an existing arc.
6. THE test suite SHALL verify that the processor calls `saveArc` when creating a new arc.
7. THE test suite SHALL verify that the processor reactivates archived arcs to `active` when a new signal arrives.
8. THE test suite SHALL verify that the `delete` rule action no longer sets arc status to `deleted`.
