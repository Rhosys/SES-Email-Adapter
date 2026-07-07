# Implementation Plan: Daily Healthcheck

## Overview

Implement a daily production integration test that validates the full email-catcher pipeline end-to-end. The implementation is split into prerequisite processor changes (A–D) that must be completed first in order, followed by the main healthcheck feature tasks (1–8). Each prerequisite unblocks the next — multi-row embeddings enables `hasEmbedding`, test detection fix prevents false positives, assign_workflow propagation ensures signal workflow correctness, and SYSTEM account override ensures deterministic classification.

## Tasks

- [x] 1. Prerequisite A: Multi-row embeddings in Aurora pgvector
  - [x] 1.1 Update Aurora schema and processor INSERT logic
    - Add `signalId` column to `thread_embeddings` unique constraint (or switch to serial PK)
    - In `processor.ts` `executeAuroraUpserts`, replace `onConflictDoUpdate` with plain INSERT including `signalId`
    - Remove the ON CONFLICT DO UPDATE clause entirely
    - _Requirements: A.1, A.2_
  - [x] 1.2 Update ThreadMatcher similarity search to deduplicate by threadId
    - Change `findMatch` query to use `DISTINCT ON (thread_id)` with `ORDER BY thread_id, embedding <=> $3::vector`
    - Ensure the closest embedding per thread is returned
    - _Requirements: A.3_
  - [x] 1.3 Add `hasEmbedding(threadId)` method to ThreadMatcher
    - Query `thread_embeddings` for existence of at least one row with the given threadId
    - Return boolean
    - _Requirements: A.4, A.5_
  - [x] 1.4 Write unit tests for multi-row embedding changes
    - Test that `hasEmbedding` returns true when rows exist and false when none exist
    - Test that `findMatch` deduplicates by threadId
    - _Requirements: A.3, A.4_

- [x] 2. Prerequisite B: Test detection fix — eTLD+1 comparison
  - [x] 2.1 Replace `getDomainByName` with `listDomains` + eTLD+1 comparison in processor
    - Fetch all domains for the account via `listDomains`
    - Compute `getETLD1(domain.domain)` for each registered domain
    - Check if `getETLD1(sender)` matches any computed eTLD+1 value
    - Remove the single-lookup `getDomainByName(accountId, getETLD1(sender))` approach
    - _Requirements: B.1, B.2, B.3, B.4_
  - [x] 2.2 Write unit tests for eTLD+1 comparison logic
    - Test subdomain matching (e.g. `mail.example.com` matches `example.com`)
    - Test non-matching domains
    - _Requirements: B.3, B.4_

- [x] 3. Prerequisite C: assign_workflow rule action updates signal workflow
  - [x] 3.1 Propagate assign_workflow to signal data after rules evaluation
    - After `applyRules` completes, find the last `assign_workflow` action that fired
    - If found, update `signalShell.data.workflow` and `signalShell.data.workflowData`
    - _Requirements: C.1, C.2, C.3_
  - [x] 3.2 Write unit tests for assign_workflow propagation
    - Test that signal.data.workflow reflects final assign_workflow action
    - Test that thread workflow is still updated during rule evaluation (existing behavior)
    - Test last-wins semantics when multiple assign_workflow actions fire
    - _Requirements: C.1, C.3_

- [x] 4. Prerequisite D: SYSTEM account workflow override
  - [x] 4.1 Add SYSTEM account workflow override in processor
    - After the `isTestEmail` block, check `isSystemAccount(accountId)`
    - If true, set `classificationOutput.workflow = "healthcheck"` and `classificationOutput.workflowData = { workflow: "healthcheck" }`
    - Must fire before `buildSignal` so the stored signal has workflow `healthcheck`
    - _Requirements: D.1, D.2, D.3_
  - [x] 4.2 Write unit tests for SYSTEM account override
    - Test that SYSTEM account always gets workflow `healthcheck` regardless of classifier output
    - Test that override fires after isTestEmail block
    - _Requirements: D.1, D.2_

