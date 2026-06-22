# Requirements: Remove RuleAction disabled field

## Overview
Replace the per-action `disabled` field on `RuleAction` with whole-rule disabling on bounce. When a forward target permanently bounces, the entire rule is disabled — not just the individual action. Then remove the `disabled` field from the type, schemas, and runtime.

## Requirements

### Requirement 0: Bounce disables the entire rule (not individual actions)

**User Story:** As the system, I want a permanent forward bounce to disable the entire rule that contains the bouncing action, so that the user sees a clear disabled rule rather than a partially-functioning rule with hidden disabled actions.

#### Acceptance Criteria

1. WHEN the feedback processor receives a permanent bounce for a forwarded email, THE feedback processor SHALL find all rules in the account whose actions include a `forward` action targeting the bounced address, and set each rule's `status` to `"disabled"`.
2. THE feedback processor SHALL log a TRACK entry for each rule it disables, with the rule ID, bounced address, and account ID in the context.
3. THE `disableForwardActions` method in `account-database.ts` SHALL be changed to disable the entire rule (`status: "disabled"`) rather than setting `disabled: true` on individual actions.

### Requirement 1: Remove `disabled` from RuleAction type definition

**User Story:** As a developer, I want the `disabled` field removed from `RuleAction` since bounce handling now disables the entire rule.

#### Acceptance Criteria

1. The `disabled?: boolean` property is removed from the `RuleAction` interface in `src/types/index.ts`.
2. The comment referencing auto-set behavior on forward bounce is removed.

### Requirement 2: Remove `disabled` from API request schema

**User Story:** As a developer, I want the API to stop accepting or validating the `disabled` field on rule actions.

#### Acceptance Criteria

1. The `disabled: z.boolean().optional()` field is removed from `RuleActionSchema` in `src/api/requests.ts`.

### Requirement 3: Remove `disabled` from OpenAPI response schema

**User Story:** As an API consumer, I want the `disabled` field removed from API responses since it no longer carries meaning.

#### Acceptance Criteria

1. The `disabled: z.boolean().optional()` field is removed from the `RuleAction` schema in `src/api/schemas.ts`.

### Requirement 4: Remove disabled-action filtering from processor

**User Story:** As a developer, I want the processor to execute all actions on a rule without per-action disabled checks, since disabled rules are now skipped entirely at the rule level.

#### Acceptance Criteria

1. The `.filter((a) => !a.disabled)` is removed from the static actions line in `applyRules`.
2. All rule actions are mapped directly to their `{ type, value }` shape without filtering.

### Requirement 5: Update `disableForwardActions` to disable whole rules

**User Story:** As the system, I want the existing `disableForwardActions` method refactored to disable entire rules rather than individual actions.

#### Acceptance Criteria

1. The method finds all rules with a `forward` action targeting the given address (same lookup as before).
2. For each matched rule, the method sets `rule.status = "disabled"` via the existing `updateRule` method.
3. The method no longer modifies individual action objects.
4. The method name may be renamed to reflect its new behavior (e.g. `disableRulesForwardingTo`).

### Requirement 6: Update tests

**User Story:** As a developer, I want tests updated to verify the new whole-rule disable behavior and confirm the `disabled` field is no longer used.

#### Acceptance Criteria

1. The "skips disabled actions" test in `processor.spec.ts` is removed (behavior no longer exists).
2. The `disableForwardActions` tests in `feedback-processor-bounce.test.ts` are updated to assert that the entire rule is disabled (status = "disabled") rather than individual actions being marked disabled.
3. `npm test` passes after all changes.
