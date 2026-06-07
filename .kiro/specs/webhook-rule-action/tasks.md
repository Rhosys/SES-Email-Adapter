# Implementation Plan: Webhook Rule Action

## Overview

Add a `webhook` action type to the rule engine. Implementation proceeds bottom-up: types and billing handler first, then the webhook module (payload builder + delivery), then API validation, then processor integration, then tests, and finally the TODO-UI update.

## Tasks

- [x] 1. Add `webhook` to RuleActionType enum and Zod schema
  - [x] 1.1 Add `webhook` to `RULE_ACTION_TYPES` in `src/types/index.ts` and to the `RuleActionType` z.enum in `src/api/requests.ts`
    - Append `"webhook"` to both arrays
    - _Requirements: 1.1_

- [x] 2. Implement BillingHandler
  - [x] 2.1 Create `src/billing/billing-handler.ts` with `BillingHandler` class and `Feature` type
    - Static `PLAN_FEATURES` mapping: Trial/Free → no webhook; Beta/Paid/Lifetime/Premium/Internal → webhook
    - `isFeatureEnabled(accountPlan: BillingPlan, feature: Feature): boolean`
    - Import `BillingPlan` from `src/embedding/retention-tier.ts`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [x] 2.2 Write unit tests for BillingHandler (`tests/billing/billing-handler.spec.ts`)
    - `it.each` over all plan × feature combinations verifying correct boolean
    - _Requirements: 6.1, 6.2_

- [x] 3. Implement webhook payload builder and delivery
  - [x] 3.1 Create `src/processor/webhook.ts` with `WebhookPayload` interface, `buildWebhookPayload()`, `WebhookDeliveryResult` interface, and `deliverWebhook()`
    - `buildWebhookPayload(signal, arc)` projects only the allowed fields (id, arcId, receivedAt, from, to, cc, replyTo, subject, alias, workflow, workflowData, summary, labels)
    - `deliverWebhook(url, payload, logger)` does HTTP POST with 5s AbortController timeout, logs failures at TRACK level
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 5.1, 5.2, 5.3_
  - [x] 3.2 Write unit tests for `buildWebhookPayload` (`tests/processor/webhook.spec.ts`)
    - Verify correct field projection from signal + arc
    - Verify internal fields (s3Key, embeddings, matchedRules, etc.) are absent
    - Verify labels come from arc, empty array when arc is null
    - _Requirements: 2.2, 2.3_
  - [x] 3.3 Write unit tests for `deliverWebhook` (`tests/processor/webhook.spec.ts`)
    - Mock `fetch`: success (200), non-2xx (500), timeout (abort), network error
    - Verify TRACK-level logging on failure
    - Verify Content-Type header is application/json
    - _Requirements: 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4_

- [x] 4. Implement webhook config validation
  - [x] 4.1 Create `src/api/validate-webhook-config.ts` with `validateWebhookConfig()` and `parseWebhookConfig()`
    - Validates: value present, valid JSON, is object, has non-empty url string, url is http/https
    - Returns human-readable error string or null
    - `parseWebhookConfig` wraps in neverthrow Result
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [x] 4.2 Write unit tests for `validateWebhookConfig` (`tests/api/validate-webhook-config.spec.ts`)
    - `it.each` table: missing value, invalid JSON, not an object, missing url, empty url, ftp protocol, valid https, valid http
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 5. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Integrate webhook validation in API rule routes
  - [x] 6.1 Add `validateWebhookActions` helper in `src/api/app.ts` and call it in rule create and rule update routes (after `validateForwardTargets`)
    - For each webhook action: validate config via `validateWebhookConfig`
    - If any webhook action exists: check `billingHandler.isFeatureEnabled(plan, "webhook")`; reject with `PLAN_FEATURE_REQUIRED` if not enabled
    - Wire `BillingHandler` instance into `createApp` options
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 6.5_
  - [x] 6.2 Write integration tests for API webhook validation (`tests/api/webhook-rule-validation.spec.ts`)
    - Valid webhook action accepted on paid plan
    - Invalid config rejected with 400
    - Plan-gated rejection for free plan
    - _Requirements: 4.1, 6.5_

- [x] 7. Integrate webhook delivery in processSideEffect
  - [x] 7.1 Add webhook execution block at the end of `processSideEffect()` in `src/processor/processor.ts`
    - Extract webhook actions from matched rules
    - Check billing plan via `billingHandler.isFeatureEnabled`; skip with INFO log if disabled
    - Build payload via `buildWebhookPayload`
    - For each webhook action: parse config, deliver webhook (fire-and-forget)
    - Wire `BillingHandler` into `SignalProcessorOptions`
    - _Requirements: 2.1, 2.7, 3.4, 6.6_
  - [x] 7.2 Write integration tests for webhook in processSideEffect (`tests/processor/webhook-side-effect.spec.ts`)
    - Webhook fires after other side-effects
    - Webhook skipped when plan-gated (INFO log)
    - Multiple webhook actions on same signal all fire
    - Invalid config at processing time logged and skipped
    - _Requirements: 2.7, 3.4, 6.6_

- [x] 8. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Update TODO-UI.md
  - [x] 9.1 Add webhook rule action entry to `TODO-UI.md` under Website section
    - Rule editor: webhook action type in dropdown
    - URL input field with validation feedback
    - Delivery status display (future: show last delivery attempt result)
    - _Requirements: 7.1_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- No property-based testing — all tests use static deterministic inputs with `it.each` tables
- Each task gets its own commit with `🟣` prefix
- `npm test` must pass after each task before committing
- `BillingPlan` type already exists in `src/embedding/retention-tier.ts` — reuse it

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "4.2"] },
    { "id": 3, "tasks": ["3.2", "3.3"] },
    { "id": 4, "tasks": ["6.1"] },
    { "id": 5, "tasks": ["6.2", "7.1"] },
    { "id": 6, "tasks": ["7.2"] },
    { "id": 7, "tasks": ["9.1"] }
  ]
}
```
