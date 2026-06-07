# Implementation Plan: Signal Classifier

## Overview

Refactor the classifier from a static-prompt LLM wrapper into a dynamic prompt builder with closed-set labels, structural prompt injection defense, Bedrock Guardrails (detect mode), and classification-output-driven embeddings. Implementation proceeds bottom-up: registry and prompt builder first, then classifier refactor, then processor integration, then guardrails infrastructure, then tests.

## Tasks

- [x] 1. Workflow registry — single source of truth
  - [x] 1.1 Create `src/classifier/workflow-registry.ts`
    - Define `WorkflowDefinition` interface: `{ name, description, fields: Array<{ name, type, required, enumValues?, notes? }> }`
    - Populate `WORKFLOW_REGISTRY` array with one entry per workflow (all 15 workflows)
    - Each entry's fields must exactly match the corresponding TypeScript interface in `src/types/index.ts`
    - Export the registry and the `WorkflowDefinition` type
    - _Requirements: 1.1, 9.1, 9.2_

  - [x] 1.2 Write prompt–type alignment regression test
    - Create `tests/classifier/registry-alignment.spec.ts`
    - Read the registry and the TypeScript source (via string parsing or import) — assert every field name, type, enum value matches
    - This test fails the build if registry and types diverge
    - _Requirements: 9.2, 9.3_

- [x] 2. Prompt builder — dynamic system prompt generation
  - [x] 2.1 Create `src/classifier/prompt-builder.ts`
    - Implement `buildSystemPrompt(registry: WorkflowDefinition[]): string`
    - Output includes: role instruction, JSON output schema, workflow sections (one per registry entry with description + field table), spam scoring rules, summary rules, label selection instruction ("select from provided list only"), confidence rules ("omit rather than guess")
    - Implement `buildUserMessage(input: ClassificationInput): string`
    - Wraps email content in `<email_content>...</email_content>` structural delimiters
    - Includes available labels as `Available labels: ["label1", "label2"]`
    - Formats body truncated to 4000 chars, relevant headers, From/To/Subject/Received
    - _Requirements: 1.1, 1.2, 1.3, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 2.2 Write unit tests for prompt builder
    - `buildSystemPrompt` includes every workflow name from registry
    - `buildSystemPrompt` includes all fields and enum values for each workflow
    - `buildUserMessage` wraps content in `<email_content>` delimiters
    - `buildUserMessage` truncates body at 4000 characters
    - `buildUserMessage` includes allowed labels array
    - `buildUserMessage` filters headers to relevant set only
    - _Requirements: 1.1, 8.2, 8.5_

- [x] 3. Checkpoint — Ensure all tests pass

- [x] 4. Classifier refactor — new input/output contract
  - [x] 4.1 Update `ClassificationInput` interface
    - Replace `textBody?: string` and `htmlBody?: string` with `body: string`
    - Add `allowedLabels: string[]`
    - _Requirements: 7.1, 8.1_

  - [x] 4.2 Refactor `SignalClassifier.classify()` to use prompt builder
    - Remove static `CLASSIFICATION_SYSTEM_PROMPT` constant
    - Call `buildSystemPrompt(WORKFLOW_REGISTRY)` for system prompt
    - Call `buildUserMessage(input)` for user message
    - _Requirements: 1.2, 1.3, 9.1_

  - [x] 4.3 Add output validation
    - Parse JSON response — on failure, log ERROR with full input + raw response, return `err()`
    - Validate `workflow ∈ WORKFLOWS` — on failure, log ERROR, return `err()`
    - Clamp `spamScore` to [0, 1]
    - Filter `labels` to subset of `allowedLabels`
    - No in-classifier retry
    - _Requirements: 2.3, 5.1, 7.3_

  - [x] 4.4 Write unit tests for output validation
    - Invalid JSON → `err()` returned
    - Unknown workflow → `err()` returned
    - SpamScore 1.5 → clamped to 1.0
    - SpamScore -0.2 → clamped to 0.0
    - Labels `["billing", "invented"]` with allowedLabels `["billing", "urgent"]` → filtered to `["billing"]`
    - _Requirements: 2.3, 5.1, 7.3_

- [x] 5. Checkpoint — Ensure all tests pass

- [x] 6. Processor integration — body resolution and sequential embed
  - [x] 6.1 Update processor to resolve body before calling classify
    - Replace `{ textBody, htmlBody }` with `{ body: stripHtml(htmlBody) ?? textBody }`
    - Fetch account labels and pass as `allowedLabels`
    - _Requirements: 7.1, 8.1_

  - [x] 6.2 Change embedding pipeline to sequential (classify → embed)
    - Remove `Promise.all([embed, classify])` pattern
    - Classify first, then build embed text from classification output
    - Implement updated `buildEmbedText(classification: ClassificationOutput): string`
    - Format: `{workflow}\n{summary}\n{key}={value}` for non-null workflowData fields
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x] 6.3 Write unit tests for updated `buildEmbedText`
    - Verify format includes workflow, summary, workflowData fields
    - Verify null/undefined fields are omitted
    - Verify output is deterministic (same input → same output)
    - Verify no raw email content in the output
    - _Requirements: 12.1, 12.4_

