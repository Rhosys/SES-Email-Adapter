# Implementation Plan: Spam Score to Tags

## Overview

Cross-cutting replacement of numeric `spamScore` with internal `tags: string[]`. Tags are never exposed externally. Implementation proceeds bottom-up: shared constants → types → classifier → filter → processor → rule evaluator → API → tests. Each step compiles before moving to the next.

## Tasks

- [ ] 1. Create tag vocabulary constant and update types
  - [ ] 1.1 Create `src/classifier/tags.ts` with `SPAM_TAGS` constant array and `SpamTag` type
    - Lowercase alphanumeric + hyphens, 2–40 chars each
    - _Requirements: 2.3, 2.6_
  - [ ] 1.2 Update `SystemLabel` union type in `src/types/index.ts`
    - Remove `"system:spam:high"` and `"system:spam:medium"`
    - Add `"system:spam"`
    - _Requirements: 11.1, 11.2_
  - [ ] 1.3 Update `EmailSignalData` in `src/types/index.ts`
    - Remove `spamScore: number`
    - Add `tags: string[]`
    - _Requirements: 6.1, 6.2_
  - [ ] 1.4 Update `Alias` and `AccountFilteringConfig` in `src/types/index.ts`
    - Remove `spamScoreThreshold` from both interfaces
    - _Requirements: 5.1, 5.2_
  - [ ] 1.5 Update `WORKFLOWS` constant comment in `src/types/index.ts`
    - Replace `Signal.spamScore (0–1)` with `Signal.data.tags` reference
    - Keep example and rationale, update wording
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [ ] 2. Update classifier and prompt builder
  - [ ] 2.1 Update `ClassificationOutput` interface in `src/classifier/classifier.ts`
    - Remove `spamScore: number`
    - Add `tags: string[]`
    - Remove `spamScore` clamping logic in `classify()`
    - Add tag validation: filter to `SPAM_TAGS` vocabulary, enforce max 10, discard invalid format
    - **Log TRACK for each unknown tag** returned by LLM (potential new tag discovery)
    - Handle missing `tags` in LLM response as `[]`
    - Discard `spamScore` field if LLM returns it
    - _Requirements: 1.1, 1.4, 2.1, 2.4, 2.5, 2.6_
  - [ ] 2.2 Update `buildSystemPrompt()` in `src/classifier/prompt-builder.ts`
    - Remove `"spamScore"` from JSON output schema
    - Add `"tags"` to JSON output schema
    - Remove "Spam Scoring" section entirely
    - Add "Tags" section with vocabulary from `SPAM_TAGS` constant
    - _Requirements: 1.2, 1.3, 2.2, 2.3_

- [ ] 3. Update filter and system rules
  - [ ] 3.1 Update `src/processor/filter.ts`
    - Remove `DEFAULT_SPAM_SCORE_THRESHOLD` export
    - Replace `spamScore` and `spamScoreThreshold` in `SystemLabelContext` with `tags: string[]`
    - Replace spam label logic: `tags.length > 0` → `"system:spam"`, else no spam label
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.3, 5.4_
  - [ ] 3.2 Update `src/processor/system-rules.ts`
    - Remove SR-04 (`system:spam:high`) and SR-06 (`system:spam:medium`)
    - Add single rule at priority 400: condition `in_("system:spam")`, action `quarantine_hidden`
    - _Requirements: 4.1, 4.2, 4.3_

- [ ] 4. Update processor
  - [ ] 4.1 Update `src/processor/processor.ts` — signal data construction
    - Replace `spamScore: classification.spamScore` with `tags: classification.tags.slice(0, 50)`
    - Remove `spamScoreThreshold` resolution logic (alias → account → default fallback)
    - Remove `DEFAULT_SPAM_SCORE_THRESHOLD` import
    - _Requirements: 6.3, 6.5_
  - [ ] 4.2 Update `src/processor/processor.ts` — system label context
    - Pass `tags: classificationOutput.tags` to `assignSystemLabels()` instead of `spamScore`/`spamScoreThreshold`
    - _Requirements: 3.4_
  - [ ] 4.3 Update `src/processor/processor.ts` — reputation calls
    - At each `updateGlobalReputation` call site, change `wasSpam` from score-based to disposition-based:
      - Early sender block → `wasSpam: true`
      - Post-classify sender block → `wasSpam: true`
      - Rule-matched block → `wasSpam: true`
      - Rule-matched quarantine → `wasSpam: true`
      - Normal delivery (end of processing) → `wasSpam: false`
    - _Requirements: 8.1, 8.2, 8.4, 8.5_

