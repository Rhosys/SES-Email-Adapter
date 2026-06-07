# Implementation Plan: Account Creation Flow

## Overview

Add an AWS Step Functions onboarding workflow that starts automatically when a new account is created via `POST /accounts`. The workflow sends contextual follow-up emails over several weeks based on onboarding progress and periodically checks whether the account has upgraded from the Trial plan. Implementation spans the backend (Lambda handler, starter, task handler, email composer) and infrastructure (Step Function state machine, IAM permissions).

## Tasks

- [x] 1. Update Account types and creation logic
  - [x] 1.1 Add `Trial` to BillingPlan type and set on account creation
    - Add `'Trial'` to the `BillingPlan` union type in `src/embedding/retention-tier.ts`
    - Update `POST /accounts` in `src/api/app.ts` to set `billingPlan: "Trial"` on the new account record before persisting
    - Ensure any `billingPlan` value in the request body is ignored (always overwritten with `"Trial"`)
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Write unit tests for billingPlan on account creation
    - Test that new account always gets `billingPlan: "Trial"` regardless of request body
    - Test that 409 (account exists) does not modify existing account's billingPlan
    - Use `it.each` with static labelled cases
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Implement AccountCreationStarter
  - [x] 2.1 Create SfnAccountCreationStarter module
    - Create `src/onboarding/account-creation-starter.ts` with `AccountCreationStarter` interface and `SfnAccountCreationStarter` class
    - Constructor takes `SFNClient`, `stateMachineArn: string`, and `Logger`
    - `start(accountId, email)` calls `StartExecutionCommand` with `name: accountId` and `input: JSON.stringify({ accountId, email })`
    - Catch `ExecutionAlreadyExists` and treat as success (idempotent)
    - Catch all other errors: log and swallow (fire-and-forget)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 2.2 Write unit tests for AccountCreationStarter
    - Test happy path: `StartExecutionCommand` called with correct stateMachineArn, name, and input
    - Test `ExecutionAlreadyExists` error: no exception propagated, treated as success
    - Test other SFN error: error logged, no exception propagated
    - Mock `SFNClient` with `aws-sdk-client-mock`
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 3. Implement OnboardingTaskHandler
  - [x] 3.1 Create OnboardingTaskHandler module
    - Create `src/onboarding/onboarding-task-handler.ts` with `OnboardingTaskHandler` class
    - Constructor takes a store interface (for `getAccount`, `updateAccount`, `listDomains`, `hasSignals`) and Logger
    - Implement `handleFollowup(accountId, email)`: query real data (domains, sender setup, signals) → compute progress → if all complete and `account.onboarding.completed` is false, update account with `onboarding: { completed: true, completedAt: now }` → log TRACK with code `onboarding.followup` including progress → return Ok
    - Implement `handleCleanup(accountId, email)`: same pattern (query → compute → reconcile onboarding object → log TRACK with code `onboarding.cleanup`)
    - Implement `handleTrialCheck(accountId)`: read account → return `{ accountIsTrial: billingPlan === "Trial" }`
    - No SES emails sent — just structured TRACK logs indicating what would be sent (email sending deferred to later)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 3.2 Create email composition helper
    - Create `src/onboarding/compose-followup-email.ts` with `composeFollowupEmail(progress)` function
    - Return `{ subject, textBody }` based on which milestones are incomplete
    - All complete → congratulatory message; partial → list of suggestions
    - This is used for the TRACK log payload now, and will be used for actual SES sending later
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 3.3 Write unit tests for OnboardingTaskHandler
    - Test handleFollowup: no milestones → TRACK log with all 3 suggestions, onboarding.completed stays false
    - Test handleFollowup: domain added only → TRACK log with 2 suggestions, onboarding.completed stays false
    - Test handleFollowup: all complete, onboarding.completed was false → updates account with `{ completed: true, completedAt }`
    - Test handleFollowup: all complete, onboarding.completed already true → no update call
    - Test handleFollowup: account not found → skip, return Ok
    - Test handleFollowup: domain query fails → domainAdded=false, continues
    - Test handleTrialCheck: Trial plan → `{ accountIsTrial: true }`
    - Test handleTrialCheck: Paid plan → `{ accountIsTrial: false }`
    - Test handleTrialCheck: missing billingPlan → `{ accountIsTrial: false }`
    - Test handleTrialCheck: account deleted → `{ accountIsTrial: false }`
    - Test handleTrialCheck: DynamoDB failure → throws error
    - Use `it.each` with static labelled cases
    - _Requirements: 4.1–4.7, 6.1–6.5_

  - [x] 3.4 Write unit tests for email composition
    - Test all incomplete → "Next steps" subject with 3 suggestions
    - Test all complete → "You're all set!" subject
    - Test partial (domain only) → 2 suggestions
    - Use `it.each` with static labelled cases
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 4. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Add Step Function event routing to Lambda handler
  - [x] 5.1 Create StepFunctionTaskEvent type and detection
    - Create `src/onboarding/types.ts` with `StepFunctionTaskEvent` interface (context.Execution.Input, context.StateMachine.Name, context.State.Name)
    - Export `isStepFunctionTaskEvent` type guard checking for `context.StateMachine` in the event
    - _Requirements: 7.1, 7.5_

  - [x] 5.2 Wire Step Function routing into handler.ts
    - Add `isStepFunctionTaskEvent` check before existing `isEventBridgeEvent` check in handler
    - Build `processorId` from `${StateMachine.Name}|${State.Name}`
    - Route to `onboardingHandler.handleFollowup`, `handleCleanup`, or `handleTrialCheck` based on processorId
    - Log warning and return `{}` for unknown processorId or missing Input fields
    - Instantiate `OnboardingTaskHandler` and `SfnAccountCreationStarter` as singletons in handler.ts
    - Wire `AccountCreationStarter.start()` call into the `POST /accounts` success path (after account persisted, before response)
    - Add `SFNClient` to AWS SDK client singletons
    - Read `ACCOUNT_CREATION_SFN_ARN` from environment; skip starter if empty/unset (log warning)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 2.1, 8.3, 8.4_

  - [x] 5.3 Write unit tests for Step Function event routing
    - Test valid FirstFollowup task event → routes to handleFollowup
    - Test valid TrialCheck task event → routes to handleTrialCheck
    - Test unknown state name → logs warning, returns `{}`
    - Test missing Execution.Input → logs warning, returns `{}`
    - Test SQS event still routes to existing SQS handler (no regression)
    - Test EventBridge event still routes to existing handler (no regression)
    - Use `it.each` with static labelled cases
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

