# Design: Remove RuleAction disabled field

## Overview

Replace per-action `disabled: true` with whole-rule disable on permanent forward bounce. Then remove the `disabled` field entirely from the codebase.

## Current Behavior

1. Feedback processor receives permanent bounce for a forwarded email
2. Calls `disableForwardActions(accountId, bouncedAddress)`
3. That method iterates all rules, finds forward actions targeting the bounced address, sets `disabled: true` on those specific actions
4. Processor's `applyRules` filters out actions where `a.disabled === true` — the rule still fires, but the disabled action is skipped

**Problem:** A rule with 3 actions (assign_label + forward + set_urgency) continues to fire with 2 actions. The user sees the rule as "enabled" but forwarding silently stops. This is confusing — the user can't tell why their forward stopped working without inspecting the raw action objects.

## New Behavior

1. Feedback processor receives permanent bounce for a forwarded email
2. Calls refactored `disableRulesForwardingTo(accountId, bouncedAddress)`
3. That method iterates all rules, finds rules with a forward action targeting the bounced address, sets `rule.status = "disabled"` on the entire rule
4. `listEnabledRules` already filters `r.status === "enabled"` — disabled rules are never evaluated

**Result:** The rule is visibly disabled in the UI. The user can see it's disabled, investigate why, fix the target, and re-enable. No hidden partial execution.

## File Changes

| File | Change |
|------|--------|
| `src/database/account-database.ts` | Refactor `disableForwardActions` → `disableRulesForwardingTo`: find rules with matching forward action, call `updateRule(accountId, ruleId, { status: "disabled" })` for each |
| `src/notifier/feedback-processor.ts` | Update call site to use renamed method. Update log message. |
| `src/types/index.ts` | Remove `disabled?: boolean` from `RuleAction` interface |
| `src/api/requests.ts` | Remove `disabled: z.boolean().optional()` from `RuleActionSchema` |
| `src/api/schemas.ts` | Remove `disabled: z.boolean().optional()` from `RuleAction` response schema |
| `src/processor/processor.ts` | Remove `.filter((a) => !a.disabled)` from static actions line |

## Data Migration

None. Existing DDB rule documents with `disabled: true` on actions:
- The field is ignored by TypeScript (removed from interface)
- Stripped by Zod `.parse()` on API responses (no longer in schema)
- Never written again

The affected rules may still be `status: "enabled"` with stale `disabled: true` on actions. After this change, those actions will execute again. This is acceptable because:
- The suppression list (`SuppressedAddress`) already records the bounce
- Future work (forwarding targets) will provide the permanent solution
- In practice, very few rules have `disabled: true` actions today

## Execution Order

The order matters: refactor the bounce handler first (R0, R5), then remove the field (R1–4). If we remove the field first, the existing `disableForwardActions` breaks at compile time.

1. Refactor `disableForwardActions` → disables whole rule (R0, R5)
2. Remove `.filter((a) => !a.disabled)` from processor (R4)
3. Remove `disabled` from type + schemas (R1, R2, R3)
4. Update tests (R6)