- [ ] 5. Update rule evaluator
  - [ ] 5.1 Update `src/processor/rule-evaluator.ts`
    - Remove `spamScore` from `StrippedSignal` pick type
    - Do NOT add `tags` — internal-only
    - Update `stripSignalForUserCode()` to remove `spamScore` line
    - _Requirements: 7.1, 7.2, 7.3_

- [ ] 6. Update API layer (removal only)
  - [ ] 6.1 Update `src/api/schemas.ts`
    - Remove `spamScore` from `InboundEmailSignalData` schema
    - Remove `spamScoreThreshold` from `Alias` schema
    - Remove `spamScoreThreshold` from `AccountFilteringConfig` schema
    - Do NOT add `tags`
    - _Requirements: 9.1, 9.2, 9.5, 5.5_
  - [ ] 6.2 Update `src/api/transform.ts`
    - Remove `spamScore` from signal data transform
    - Remove `spamScoreThreshold` spread from alias transform
    - Do NOT add `tags`
    - _Requirements: 9.3, 9.4, 5.6_
  - [ ] 6.3 Grep for any remaining `spamScore`/`spamScoreThreshold` references in API request handlers
    - _Requirements: 5.5, 9.2_

- [ ] 7. Checkpoint — compile check
  - Run `npm run test` to verify type-checking passes and no stale references remain
  - Grep codebase for `spamScore`, `spamScoreThreshold`, `system:spam:high`, `system:spam:medium` — zero results expected in src/
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Update tests
  - [ ] 8.1 Update `tests/processor/filter.spec.ts`
    - Replace `spamScore`/`spamScoreThreshold` in test context with `tags`
    - Test: tags non-empty → `system:spam` label emitted
    - Test: tags empty → no spam label
    - Remove tests for `system:spam:high` and `system:spam:medium`
    - Remove `DEFAULT_SPAM_SCORE_THRESHOLD` import
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ] 8.2 Update or create classifier tests
    - Test: unknown tags filtered out AND TRACK logged
    - Test: empty tags when email has no spam attributes
    - Test: max 10 tags enforced
    - Test: invalid format tags (uppercase, special chars, too short/long) discarded
    - Test: `spamScore` in LLM response is discarded from output
    - _Requirements: 1.4, 2.1, 2.4, 2.5, 2.6_
  - [ ] 8.3 Update system-rules tests (if any reference old spam rules)
    - Verify single `system:spam` → `quarantine_hidden` rule exists at priority 400
    - _Requirements: 4.1, 4.2, 4.3_
  - [ ] 8.4 Update rule-evaluator tests
    - Verify stripped signal excludes `spamScore`
    - Verify stripped signal excludes `tags`
    - _Requirements: 7.1, 7.2_
  - [ ] 8.5 Update any remaining test files referencing `spamScore` or `spamScoreThreshold`
    - Grep test directory for stale references and fix
    - _Requirements: 11.3_

- [ ] 9. Final checkpoint
  - Run `npm run test` — full type-check + test suite must pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Frontend changes (Requirement 10) are out of scope for this backend repo — tracked separately
- No database migration needed: DynamoDB is schemaless, read layer defaults missing `tags` to `[]`
- `GlobalSenderReputation` interface is unchanged — `spamCount` stays, semantics shift to disposition-based
- `ProcessingDatabase.updateGlobalReputation` signature is unchanged — `wasSpam` stays, logic change is in Processor call sites
- Tags are NEVER exposed externally (API, rule evaluator, frontend)
- The TypeScript compiler is the primary correctness gate: removing `spamScore` from interfaces forces all stale references to fail compilation
- Each task compiles incrementally — task 7 is the checkpoint confirming zero type errors before updating tests
