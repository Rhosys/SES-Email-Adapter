# Requirements Document

## Introduction

Daily production integration test that exercises the full email-catcher pipeline end-to-end. Every morning, the system validates that yesterday's healthcheck email was fully processed (signal exists, has a threadId, was classified, has an embedding indexed in Aurora pgvector), then sends today's test email through the live pipeline (SES receive → S3 → Lambda → MIME parse → classify → embed → Aurora pgvector upsert). Results are logged via the existing structured logger — no external notifications.

## Glossary

- **Healthcheck_Job**: The job class that validates yesterday's healthcheck signal and sends today's test email. Follows the existing DomainHealthJob pattern.
- **Signal**: A DynamoDB record representing a processed inbound email, stored in the signals table with a GSI3 index keyed by email Message-ID.
- **Healthcheck_Email**: A test email sent via SES to `healthcheck@platform.email.rhosys.cloud` with a deterministic Message-ID format (`healthcheck-YYYY-MM-DD@platform.email.rhosys.cloud`).
- **Pipeline**: The full processing chain: SES receive → S3 storage → Lambda invocation → MIME parse → LLM classify → Bedrock embed → Aurora pgvector upsert.
- **Validation**: The process of confirming that a previously sent healthcheck email was fully processed through every stage of the pipeline.
- **EventBridge_Rule**: An AWS EventBridge scheduled rule that triggers the Lambda daily.
- **Logger**: The structured logging interface with `info` (success), `track` (failure requiring investigation), and `error` (immediate attention) levels.
- **GSI3**: Global Secondary Index on the signals DynamoDB table, keyed by `ACCT#{accountId}#MSGID#{messageId}`, enabling lookup of signals by email Message-ID.
- **Date_Identifier**: ISO date in format `YYYY-MM-DD` (e.g. `2025-07-07`) used to construct the deterministic Message-ID.
- **SYSTEM_ACCOUNT**: A hardcoded account configuration with ID `SYSTEM`, used by the healthcheck pipeline. Not stored in DynamoDB — all account lookups for this ID are short-circuited in code and return a static configuration.

## Requirements

### Prerequisite A: Multi-row Embeddings in Aurora pgvector

**User Story:** As a developer, I want each signal's embedding stored as a separate row in Aurora pgvector, so that thread matching considers the full semantic breadth of a thread rather than only the latest signal.

#### Acceptance Criteria

1. THE `thread_embeddings` table schema SHALL allow multiple rows per `(threadId, accountId, recipientAddress)` by adding `signalId` to the unique constraint (or using a serial/UUID PK)
2. THE processor's `executeAuroraUpserts` SHALL INSERT a new row per signal instead of upserting (ON CONFLICT DO UPDATE removed)
3. THE `ThreadMatcher.findMatch` similarity search SHALL return the closest match across all rows for a thread, deduplicated by threadId (e.g. `DISTINCT ON (thread_id) ORDER BY thread_id, distance`)
4. THE `ThreadMatcher.hasEmbedding(threadId)` method SHALL check for existence of at least one row for the given threadId
5. EXISTING embeddings in Aurora SHALL remain valid — no migration needed, new rows accumulate alongside old ones

### Prerequisite B: Test Detection Fix — eTLD+1 Comparison

**User Story:** As a developer, I want test detection to correctly identify account-owner emails even when domains are registered as subdomains, by comparing eTLD+1 of sender against eTLD+1 of each registered domain.

#### Acceptance Criteria

1. THE test detection logic SHALL fetch all domains for the account (via `listDomains` or equivalent)
2. THE test detection logic SHALL compute `getETLD1(domain.domain)` for each registered domain
3. THE test detection logic SHALL check if `getETLD1(sender)` matches any of the computed eTLD+1 values
4. THE existing `getDomainByName(accountId, getETLD1(sender))` single-lookup approach SHALL be replaced by this comparison

### Prerequisite C: assign_workflow Rule Action Updates Signal Workflow

**User Story:** As a developer, I want the `assign_workflow` rule action to update the signal's stored workflow (not just the thread context), so that the signal reflects the final workflow after all rules have applied.

#### Acceptance Criteria

1. AFTER all rules have been evaluated, IF any `assign_workflow` action fired, THE processor SHALL update `signal.data.workflow` and `signal.data.workflowData` to reflect the final assigned workflow
2. THE thread's workflow SHALL continue to be updated during rule evaluation (existing behavior preserved)
3. THE signal's stored workflow SHALL be the final value — the last `assign_workflow` action wins (first-rule-wins semantics already apply via the rule evaluator)

