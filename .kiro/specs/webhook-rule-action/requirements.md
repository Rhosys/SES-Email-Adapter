# Requirements Document

## Introduction

Add a `webhook` action type to the rule engine. When a rule fires with a webhook action, the processor POSTs signal data to a configured HTTP endpoint. The delivery is fire-and-forget: single attempt, 5-second timeout, no retries, no authentication headers. Failures are logged at TRACK level and swallowed.

## Glossary

- **Processor**: The signal processing pipeline (`src/processor/processor.ts`) that evaluates rules and executes side-effects after rule matching.
- **Rule_Action**: A discrete effect attached to a rule, identified by a `type` and optional `value` field.
- **Webhook_Config**: A JSON object stored in the rule action's `value` field, containing the delivery configuration (currently only an HTTP endpoint URL).
- **Signal_Data**: The contextual payload delivered to the webhook endpoint — the signal and arc metadata available at processing time.
- **TRACK**: A log level between INFO and WARN used for operational events that warrant investigation but do not block processing.

## Requirements

### Requirement 1: Webhook action type registration

**User Story:** As a user, I want to create rules with a "webhook" action type, so that I can trigger external HTTP calls when my rules fire.

#### Acceptance Criteria

1. THE RuleActionType enum SHALL include `webhook` as a valid action type.
2. WHEN a rule action has type `webhook`, THE Processor SHALL accept a JSON-encoded string in the `value` field containing a Webhook_Config object.
3. THE Webhook_Config object SHALL contain a `url` field holding the HTTP endpoint URL.

### Requirement 2: Webhook delivery

**User Story:** As a user, I want signal data POSTed to my configured endpoint when a webhook rule fires, so that I can integrate external systems with my email processing pipeline.

#### Acceptance Criteria

1. WHEN a rule with a `webhook` action fires, THE Processor SHALL send an HTTP POST request to the URL specified in the Webhook_Config.
2. THE Processor SHALL set the request body to a JSON object containing the following signal fields only:
   - `id` — the signal's external-facing ID
   - `arcId`
   - `receivedAt`
   - `from` — `{ address, name? }`
   - `to` — array of `{ address, name? }`
   - `cc` — array of `{ address, name? }`
   - `replyTo` — `{ address, name? }` (if present)
   - `subject`
   - `alias`
   - `workflow`
   - `workflowData`
   - `summary`
   - `labels` — the arc's labels at processing time (if arc exists)
3. THE Processor SHALL NOT include internal fields in the webhook payload: `signalLookupId`, `s3Key`, `embeddings`, `ttl`, `sesMessageId`, `sendInitiatedAt`, `sendFailureReason`, `classificationModelId`, `retentionDuration`, `bouncedRecipients`, `relatedSignalId`, `matchedRules`, `textBody`, `htmlBody`.
4. THE Processor SHALL set the `Content-Type` header to `application/json`.
5. THE Processor SHALL enforce a 5-second timeout on the HTTP request.
6. THE Processor SHALL attempt delivery exactly once with no retries.
7. THE Processor SHALL execute webhook delivery at the end of the side-effects processor, after all other side-effects (label assignment, arc creation, forwarding, notifications, etc.) have completed, so that the payload reflects the final state including labels.

### Requirement 3: Webhook failure handling

**User Story:** As an operator, I want webhook delivery failures logged at TRACK level, so that I can investigate delivery issues without impacting signal processing.

#### Acceptance Criteria

1. IF the webhook request times out, THEN THE Processor SHALL log the failure at TRACK level and continue processing.
2. IF the webhook endpoint returns a non-2xx HTTP status, THEN THE Processor SHALL log the failure at TRACK level including the status code and continue processing.
3. IF a network error occurs during webhook delivery, THEN THE Processor SHALL log the failure at TRACK level including the error message and continue processing.
4. THE Processor SHALL treat webhook delivery as a best-effort side-effect that does not block or retry signal processing.

### Requirement 4: Webhook action validation

**User Story:** As a user, I want invalid webhook configurations rejected at rule creation time, so that I receive immediate feedback rather than silent failures at processing time.

#### Acceptance Criteria

1. WHEN a rule action has type `webhook` and the `value` field is missing, THEN THE API SHALL reject the request with a validation error.
2. WHEN a rule action has type `webhook` and the `value` field contains invalid JSON, THEN THE API SHALL reject the request with a validation error.
3. WHEN a rule action has type `webhook` and the parsed Webhook_Config lacks a `url` field, THEN THE API SHALL reject the request with a validation error.
4. WHEN a rule action has type `webhook` and the `url` field is not a valid HTTP or HTTPS URL, THEN THE API SHALL reject the request with a validation error.

### Requirement 5: No security mechanisms

**User Story:** As a developer, I want the webhook implementation to be minimal and unsecured, so that the initial version ships quickly without unnecessary complexity.

#### Acceptance Criteria

1. THE Processor SHALL NOT include HMAC signatures in webhook requests.
2. THE Processor SHALL NOT include authentication headers in webhook requests.
3. THE Processor SHALL NOT implement a retry queue or dead-letter queue for failed deliveries.

### Requirement 6: Paid plan restriction via feature gating

**User Story:** As a product owner, I want webhook actions restricted to paid plans via a feature-gating abstraction, so that call sites check feature flags rather than plan names.

#### Acceptance Criteria

1. THE system SHALL provide a `BillingHandler` class (or equivalent) that maps plan identifiers to enabled feature sets.
2. THE `BillingHandler` SHALL expose a method like `isFeatureEnabled(accountPlan: string, feature: string): boolean` that call sites use to check access.
3. Call sites SHALL check `isFeatureEnabled(plan, "webhook")` — they SHALL NOT compare plan names directly (e.g. no `if (plan === "free") reject`).
4. THE feature-to-plan mapping SHALL be defined in a single location within the `BillingHandler`, so that adding features to plans requires changing only that mapping.
5. WHEN a user on a plan that does not include the `webhook` feature creates or updates a rule with a `webhook` action, THE API SHALL reject the request with a plan-gating error indicating the feature requires an upgrade.
6. WHEN a signal is processed and a rule has a `webhook` action but the account's plan does not include the `webhook` feature, THE Processor SHALL skip the webhook action and log at INFO level.

### Requirement 7: Update TODO-UI.md

**User Story:** As a developer, I want the frontend work tracker updated with the UI changes needed for webhook rule actions, so that the frontend team knows what to build next.

#### Acceptance Criteria

1. AFTER completing the backend implementation, THE developer SHALL add an entry to `TODO-UI.md` describing the UI work needed to support webhook rule actions (rule editor webhook action type, URL input field, delivery status display).