- [x] 5. Prerequisite E: Refactor duration conversion to use luxon
  - [x] 5.1 Replace `DURATION_SECONDS` lookup in `src/processor/retention.ts` with luxon
    - Use `Duration.fromISO(duration).as('seconds')` instead of manual map
    - Handle `"Infinity"` as a special case (return null) before calling luxon
    - Remove the `RetentionDuration` closed union type — accept any valid ISO 8601 duration string (+ `"Infinity"`)
    - _Requirements: E.1, E.2, E.3_
  - [x] 5.2 Replace `retentionDurationToSeconds` in `src/embedding/retention-tier.ts` with luxon
    - Same pattern: `Duration.fromISO(duration).as('seconds')`
    - _Requirements: E.4_
  - [x] 5.3 Replace `DURATION_MS` lookup in `site-ui/src/lib/retention.ts` with luxon
    - Use `Duration.fromISO(duration).toMillis()` instead of manual map
    - Handle `"Infinity"` as a special case (return null) before calling luxon
    - _Requirements: E.5_
  - [x] 5.4 Replace inline `90 * 24 * 60 * 60` hardcoded TTLs in `src/processor/processor.ts`
    - Use `Duration.fromISO("P90D").as('seconds')` or equivalent
    - _Requirements: E.6_
  - [x] 5.5 Write unit tests for luxon-based duration conversion
    - Test that `P7D`, `P1M`, `P1Y`, `P5Y`, `P100Y` all produce correct seconds
    - Test that `Infinity` returns null
    - Test that invalid durations throw or return a sensible error
    - _Requirements: E.1, E.3_

- [x] 6. Checkpoint — Ensure all prerequisite tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Add healthcheck workflow type and classifier prompt
  - [x] 7.1 Add `"healthcheck"` to WORKFLOWS array and HealthcheckData interface
    - Add `"healthcheck"` to the `WORKFLOWS` const array in `src/types/index.ts`
    - Add `HealthcheckData` interface: `{ workflow: "healthcheck" }`
    - Add to the WorkflowData union type
    - _Requirements: 7.1_
  - [x] 7.2 Update classifier prompt with healthcheck workflow description
    - Add healthcheck workflow to the classifier prompt: "System-generated pipeline validation emails — daily automated checks"
    - _Requirements: 7.2, 7.3_
  - [x] 7.3 Write unit tests for workflow type
    - Test that `"healthcheck"` is a valid workflow value
    - Test that SR-18 (pong) does not match workflow `"healthcheck"`
    - _Requirements: 7.4_

- [x] 8. Create SystemAccountDb class
  - [x] 8.1 Implement SystemAccountDb with hardcoded SYSTEM account configuration
    - Create `src/database/system-account-db.ts`
    - Export `SYSTEM_ACCOUNT_ID = "SYSTEM"` constant
    - Export `isSystemAccount(accountId: string): boolean` guard function
    - Implement `getAccount()` returning Account with id SYSTEM, allow_all policy, no digest, billing plan Internal
    - Implement `listEnabledRules()` returning filtered SYSTEM_RULES
    - Implement `getDomainByName()` returning domain for MAIL_DOMAIN
    - Implement `getDomainOwner()` returning SYSTEM account for MAIL_DOMAIN
    - Implement `getAliasByGlobalAddress()` resolving `healthcheck@{MAIL_DOMAIN}` to SYSTEM
    - Implement `listDomains()` returning the MAIL_DOMAIN domain
    - All other lookups return empty/default values
    - _Requirements: 6.1, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_
  - [x] 8.2 Write unit tests for SystemAccountDb
    - Test getAccount returns expected shape with Internal billing plan
    - Test listEnabledRules returns system rules
    - Test getDomainByName returns domain for MAIL_DOMAIN, null for others
    - Test getAliasByGlobalAddress resolves healthcheck address
    - Test other methods return empty/default
    - _Requirements: 6.4, 6.5, 6.6, 6.8, 6.9_

- [x] 9. Wire AccountDatabase delegation to SystemAccountDb
  - [x] 9.1 Add SystemAccountDb delegation to AccountDatabase methods
    - Add `private readonly systemDb = new SystemAccountDb(process.env["MAIL_DOMAIN"] ?? "")` field
    - At start of `getAccount`, `listEnabledRules`, and other accountId-accepting methods: if `isSystemAccount(accountId)`, return `this.systemDb.*()` result
    - For `getAliasByGlobalAddress` and `getDomainOwner`: check SystemAccountDb first, fall through to DynamoDB if null
    - _Requirements: 6.2, 6.3, 6.10_
  - [x] 9.2 Write unit tests for AccountDatabase delegation
    - Test that SYSTEM accountId short-circuits to SystemAccountDb without DynamoDB
    - Test that non-SYSTEM accounts still use DynamoDB
    - **Property 5: SystemAccountDb delegation**
    - **Validates: Requirements 6.2, 6.9**
    - _Requirements: 6.2, 6.10_