### Prerequisite D: SYSTEM Account Workflow Override

**User Story:** As a developer, I want the SYSTEM account's emails to always have workflow `healthcheck` regardless of classifier output or test detection, so that healthcheck processing is deterministic.

#### Acceptance Criteria

1. AFTER the test detection override block in the processor, IF `isSystemAccount(accountId)`, THE processor SHALL override `classificationOutput.workflow` to `"healthcheck"` and `classificationOutput.workflowData` to `{ workflow: "healthcheck" }`
2. THIS override SHALL fire after the `isTestEmail` block so that it takes precedence over test detection
3. THIS override SHALL fire before `buildSignal` so that the signal's stored workflow is `healthcheck`

### Prerequisite E: Refactor Duration Conversion to Use Luxon

**User Story:** As a developer, I want duration-to-seconds conversion to use `luxon` Duration parsing, so that any valid ISO 8601 duration (including `P7D`) works without maintaining a hardcoded lookup table.

#### Acceptance Criteria

1. THE `durationToSeconds` function in `src/processor/retention.ts` SHALL use `Duration.fromISO(duration).as('seconds')` instead of a manual lookup table
2. THE `RetentionDuration` type SHALL be widened to accept any valid ISO 8601 duration string (or at minimum include `P7D`)
3. THE `Infinity` value SHALL be handled as a special case before calling `Duration.fromISO` (since it is not a valid ISO 8601 duration)
4. THE `retentionDurationToSeconds` function in `src/embedding/retention-tier.ts` SHALL be refactored to use the same luxon-based approach
5. THE `DURATION_MS` lookup table in `site-ui/src/lib/retention.ts` SHALL be replaced with luxon Duration parsing (`.toMillis()`)
6. ALL hardcoded `N * 24 * 60 * 60` arithmetic in production source files SHALL be replaced with luxon Duration operations

### Requirement 1: EventBridge Scheduling

**User Story:** As an operator, I want the healthcheck to run automatically every morning, so that pipeline health is monitored daily without manual intervention.

#### Acceptance Criteria

1. THE EventBridge_Rule SHALL use the schedule expression `cron(0 6 * * ? *)` to trigger the Lambda every day at 06:00 UTC
2. THE EventBridge_Rule SHALL target the `production` alias of the main Lambda function
3. THE EventBridge_Rule SHALL use a rule name ending in `-healthcheck` so the handler can route the invocation to the Healthcheck_Job
4. THE EventBridge_Rule SHALL have an associated Lambda resource-based policy granting `events.amazonaws.com` permission to invoke the production alias

### Requirement 2: Handler Routing

**User Story:** As a developer, I want EventBridge healthcheck invocations routed to the correct job class, so that the existing handler routing pattern is extended consistently.

#### Acceptance Criteria

1. WHEN the Lambda receives an EventBridge event whose rule name ends with `-healthcheck`, THE Handler SHALL invoke the Healthcheck_Job run method
2. WHEN the Lambda receives an EventBridge event whose rule name does not end with `-healthcheck` or `-domain-health`, THE Handler SHALL log an error-level message with code `handler.eventbridge.unknown_rule` and return without invoking any job class
3. IF the EventBridge event resources array is empty or the rule name cannot be extracted, THEN THE Handler SHALL log an error-level message with code `handler.eventbridge.unknown_rule` and return without invoking any job class

### Requirement 3: Validation of Previous Day's Healthcheck

**User Story:** As an operator, I want each run to validate that yesterday's test email was fully processed, so that silent pipeline failures are detected within 24 hours.

#### Acceptance Criteria