- [x] 7. Checkpoint — Ensure all tests pass

- [x] 8. Update classifier prompt for new workflows and fields
  - [x] 8.1 Add `events` workflow to registry
    - Add `EventsData` entry to `WORKFLOW_REGISTRY` matching the TypeScript interface
    - Include description: "Ticketed events: concerts, conferences, sports, theatre — venue + date + seats"
    - _Requirements: 3.1, 4.4_

  - [x] 8.2 Update existing workflow registry entries for enriched fields
    - TravelData: add `flightNumber`, `seatNumber`, `boardingTime` to registry
    - PaymentsData: add `paymentUrl` to registry
    - HealthcareData: add `patientName` to registry
    - JobData: add `contactName`, `contactEmail` to registry
    - _Requirements: 4.4, 9.3_

  - [x] 8.3 Fix OnboardingData prompt–type misalignment
    - Ensure registry entry matches TypeScript interface: `"welcome" | "verification" | "getting_started" | "trial_started" | "other"`
    - _Requirements: 9.2_

- [x] 9. Checkpoint — Ensure all tests pass

- [x] 10. Bedrock Guardrails — infrastructure and integration
  - [x] 10.1 Create Terraform guardrail resource in `email-catcher/infrastructure`
    - `aws_bedrock_guardrail` with Prompt Attack (HIGH, detect mode) and content filters (LOW, detect mode)
    - All filters use `input_action = "NONE"` — observe only
    - Create a published guardrail version
    - Output guardrail ID and version for the backend to reference
    - _Requirements: 8.7_

  - [x] 10.2 Wire guardrail into classifier `InvokeModel` call
    - Add `GUARDRAIL_ID` and `GUARDRAIL_VERSION` compile-time constants
    - Pass `guardrailIdentifier`, `guardrailVersion`, `trace: "ENABLED"` to `InvokeModelCommand`
    - _Requirements: 8.7_

  - [x] 10.3 Handle guardrail trace response
    - Parse guardrail trace from model response
    - On detection: log TRACK with `detectionType`, `category`, `confidence`, `signalId`, `accountId`
    - Proceed with classification output regardless
    - _Requirements: 8.7_

  - [x] 10.4 Write unit tests for guardrail trace handling
    - Mock response with guardrail detection → TRACK logged, output still returned
    - Mock response without detection → no TRACK, output returned
    - _Requirements: 8.7_

- [x] 11. Checkpoint — Ensure all tests pass

- [x] 12. LLM integration tests — `llm-tests/` directory
  - [x] 12.1 Set up `llm-tests/` directory and vitest config
    - Create `llm-tests/vitest.config.ts` (separate from main test config)
    - Add `"test:llm": "vitest run --config llm-tests/vitest.config.ts"` to package.json
    - _Requirements: 2.1, 3.1, 4.1_

  - [x] 12.2 Write representative test emails (one per workflow)
    - Static test fixtures: one email per workflow (15 total) + edge cases (spam, multilingual, ambiguous workflow)
    - Each test asserts: correct workflow, key workflowData fields present, spamScore in expected range, summary under 150 chars, labels subset of allowed set
    - _Requirements: 3.1, 4.1, 4.2, 5.1, 6.1, 7.2_

  - [x] 12.3 Add GitLab CI manual job
    - `when: manual` job in `.gitlab-ci.yml`
    - Runs `npm run test:llm`
    - Uses OIDC for AWS credentials (same pattern as deploy jobs)
    - `allow_failure: true` — not a merge gate
    - _Requirements: 2.1_

- [x] 13. Final checkpoint — Ensure all tests pass (unit only — LLM tests are manual)

## Notes

- Type changes (new `events` workflow, enriched fields) are already committed and tests pass
- The workflow registry is the single source of truth — prompt and types must both match it
- Guardrails infrastructure (task 10.1) is in a separate repo (`email-catcher/infrastructure`) and may need a separate MR
- LLM tests (task 12) run against the deployed model and are non-deterministic — they validate quality, not correctness
- Temperature should be set to 0 in the `InvokeModel` call for maximum determinism

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["4.1", "4.2"] },
    { "id": 4, "tasks": ["4.3", "4.4"] },
    { "id": 5, "tasks": ["6.1", "6.2"] },
    { "id": 6, "tasks": ["6.3", "8.1", "8.2", "8.3"] },
    { "id": 7, "tasks": ["10.1"] },
    { "id": 8, "tasks": ["10.2", "10.3"] },
    { "id": 9, "tasks": ["10.4", "12.1"] },
    { "id": 10, "tasks": ["12.2", "12.3"] }
  ]
}
```
