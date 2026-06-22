# Tasks: Remove RuleAction disabled field

## Overview

Refactor bounce handling to disable entire rules (not individual actions), then remove the `disabled` field from `RuleAction`.

## Tasks

- [x] 1. Refactor `disableForwardActions` to disable whole rules
  - [x] 1.1 In `src/database/account-database.ts`, rename `disableForwardActions` to `disableRulesForwardingTo`. Change the implementation: instead of mapping `disabled: true` onto individual action objects, call `this.updateRule(accountId, rule.id, { status: "disabled" })` for each affected rule. The lookup remains the same (find rules with a `forward` action whose `value === toAddress`).
  - [x] 1.2 In `src/notifier/feedback-processor.ts`, update the call site from `this.accountDb.disableForwardActions(...)` to `this.accountDb.disableRulesForwardingTo(...)`. Update the error log message to reflect that the operation disables entire rules. Add a TRACK log entry for each successfully disabled rule with `{ code: "feedback.rule_disabled_on_bounce", accountId, ruleId, bouncedAddress }`.
    - _Requirements: R0.1, R0.2, R0.3, R5.1, R5.2, R5.3, R5.4_

- [x] 2. Remove disabled-action filtering from processor
  - [x] 2.1 In `src/processor/processor.ts`, change the `staticActions` line from `rule.actions.filter((a) => !a.disabled).map(({ type, value }) => ...)` to `rule.actions.map(({ type, value }) => ({ type, ...(value !== undefined ? { value } : {}) }))`. This is safe because disabled rules are already excluded by `listEnabledRules`.
    - _Requirements: R4.1, R4.2_

- [x] 3. Remove `disabled` from types and schemas
  - [x] 3.1 Remove `disabled?: boolean` and its comment from the `RuleAction` interface in `src/types/index.ts`.
  - [x] 3.2 Remove `disabled: z.boolean().optional()` from `RuleActionSchema` in `src/api/requests.ts`.
  - [x] 3.3 Remove `disabled: z.boolean().optional()` from the `RuleAction` schema in `src/api/schemas.ts`.
    - _Requirements: R1.1, R1.2, R2.1, R3.1_

- [x] 4. Update tests
  - [x] 4.1 In `tests/processor/processor.spec.ts`, remove the "skips disabled actions" test case (or any test that asserts individual actions are skipped based on `disabled`).
  - [x] 4.2 In `tests/feedback-processor-bounce.test.ts`, update the test for bounce-triggered rule disabling: assert that `updateRule` is called with `{ status: "disabled" }` for the matched rule (not that individual actions get `disabled: true`). Assert the TRACK log is emitted with the rule ID.
  - [x] 4.3 Run `npm run test` and confirm all tests pass.
    - _Requirements: R6.1, R6.2, R6.3_

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "3.2", "3.3"] },
    { "id": 2, "tasks": ["4.1", "4.2", "4.3"] }
  ]
}
```