1. WHEN the Healthcheck_Job runs, THE Healthcheck_Job SHALL construct yesterday's expected Message-ID using the format `healthcheck-{YYYY-MM-DD}@{MAIL_DOMAIN}` where YYYY-MM-DD is the date exactly 1 day before the current run date
2. WHEN the Healthcheck_Job runs, THE Healthcheck_Job SHALL query the signals table via GSI3 using `buildSignalGsi3pk("SYSTEM", expectedMessageId)` to locate yesterday's signal
3. WHEN yesterday's signal is found, THE Healthcheck_Job SHALL verify the signal has a `threadId` field containing a non-zero-length string
4. WHEN yesterday's signal is found, THE Healthcheck_Job SHALL verify the signal has workflow `healthcheck`
5. WHEN yesterday's signal is found, THE Healthcheck_Job SHALL verify an embedding exists in Aurora pgvector for that signal's threadId
6. WHEN all validation checks pass, THE Healthcheck_Job SHALL log a track-level message with code `healthcheck.validation_passed` including the validated Message-ID and all check results, and continue to the send phase
7. WHEN any validation check fails, THE Healthcheck_Job SHALL log a track-level message with code `healthcheck.validation_failed` including the Message-ID, which checks failed, and the signal state found, and continue to the send phase
8. IF the GSI3 query returns no signal for yesterday's Message-ID, THEN THE Healthcheck_Job SHALL log a track-level message with code `healthcheck.signal_not_found` and continue to the send phase
9. IF the Aurora pgvector query fails due to a connectivity or timeout error during the embedding existence check, THEN THE Healthcheck_Job SHALL treat the embedding check as failed, log a track-level message with code `healthcheck.embedding_check_error`, and continue validation of remaining checks

### Requirement 4: Send Today's Healthcheck Email

**User Story:** As an operator, I want a test email sent through the live pipeline every day, so that tomorrow's validation has a signal to check.

#### Acceptance Criteria

1. WHEN the Healthcheck_Job completes validation (regardless of pass or fail), THE Healthcheck_Job SHALL send a test email via the EmailService
2. THE Healthcheck_Email SHALL use Message-ID `healthcheck-{YYYY-MM-DD}@{MAIL_DOMAIN}` where YYYY-MM-DD is the current date
3. THE Healthcheck_Email SHALL be addressed to `healthcheck@{MAIL_DOMAIN}` (derived from the existing MAIL_DOMAIN env var)
4. THE Healthcheck_Email SHALL be sent from `noreply@{MAIL_DOMAIN}` (the existing default sender)
5. THE Healthcheck_Email SHALL use `SYSTEM` as the account ID for the SES TenantName
6. THE Healthcheck_Email SHALL use a subject line in the format `Healthcheck {YYYY-MM-DD}` where YYYY-MM-DD is the current date
7. THE Healthcheck_Email SHALL be rendered from an MJML template (`email-templates/healthcheck.mjml`) and include both HTML and plain-text bodies
8. THE Healthcheck_Email body SHALL include: a description of what the email is and why it exists, who it is for, the logging invocation ID, container ID, timestamp, expected Message-ID, run date, and the validation results from today's run
9. WHEN the email send succeeds, THE Healthcheck_Job SHALL log an info-level message with code `healthcheck.send_success` including the Message-ID used
10. IF the email send fails, THEN THE Healthcheck_Job SHALL log a track-level message with code `healthcheck.send_failed` including the error details

### Requirement 5: Deterministic Message-ID Generation

**User Story:** As a developer, I want healthcheck emails to use a deterministic Message-ID, so that validation can locate them via the existing GSI3 index without storing additional state.

#### Acceptance Criteria

1. THE Healthcheck_Job SHALL generate Message-IDs in the format `healthcheck-YYYY-MM-DD@{MAIL_DOMAIN}` where YYYY-MM-DD is the UTC date of the run (e.g. `healthcheck-2025-07-07@platform.email.rhosys.cloud`)
2. THE Healthcheck_Job SHALL use the `MAIL_DOMAIN` environment variable as the domain portion of the Message-ID
3. THE Healthcheck_Job SHALL produce the same Message-ID for all invocations occurring on the same UTC date regardless of time of day (idempotence within a day)

### Requirement 6: SYSTEM Account — Hardcoded Configuration

**User Story:** As a developer, I want the healthcheck email processed under a well-known SYSTEM account without requiring a DynamoDB record, so that no manual setup or env vars are needed.

#### Acceptance Criteria

