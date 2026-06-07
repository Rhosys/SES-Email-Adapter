# Requirements Document

## Introduction

Implement an AWS Step Functions workflow that triggers when a new account is created via `POST /accounts`. The workflow guides new trial accounts through onboarding over several weeks — sending contextual follow-up emails based on onboarding progress (domain setup, sender configuration, email reception) and periodically checking whether the account has upgraded from the TRIAL plan. The Step Function is defined in OpenTofu (infrastructure repo) and the task handlers run in the existing single-Lambda architecture with a new event shape for Step Function task invocations.

## Glossary

- **Step_Function**: The AWS Step Functions state machine that orchestrates the account creation onboarding flow.
- **Account_Creation_Starter**: The module in the backend that starts a Step Function execution when a new account is created.
- **Onboarding_Task_Handler**: The Lambda handler branch that processes Step Function task state invocations, inspects onboarding progress, and sends follow-up emails.
- **Account**: The DynamoDB record representing a user's account, stored in the accounts table.
- **Trial_Plan**: The billing plan assigned to newly created accounts, indicating a free trial period.
- **Onboarding_Progress**: The set of milestones tracked for an account: domain added, sender setup completed, first email received.
- **SES_Followup_Email**: An email sent via SESv2 to the account owner suggesting next onboarding steps based on their current progress.

## Requirements

### Requirement 1: Set Account Plan to TRIAL on Creation

**User Story:** As a new user, I want my account to start on a TRIAL plan, so that I can evaluate the product before committing to a paid plan.

#### Acceptance Criteria

1. WHEN a new account is created via `POST /accounts`, THE Account_Creation_Starter SHALL set the account's `billingPlan` field to `Trial` before persisting the account record, regardless of any `billingPlan` value supplied in the request body.
2. THE Account SHALL include a `billingPlan` field of type string with valid values `Trial`, `Paid`, `Lifetime`, and `Internal`. The field SHALL be non-nullable and always present on persisted account records.
3. IF the account already exists (409 response), THEN THE Account_Creation_Starter SHALL NOT modify the existing account's billing plan and SHALL return the 409 response without starting any side effects.

### Requirement 2: Start Step Function Execution on Account Creation

**User Story:** As a system operator, I want a Step Function execution to start automatically when an account is created, so that the onboarding follow-up sequence begins without manual intervention.

#### Acceptance Criteria

1. WHEN a new account is successfully persisted to DynamoDB, THE Account_Creation_Starter SHALL start a Step Function execution using the account ID as the execution name to guarantee at-most-once execution per account.
2. THE Account_Creation_Starter SHALL pass a JSON object containing the `accountId` and `email` fields as input to the Step Function execution.
3. IF the Step Function returns an `ExecutionAlreadyExists` error, THEN THE Account_Creation_Starter SHALL treat the error as a success (idempotent start) and continue without failing the API response.
4. IF the Step Function returns any other error, THEN THE Account_Creation_Starter SHALL log the error and return the account creation API response as successful (the account is already persisted and the Step Function start is non-blocking).

### Requirement 3: Step Function State Machine Definition

**User Story:** As a system operator, I want the Step Function state machine defined in OpenTofu, so that the onboarding workflow is version-controlled and reproducible.

#### Acceptance Criteria

1. THE Step_Function SHALL define a state machine with the following sequential states: InitialWait → FirstFollowup → SecondWait → Cleanup → TrialCheckLoop.
2. THE Step_Function InitialWait state SHALL wait for 7 days after execution start.
3. THE Step_Function FirstFollowup state SHALL invoke the Lambda function as a Task state with a payload containing `taskType` set to `accountCreationFollowup`, plus the `accountId` and `email` fields from the execution input.
4. THE Step_Function SecondWait state SHALL wait for 7 days after the FirstFollowup state completes.
5. THE Step_Function Cleanup state SHALL invoke the Lambda function as a Task state with a payload containing `taskType` set to `accountCreationCleanup`, plus the `accountId` and `email` fields from the execution input.
6. THE Step_Function TrialCheckLoop SHALL consist of: a 7-day Wait state → a Task state invoking the Lambda with a payload containing `taskType` set to `trialCheck` plus the `accountId` and `email` fields from the execution input → a Choice state that loops back to the Wait if `accountIsTrial` is true, or transitions to the End state if false.
7. THE Step_Function SHALL be defined as an OpenTofu `aws_sfn_state_machine` resource of type `STANDARD` in the infrastructure repository.
8. THE Step_Function SHALL grant the state machine permission to invoke the Lambda function's `production` alias using a resource-based policy (`aws_lambda_permission`).
9. THE Step_Function state machine SHALL use an IAM role with an `states.amazonaws.com` trust policy and no additional permissions beyond invoking the Lambda function.

### Requirement 4: Onboarding Progress Check

**User Story:** As a new user, I want the system to check my onboarding progress, so that follow-up emails are relevant to what I still need to do.

#### Acceptance Criteria