- [x] 6. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Infrastructure — Step Function state machine and IAM
  - [x] 7.1 Create Step Function state machine in OpenTofu
    - Create `email-catcher/infrastructure/account_creation_sfn.tf` with:
    - `aws_sfn_state_machine` resource (type STANDARD) with ASL definition containing: InitialWait (7 days) → FirstFollowup → SecondWait (7 days) → Cleanup → TrialCheckWait (7 days) → TrialCheck → IsStillTrial choice → loop or Done
    - Each Task state uses `"context.$": "$$"` parameter pattern and `ResultPath` for storing results
    - Retry policy on each Task state: `States.ALL`, 60s interval, 5 max attempts, backoff rate 2
    - IAM role for the state machine with `states.amazonaws.com` trust policy
    - IAM policy allowing `lambda:InvokeFunction` scoped to the backend Lambda ARN
    - `aws_lambda_permission` granting the state machine permission to invoke the Lambda's `production` alias
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 7.2 Add Lambda IAM permission and environment variable
    - Add `states:StartExecution` permission to the Lambda execution role, scoped to the Step Function ARN
    - Add `ACCOUNT_CREATION_SFN_ARN` environment variable to the Lambda function configuration
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

- [x] 8. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- All tests use `it.each` with static labelled cases — no fast-check, no random generation
- The design has no Correctness Properties section, so no property-based test tasks are included
- Infrastructure tasks (7.x) are in a separate git repo (`email-catcher/infrastructure`) from backend tasks
- The notification sender address is derived from `MAIL_DOMAIN` (as `noreply@${MAIL_DOMAIN}`) — no separate env var needed

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.1", "3.2"] },
    { "id": 2, "tasks": ["3.3", "3.4"] },
    { "id": 3, "tasks": ["5.2"] },
    { "id": 4, "tasks": ["5.3"] },
    { "id": 5, "tasks": ["7.1"] },
    { "id": 6, "tasks": ["7.2"] }
  ]
}
```