1. A `SystemAccountDb` class SHALL exist that provides hardcoded responses for the SYSTEM account, exporting a constant `SYSTEM_ACCOUNT_ID = "SYSTEM"` and an `isSystemAccount(accountId)` guard
2. THE `AccountDatabase` SHALL delegate to `SystemAccountDb` at the start of each method — when `isSystemAccount(accountId)` returns true, the method SHALL return the hardcoded response from `SystemAccountDb` without querying DynamoDB
3. THE `ThreadDatabase` SHALL delegate to `SystemAccountDb` for the same guard — signals and threads for the SYSTEM account are stored normally in DynamoDB (they need to persist for validation), but account-config lookups (rules, filtering, domains) are short-circuited
4. THE `SystemAccountDb.getAccount()` SHALL return an Account object with: id `SYSTEM`, unknown sender policy `allow_all`, no digest, no onboarding, billing plan `Internal`
5. THE `SystemAccountDb.listEnabledRules()` SHALL return only the system rules (no user rules)
6. THE `SystemAccountDb.getDomainByName()` SHALL return a Domain with `platform.email.rhosys.cloud`, `senderSetupComplete: true`, `receivingSetupComplete: true`
7. THE `SystemAccountDb.getDomainOwner()` SHALL return the SYSTEM account as owner when the domain is `platform.email.rhosys.cloud`
8. THE `SystemAccountDb.getAliasByGlobalAddress()` SHALL return an alias resolving `healthcheck@{MAIL_DOMAIN}` to account ID `SYSTEM`
9. All other account-level lookups for the SYSTEM account (stats, senders, forwarding targets, templates, aliases list) SHALL return empty/default values without hitting DynamoDB
10. THE processor SHALL remain unchanged — it calls AccountDatabase methods as usual and is unaware of the SYSTEM account short-circuit

### Requirement 7: Workflow — healthcheck

**User Story:** As a developer, I want a dedicated `healthcheck` workflow type so that the LLM classifier and system rules can handle healthcheck emails distinctly from user-sent test emails.

#### Acceptance Criteria

1. THE `WORKFLOWS` array SHALL include `"healthcheck"` as a valid workflow value
2. THE Healthcheck_Email body SHALL contain sufficient context that the LLM classifier assigns workflow `healthcheck`
3. THE classifier prompt SHALL document the `healthcheck` workflow as: "System-generated pipeline validation emails — daily automated checks"
4. WHEN the Pipeline processes the Healthcheck_Email and assigns workflow `healthcheck`, THE Pipeline SHALL NOT trigger system rule SR-18 (pong) since that rule matches only workflow `test`
5. THE LLM classifier SHALL run normally on the healthcheck email — classification is NOT short-circuited, because validating that the classifier works correctly is part of the healthcheck purpose
6. THE embedding generator SHALL run normally on the healthcheck email — embedding is NOT skipped, because validating that Bedrock embedding + Aurora write works is part of the healthcheck purpose

### Requirement 8: Infrastructure — Minimal New Resources

**User Story:** As an operator, I want the healthcheck to reuse existing infrastructure, so that operational complexity does not increase.

#### Acceptance Criteria

1. THE Healthcheck_Job SHALL execute within the existing Lambda function (no new Lambda)
2. THE Healthcheck_Job SHALL read from and write to the existing DynamoDB tables (no new tables)
3. THE Healthcheck_Job SHALL query the existing Aurora pgvector cluster (no new database)
4. THE infrastructure deployment SHALL create only an EventBridge rule, an EventBridge target, and a Lambda permission resource
5. THE feature SHALL NOT introduce any new environment variables — all values are derived from the existing `MAIL_DOMAIN` env var and hardcoded constants

### Requirement 9: Signal Retention and TTL

**User Story:** As an operator, I want healthcheck signals to expire automatically, so that they don't accumulate indefinitely in DynamoDB and S3.

#### Acceptance Criteria

1. THE SYSTEM account's signals and threads SHALL have a DynamoDB TTL of 7 days from creation
2. THE S3 raw email for healthcheck signals SHALL be tagged with `retention-tier=P1Y` (subject to the existing 1-year lifecycle rule)
3. THE SYSTEM account configuration SHALL use retention duration `P7D` so the processor applies the 7-day TTL automatically

### Requirement 10: Graceful Degradation

**User Story:** As an operator, I want the healthcheck to always send today's email regardless of validation outcome, so that the pipeline is continuously exercised even after failures.

#### Acceptance Criteria

1. WHEN validation fails (checks fail per Requirement 3.7) or the signal is not found (per Requirement 3.8), THE Healthcheck_Job SHALL still proceed to the send phase
2. WHEN a DynamoDB or Aurora query error occurs during validation, THE Healthcheck_Job SHALL log a track-level message with code `healthcheck.validation_error` including the error details, and proceed to the send phase
3. IF an unexpected exception occurs during the send phase, THEN THE Healthcheck_Job SHALL log a track-level message with code `healthcheck.send_error` including the error details and complete execution without re-throwing
4. THE Healthcheck_Job SHALL complete execution and return successfully (no thrown exceptions) regardless of failures in the validation phase or the send phase, ensuring the Lambda invocation reports success to EventBridge