1. WHEN the Onboarding_Task_Handler is invoked for task type `accountCreationFollowup` or `accountCreationCleanup`, THE Onboarding_Task_Handler SHALL query the account's onboarding progress and produce a progress result containing three boolean fields: `domainAdded`, `senderSetupComplete`, and `emailsReceived`.
2. THE Onboarding_Task_Handler SHALL set `domainAdded` to true if the account has at least one Domain record, and false otherwise.
3. THE Onboarding_Task_Handler SHALL set `senderSetupComplete` to true if any Domain record has `senderSetupComplete` set to true, and false otherwise.
4. THE Onboarding_Task_Handler SHALL set `emailsReceived` to true if the account has at least one Signal record, and false otherwise.
5. WHEN the onboarding progress check completes successfully, THE Onboarding_Task_Handler SHALL pass the progress result to the email composition step to determine which onboarding suggestions to include in the follow-up email.
6. IF the account does not exist when the Onboarding_Task_Handler queries onboarding progress, THEN THE Onboarding_Task_Handler SHALL skip sending the follow-up email and return a success response to avoid blocking the Step Function execution.
7. IF a DynamoDB query for Domain or Signal records fails, THEN THE Onboarding_Task_Handler SHALL treat the corresponding milestone as incomplete (false) and continue with email composition.

### Requirement 5: Send Onboarding Follow-up Emails via SES

**User Story:** As a new user, I want to receive helpful emails suggesting what to do next, so that I can complete my setup and get value from the product.

#### Acceptance Criteria

1. WHEN the Onboarding_Task_Handler completes an onboarding progress check, THE Onboarding_Task_Handler SHALL send an email via SESv2 to the account owner's email address.
2. THE SES_Followup_Email SHALL include one suggestion for each incomplete onboarding milestone: a suggestion to add a domain if no Domain record exists, a suggestion to complete sender setup if no Domain has `senderSetupComplete` set to true, and a suggestion to send a test email if no Signal records exist.
3. IF all onboarding milestones are complete, THEN THE Onboarding_Task_Handler SHALL send a congratulatory email and skip further suggestions.
4. THE SES_Followup_Email SHALL use the system notification sender address (NOTIFICATION_FROM environment variable) as the From address.
5. IF the SES_CONFIGURATION_SET environment variable is non-empty, THEN THE SES_Followup_Email SHALL include the configuration set name in the SESv2 SendEmail request.
6. IF the SESv2 SendEmail call fails, THEN THE Onboarding_Task_Handler SHALL log the error and return a failure result to the Step Function, allowing the state machine's built-in retry policy to handle retries.

### Requirement 6: Trial Status Check

**User Story:** As a system operator, I want the Step Function to stop looping once an account upgrades from TRIAL, so that trial-only follow-ups cease after conversion.

#### Acceptance Criteria

1. WHEN the Onboarding_Task_Handler is invoked for task type `trialCheck`, THE Onboarding_Task_Handler SHALL read the account's current `billingPlan` from DynamoDB using the `accountId` from the task payload.
2. IF the account's `billingPlan` is `Trial`, THEN THE Onboarding_Task_Handler SHALL return `{ "accountIsTrial": true }`.
3. IF the account exists and the `billingPlan` is not `Trial` (including null or missing), THEN THE Onboarding_Task_Handler SHALL return `{ "accountIsTrial": false }`.
4. IF the account does not exist (deleted), THEN THE Onboarding_Task_Handler SHALL return `{ "accountIsTrial": false }` to terminate the loop.
5. IF the DynamoDB read fails due to a service error, THEN THE Onboarding_Task_Handler SHALL throw an error to cause the Step Function Task state to retry.

### Requirement 7: Lambda Event Routing for Step Function Tasks

**User Story:** As a developer, I want Step Function task invocations routed through the existing single Lambda, so that no additional Lambda functions need to be deployed.

#### Acceptance Criteria

1. THE Lambda handler SHALL detect Step Function task invocations by checking for a `taskType` field in the event payload.
2. WHEN the event contains a `taskType` field, THE Lambda handler SHALL route to the Onboarding_Task_Handler.
3. THE Lambda handler SHALL support the following `taskType` values: `accountCreationFollowup`, `accountCreationCleanup`, `trialCheck`.
4. IF an unknown `taskType` is received, THEN THE Lambda handler SHALL log a warning and return an empty JSON object to avoid blocking the Step Function execution.
5. THE Step Function Task states SHALL pass the `taskType`, `accountId`, and `email` fields in the task payload.
6. IF the event contains a `taskType` field but is missing `accountId` or `email`, THEN THE Lambda handler SHALL log a warning and return an empty JSON object without invoking the Onboarding_Task_Handler.

### Requirement 8: Infrastructure IAM and Permissions

**User Story:** As a system operator, I want the Lambda to have permission to start Step Function executions, and the Step Function to have permission to invoke the Lambda, so that the workflow operates without permission errors.

#### Acceptance Criteria

1. THE Lambda execution role SHALL include permission to call `states:StartExecution` scoped to the account creation Step Function state machine ARN (not a wildcard resource).
2. THE Step_Function execution role SHALL include permission to call `lambda:InvokeFunction` scoped to the backend Lambda function ARN (not a wildcard resource).
3. THE Lambda SHALL receive the Step Function state machine ARN via an environment variable (`ACCOUNT_CREATION_SFN_ARN`).
4. IF the `ACCOUNT_CREATION_SFN_ARN` environment variable is empty or unset, THEN THE Account_Creation_Starter SHALL skip starting the Step Function execution, log a warning indicating the ARN is not configured, and continue the account creation API response without error.
5. THE Lambda execution role and Step_Function execution role SHALL be defined as OpenTofu resources in the infrastructure repository.
