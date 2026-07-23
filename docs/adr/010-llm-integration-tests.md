# ADR 010: LLM Integration Tests for Classifier Output Validation

## Status

Accepted

## Context

In July 2026, all RSVP schedule creation tests failed because the `classifier` mock in the test harness was missing the `actions: []` field. The processor's `assignSystemLabels` function accessed `ctx.actions.length` on the `undefined` value, throwing a TypeError. This error was caught by the top-level exception handler and silently returned as `err(...)`, so `schedulerClient.createFollowup` was never called — producing the misleading symptom "expected 1, got 0".

The root cause: **mock-only tests cannot verify that a dependency's return type is complete.** TypeScript's type system doesn't enforce mock shapes when they pass through `vi.fn()` / `as unknown as T`. A missing field compiles fine but crashes at runtime.

## Decision

Maintain a suite of live Bedrock integration tests (`llm-tests/classify.spec.ts`) that call the real classifier model with no mocks. These tests validate:

1. Every field in `ClassificationOutput` is present and correctly shaped
2. The `actions` array contains properly validated URLs with text labels
3. Each workflow in the registry produces the expected `workflowData` shape
4. Edge cases (spam, multilingual, ambiguous) produce valid output

The tests run via `npm run test:llm-bedrock-classifier` and require real AWS credentials with `bedrock:InvokeModel` permission. They are excluded from the main `npm test` gate (which runs unit tests only) because they are slow, non-deterministic, and cost money per invocation.

## Consequences

- Any change to `ClassificationOutput` must be accompanied by a corresponding test in `llm-tests/classify.spec.ts` (enforced by a TSDoc comment on the interface).
- The LLM tests are a manual validation step — not part of CI's pre-merge gate. Run them when changing classifier logic, prompt templates, or output schema.
- The main vitest config explicitly excludes `llm-tests/` and documents why.
