# Implementation Plan: Rule Code Field

## Overview

Add user-authored JavaScript as a rule condition mechanism (`conditionType: "js"` + `code` field) and as template helper functions (`functions` array). Extends the existing rule evaluator, API schemas, and template rendering pipeline. All user code executes in the existing `user_code_executor` Lambda (QuickJS/WASM sandbox). Includes AST validation at write time, dynamic actions from rule code, Zod validation of return values, system signals for errors, and audit trail versioning.

## Tasks

- [x] 1. AST Validator and request schema extensions
  - [x] 1.1 Create the AST validator module (`src/api/ast-validator.ts`)
    - Install `acorn` as a dependency (parse JS to ESTree AST)
    - Implement `validateCodeAst(code: string): AstValidationResult` that parses code with acorn, checks the top-level expression is ArrowFunctionExpression or FunctionExpression, and walks the AST rejecting disallowed nodes (eval, Function constructor, import, require, globalThis/process/Deno/Bun access, unbounded loops)
    - Return `{ valid: true }` or `{ valid: false, error, location }` with parse error line/column
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 1.2 Extend API request schemas in `src/api/requests.ts`
    - Add `conditionType: z.enum(["json_logic", "js"]).optional()` and `code: z.string().max(10_240).optional()` to `CreateRuleRequest` and `UpdateRuleRequest`
    - Add `TemplateFunctionSchema` with `name` (regex `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`) and `code` (max 10,240 bytes)
    - Add `functions: z.array(TemplateFunctionSchema).optional()` to `CreateTemplateRequest`, `ReplaceTemplateRequest`, and `UpdateTemplateRequest`
    - _Requirements: 1.1, 2.1, 2.2, 7.1, 7.2, 7.3_

  - [x] 1.3 Write unit tests for AST validator (`tests/api/ast-validator.spec.ts`)
    - **Property 1: AST validator accept/reject correctness**
    - **Validates: Requirements 3.2, 3.4, 3.5, 3.6**
    - `it.each` table: allowed constructs (arrow fn, function expr, conditionals, logical ops, property access on signal/arc, string methods, template literals, destructuring, const/let, if/else) → accepted
    - `it.each` table: rejected constructs (eval, Function constructor, import, require, globalThis access, unbounded while/for/do) → rejected with error
    - Structural rejections: class declaration, bare statement, assignment expression → rejected
    - Syntax errors: malformed code → error with line/column location

- [x] 2. API route logic for rule code validation and persistence
  - [x] 2.1 Update rule routes in `src/api/app.ts` for conditionType/code handling
    - On CreateRule/UpdateRule: when `conditionType` is `"js"`, require `code` field present and non-empty (400 if missing)
    - When `conditionType` is `"js"`, run `validateCodeAst(code)` — return 400 with error+location on failure
    - When `conditionType` is `"json_logic"` or absent, validate `condition` as valid JSON (existing behavior), ignore `code` if provided
    - When `conditionType` is `"js"` and `code` is updated, clear `lastError` on the rule record
    - Persist `conditionType` and `code` on the Rule record
    - Include `code` and `lastError` in GET responses
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 2.3, 2.4, 2.5, 3.1, 3.3, 3.4, 6.4, 12.2, 12.3_

  - [x] 2.2 Update template routes in `src/api/app.ts` for functions field
    - On CreateTemplate/UpdateTemplate: when `functions` is provided, validate each function's `code` through `validateCodeAst` — return 400 on failure
    - Persist `functions` array on the EmailTemplate record
    - Include `functions` in GET responses
    - _Requirements: 7.1, 7.3, 7.4, 7.5, 7.6, 12.4_

  - [x] 2.3 Write API route tests for rule code and template functions (`tests/api/api.spec.ts` — extend existing)
    - POST /rules with `conditionType:"js"` + valid code → 201, AST validated
    - POST /rules with `conditionType:"js"` + no code → 400
    - POST /rules with code > 10KB → 400
    - POST /rules with invalid AST (eval call) → 400 with error location
    - PATCH /rules with new code → clears `lastError`
    - POST /rules without conditionType → succeeds (backward compat)
    - POST /templates with `functions` → 201, each function AST validated
    - POST /templates with invalid function name → 400
    - POST /templates with function code > 10KB → 400
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.5, 7.1, 7.2, 7.3, 7.4, 12.2, 12.3, 12.4_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Return value interpreter and rule evaluator enhancement
  - [x] 4.1 Create the return value interpreter (`src/processor/interpret-rule-result.ts`)
    - Export `RuleActionSchema` (Zod schema matching `RuleAction` type)
    - Export `RuleEvalResult` interface: `{ matched: boolean; dynamicActions: RuleAction[]; warnings: string[] }`
    - Implement `interpretRuleResult(raw: unknown): RuleEvalResult` with logic: null/undefined → non-matching; valid RuleAction object → matching + append; array → matching + validate each with Zod (discard invalid, collect warnings); other truthy → matching with no dynamic actions
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 4.2 Refine context preparation in `src/processor/rule-evaluator.ts`
    - Update `stripSensitive` for Signal to produce exactly: `id`, `from`, `subject`, `summary`, `spamScore`, `workflow`, `recipientAddress`, `workflowData` (strip `s3Key`, `embeddings`, `headers`, and all other fields)
    - Update `stripSensitive` for Arc to produce exactly: `id`, `labels`, `urgency`, `summary`, `workflow`, `status`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 4.3 Update `JsonLogicRuleEvaluator.evaluate()` to return `RuleEvalResult`
    - Change return type from `Promise<boolean>` to `Promise<RuleEvalResult>`
    - For JSONLogic path: wrap existing boolean result as `{ matched, dynamicActions: [], warnings: [] }`
    - For JS path: pass executor result through `interpretRuleResult`, handle errors (non-matching + annotate `lastError` + WARN log)
    - Update `RuleEvaluator` interface in `processor.ts` to match new return type
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 12.1_

  - [x] 4.4 Update `applyRules` in `src/processor/processor.ts` to merge dynamic actions
    - Consume `RuleEvalResult` from evaluator
    - Merge `dynamicActions` with rule's static `actions` when building `MatchedRuleResult`
    - Create system signal when warnings are present (invalid dynamic actions)
    - _Requirements: 5.2, 5.3, 5.5, 5.6_

  - [x] 4.5 Write unit tests for return value interpreter (`tests/processor/interpret-rule-result.spec.ts`)
    - **Property 3: Return value interpreter correctly classifies all result types**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
    - `it.each` table: null → non-matching; undefined → non-matching; valid RuleAction `{ type: "archive" }` → matching with action; array of valid actions → matching with all; array with invalid element → valid kept, invalid discarded, warning; `true` → matching, no dynamic actions; `"hello"` → matching, no dynamic actions; `{ random: "object" }` → matching, no dynamic actions; empty array → matching, no dynamic actions

  - [x] 4.6 Write unit tests for context preparation (`tests/processor/rule-evaluator.spec.ts` — extend existing)
    - **Property 2: Context preparation produces exactly the specified fields**
    - **Validates: Requirements 4.1, 4.2, 4.4**
    - `it.each` table: full Signal → output has exactly {id, from, subject, summary, spamScore, workflow, recipientAddress, workflowData}; Signal with s3Key/embeddings/headers → none in output; full Arc → output has exactly {id, labels, urgency, summary, workflow, status}

  - [x] 4.7 Write unit tests for JS rule evaluation path (`tests/processor/rule-evaluator.spec.ts` — extend existing)
    - Mocked executor returns success with truthy result → evaluator returns matched with dynamic actions
    - Mocked executor returns error (timeout) → non-matching, lastError annotated, WARN logged
    - Mocked executor returns error (runtime_error) → same behavior
    - Dynamic actions with Zod validation failure → warnings populated