- [x] 10. Create HealthcheckJob class
  - [x] 10.1 Implement HealthcheckJob with validate and send phases
    - Create `src/jobs/healthcheck-job.ts`
    - Implement `HealthcheckJobDeps` interface (threadDb, emailService, searchDatabase, mailDomain, logger)
    - Implement `buildMessageId(date: string)` returning `healthcheck-{date}@{mailDomain}`
    - Implement `validate(date)`: query GSI3 for yesterday's signal, check threadId/workflow/embedding
    - Implement `send(today)`: render MJML template, send via EmailService with custom Message-ID header
    - Implement `run()`: call validate(yesterday) then send(today), never throw
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9, 4.10, 5.1, 5.2, 5.3, 10.1, 10.2, 10.3, 10.4_
  - [x] 10.2 Write property tests for HealthcheckJob (parameterized example-based)
    - **Property 2: Deterministic Message-ID generation** — verify format `healthcheck-YYYY-MM-DD@{MAIL_DOMAIN}` for multiple dates, same output for same date
    - **Validates: Requirements 5.1, 5.3**
  - [x] 10.3 Write property tests for graceful degradation
    - **Property 4: Graceful degradation — send always executes** — verify send phase runs after: validation success, validation failure, signal not found, DynamoDB error, Aurora error
    - **Validates: Requirements 4.1, 10.1, 10.2, 10.3, 10.4**
  - [x] 10.4 Write property tests for validation failure detection
    - **Property 3: Validation failure detection** — verify correct log codes for: missing threadId, wrong workflow, missing embedding, combinations
    - **Validates: Requirements 3.3, 3.4, 3.5, 3.7**

- [x] 11. Create healthcheck.mjml email template
  - [x] 11.1 Create MJML template for healthcheck email
    - Create `email-templates/healthcheck.mjml`
    - Include: description of what the email is and why it exists, who it is for
    - Include: logging invocation ID, container ID, timestamp, expected Message-ID, run date
    - Include: validation results from today's run
    - Include sufficient context that the LLM classifier assigns workflow `healthcheck`
    - Use existing `_footer.mjml` partial
    - Implement `renderHealthcheckEmail(templateData)` function in healthcheck-job.ts (or co-located)
    - _Requirements: 4.7, 4.8, 7.2_

- [x] 12. Handler routing changes
  - [x] 12.1 Update EventBridge routing in handler.ts for healthcheck and unknown rules
    - Add `-healthcheck` suffix match routing to `healthcheckJob.run()`
    - Add fallback: if rule name doesn't match `-domain-health` or `-healthcheck`, log error with code `handler.eventbridge.unknown_rule` and return
    - Handle empty/missing resources array — log error and return
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 12.2 Write property tests for handler routing
    - **Property 1: Unrecognized EventBridge rules are rejected** — verify unknown suffixes log error and don't invoke jobs, empty resources logs error
    - **Validates: Requirements 2.2, 2.3**

- [x] 13. Wire HealthcheckJob in handler.ts
  - [x] 13.1 Instantiate HealthcheckJob and connect to routing
    - Import HealthcheckJob in handler.ts
    - Instantiate with deps: threadDb, emailService, searchDatabase (hasEmbedding), MAIL_DOMAIN, logger
    - Connect to the `-healthcheck` route added in 11.1
    - _Requirements: 2.1, 8.1_

- [x] 14. Checkpoint — Ensure all feature tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Terraform resources for EventBridge scheduling
  - [x] 15.1 Add EventBridge rule, target, and permission to storage.tf
    - Add `aws_cloudwatch_event_rule.healthcheck` with `cron(0 6 * * ? *)` and name `${var.service_name}-healthcheck`
    - Add `aws_cloudwatch_event_target.healthcheck` targeting the production Lambda alias
    - Add `aws_lambda_permission.healthcheck_eventbridge` granting events.amazonaws.com invoke permission
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 8.4, 8.5_

- [x] 16. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Prerequisites A–E must be completed in order before main feature tasks
- Checkpoints ensure incremental validation
- Property tests are implemented as parameterized example-based tests (no fast-check per tech stack policy)
- Unit tests validate specific examples and edge cases
- The SYSTEM account's signals/threads are stored normally in DynamoDB — only account-config lookups are short-circuited
- No new environment variables — everything derives from existing MAIL_DOMAIN
- Retention (7-day TTL) is automatic via the SYSTEM account's `retentionDuration: "P7D"` config (valid after prerequisite E refactors duration handling to luxon)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4", "2.1"] },
    { "id": 3, "tasks": ["2.2", "3.1"] },
    { "id": 4, "tasks": ["3.2", "4.1"] },
    { "id": 5, "tasks": ["4.2", "5.1"] },
    { "id": 6, "tasks": ["5.2", "5.3", "5.4"] },
    { "id": 7, "tasks": ["5.5", "7.1"] },
    { "id": 8, "tasks": ["7.2", "7.3", "8.1"] },
    { "id": 9, "tasks": ["8.2", "9.1"] },
    { "id": 10, "tasks": ["9.2", "10.1", "11.1"] },
    { "id": 11, "tasks": ["10.2", "10.3", "10.4", "12.1"] },
    { "id": 12, "tasks": ["12.2", "13.1"] },
    { "id": 13, "tasks": ["15.1"] }
  ]
}
```