- [x] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Template function execution and error handling
  - [x] 6.1 Implement template function execution in the side-effect worker
    - Locate the existing auto_draft side-effect handler (or create template renderer logic)
    - For each function in `template.functions`, invoke `UserCodeExecutorClient` with purpose `"template_function"` and the function's code
    - Provide `signal` and `arc` context using the same `stripSensitive` fields as rule code
    - Collect results as `fn.{name}` → string value in the Handlebars rendering context
    - Pass context containing `sender` (object with `name` and `address`) and `fn` (function results map)
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 6.2 Implement template function error handling
    - If any function returns non-string, null, or errors: leave email as draft (prevent auto-send)
    - Substitute empty string for failed function's value in Handlebars context (best-effort rendering)
    - Annotate `lastError` on the failed function's entry in the template record
    - Log at WARN level with template name, function name, and error details
    - Create system signal notifying user with template name, function name, and specific issue
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 6.3 Write unit tests for template function execution (`tests/processor/processor.template-functions.spec.ts` — extend existing)
    - **Property 5: Template function results map to fn.{name} in rendering context**
    - **Property 6: Any template function failure prevents auto-send**
    - **Validates: Requirements 8.3, 9.1, 9.5**
    - `it.each` table: all functions succeed → fn.* values in context, auto-send proceeds; one function returns null → draft status, empty string substituted; one function errors (timeout) → draft status, empty string, lastError annotated; non-string return → draft status, system signal created

- [x] 7. Audit trail for code changes
  - [x] 7.1 Add audit writes to rule and template code mutations in `src/api/app.ts`
    - On CreateRule with `conditionType:"js"`: write audit event with `{ before: null, after: { conditionType, code } }` before persisting
    - On UpdateRule when `code` changes: write audit event with `{ before: { conditionType: prev, code: prev }, after: { conditionType: new, code: new } }` before persisting
    - On CreateTemplate/UpdateTemplate when `functions` changes: write audit event with `{ before: prevFunctions, after: newFunctions }` before persisting
    - If audit write fails: log at WARN, proceed with resource write (best-effort)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 7.2 Write unit tests for audit integration (`tests/api/api.spec.ts` — extend existing)
    - Audit event written before resource persist (mock call ordering verification)
    - Audit event contains correct before/after code values
    - Audit failure does not block resource write (mock audit to throw, verify resource still persisted)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 8. System signal creator
  - [x] 8.1 Implement system signal creator helper
    - Create a helper (or extend existing notification mechanism) that writes a system signal to DynamoDB when user code produces invalid output
    - Accept: accountId, resourceType ("rule" | "template"), resourceName, optional functionName, issue description
    - Wire into rule evaluator (invalid dynamic actions) and template renderer (function failures)
    - _Requirements: 5.6, 9.3_

- [x] 9. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- The `user_code_executor` Lambda already exists — no changes needed there
- The existing `validate-rule-condition.ts` will be superseded by the new AST validator for JS rules; JSONLogic validation remains unchanged
- Property tests are implemented as `it.each` tables with static inputs (no fast-check/random generation per project rules)
- The `RuleEvaluator` interface change (boolean → RuleEvalResult) requires updating `applyRules` and any other consumers in the same task

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "2.2", "4.1", "4.2"] },
    { "id": 2, "tasks": ["2.3", "4.3"] },
    { "id": 3, "tasks": ["4.4", "4.5", "4.6"] },
    { "id": 4, "tasks": ["4.7", "6.1", "7.1", "8.1"] },
    { "id": 5, "tasks": ["6.2"] },
    { "id": 6, "tasks": ["6.3", "7.2"] }
  ]
}
```
