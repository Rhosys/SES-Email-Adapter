# Requirements Document

## Introduction

Outbound webhooks allow users to pipe signal data into external automation tools (Zapier, Make, n8n, custom apps) by configuring HTTP endpoints that receive POST requests when new signals arrive. Webhooks are a paid-tier feature (developer/power user plan) that extends the existing side-effects system in the signal processor. Each webhook endpoint is secured with an HMAC secret for payload verification, supports filtering to control which signals trigger delivery, and includes retry logic for transient failures.

## Glossary

- **Webhook_Endpoint**: A user-configured HTTP URL that receives signal data as JSON POST requests when matching signals are processed.
- **Webhook_Secret**: An HMAC-SHA256 signing key associated with a Webhook_Endpoint, used to generate a signature header so the receiver can verify payload authenticity.
- **Webhook_Payload**: The JSON body POSTed to a Webhook_Endpoint, containing signal and arc data.
- **Webhook_Delivery**: A single attempt to POST a Webhook_Payload to a Webhook_Endpoint, including the HTTP response status and timing.
- **Webhook_Filter**: An optional condition on a Webhook_Endpoint that restricts which signals trigger delivery (by workflow, label, sender domain, or recipient address).
- **Signal**: An immutable inbound email event stored in DynamoDB.
- **Arc**: A materialized aggregate of related Signals (a conversation thread).
- **Processor**: The SignalProcessor class that orchestrates inbound email processing and dispatches side-effects via SQS.
- **Side_Effect_Worker**: The SQS consumer that executes side-effects (forward, notify, pong, auto-draft) after signal processing completes.
- **Delivery_Log**: A time-limited record of recent webhook delivery attempts for a Webhook_Endpoint, used for debugging and monitoring.

## Requirements

### Requirement 1: Webhook Endpoint Registration

**User Story:** As a developer, I want to register webhook endpoints for my account, so that external systems receive signal data automatically when emails arrive.

#### Acceptance Criteria

1. THE System SHALL allow a user to create a Webhook_Endpoint by providing a URL (maximum 2048 characters) and an optional display name (maximum 128 characters), with the endpoint enabled by default.
2. WHEN a Webhook_Endpoint is created, THE System SHALL generate a cryptographically random Webhook_Secret (32 bytes, hex-encoded) and return it to the user exactly once.
3. THE System SHALL store the Webhook_Endpoint URL, display name, Webhook_Secret, enabled status, and creation timestamp in DynamoDB, keyed by account ID and endpoint ID.
4. THE System SHALL enforce a maximum of 5 Webhook_Endpoints per account.
5. IF a Webhook_Endpoint creation request contains a URL that does not use the HTTPS scheme, THEN THE System SHALL reject the request with a validation error indicating HTTPS is required.
6. IF a Webhook_Endpoint creation request would exceed the per-account limit, THEN THE System SHALL reject the request with an error indicating the endpoint limit has been reached.
7. WHEN a user requests deletion of a Webhook_Endpoint, THE System SHALL remove the endpoint record and all associated Delivery_Log entries.
8. THE System SHALL allow a user to update the display name (maximum 128 characters) and enabled status of an existing Webhook_Endpoint without regenerating the Webhook_Secret.
9. IF a user attempts to update or delete a Webhook_Endpoint that does not exist, THEN THE System SHALL reject the request with an error indicating the endpoint was not found.

### Requirement 2: Webhook Secret Rotation

**User Story:** As a developer, I want to rotate my webhook secret without downtime, so that I can maintain security without missing deliveries.

#### Acceptance Criteria

1. WHEN a user requests secret rotation for a Webhook_Endpoint, THE System SHALL generate a new Webhook_Secret (32 bytes, hex-encoded), store both the old and new secrets on the endpoint record, and return the new secret to the user exactly once.
2. WHILE a Webhook_Endpoint has two active secrets (during rotation), THE System SHALL include signatures for both secrets in the delivery headers so the receiver can verify with either.
3. WHEN a user confirms rotation is complete, THE System SHALL remove the old secret from the endpoint record, leaving only the new secret active.
4. IF a rotation is not confirmed within 24 hours, THEN THE System SHALL automatically remove the old secret and retain only the new secret.
5. IF a user confirms rotation when no rotation is in progress for that Webhook_Endpoint, THEN THE System SHALL reject the request with an error indicating no rotation is pending.
6. IF a user requests secret rotation for a Webhook_Endpoint that already has a rotation in progress, THEN THE System SHALL reject the request with an error indicating a rotation is already pending.

### Requirement 3: Webhook Filtering

**User Story:** As a developer, I want to filter which signals trigger my webhook, so that I only receive data relevant to my integration (e.g., only auth codes, only signals from a specific domain).

#### Acceptance Criteria

1. THE System SHALL allow a user to attach a Webhook_Filter to a Webhook_Endpoint, specifying zero or more conditions on: workflow (one or more values from the Workflow enum, matched with OR logic), label (one or more exact-match arc labels, where the arc must contain ALL specified labels), sender domain (one or more eTLD+1 values, matched with OR logic), and recipient address (one or more exact-match addresses, matched with OR logic), with a maximum of 10 values per condition type.
2. WHEN multiple condition types are specified on a single Webhook_Filter, THE System SHALL require all condition types to match (AND logic across types, OR logic within each type) before triggering delivery.
3. WHEN no Webhook_Filter is attached to a Webhook_Endpoint, THE System SHALL deliver all non-blocked signals to that endpoint.
4. WHEN a signal is processed, THE System SHALL evaluate the Webhook_Filter for each enabled Webhook_Endpoint and deliver only to endpoints whose filter matches.
5. THE System SHALL NOT deliver signals with a status of `block_hidden`, `block_reject`, or `violate_report` to any Webhook_Endpoint regardless of filter configuration.
6. IF a Webhook_Filter attach or update request specifies a workflow value not present in the Workflow enum, THEN THE System SHALL reject the request with a validation error indicating the invalid workflow value.

### Requirement 4: Webhook Payload Format

**User Story:** As a developer, I want a well-structured JSON payload with signal and arc data, so that I can parse webhook deliveries reliably in my automation tools.

#### Acceptance Criteria

1. THE Webhook_Payload SHALL contain an `event` field with value `signal.created`, a `timestamp` field with the delivery time in ISO 8601 format (UTC, e.g. `2024-01-15T09:30:00Z`), and a `data` object.
2. THE Webhook_Payload `data` object SHALL contain: signal ID (string), arc ID (string), account ID (string), sender address (string), sender name (string), recipient address (string), subject (string, maximum 998 characters), workflow (string matching the Workflow enum value), workflow data (object containing workflow-specific key-value pairs as extracted during signal processing), labels (array of strings), urgency (string), spam score (number between 0.0 and 10.0), and received-at timestamp (ISO 8601 UTC).
3. THE Webhook_Payload SHALL NOT contain the raw email body, raw HTML, S3 key, or attachment binary content.
4. THE Webhook_Payload SHALL include a `summary` field containing the signal's AI-generated summary text (string, maximum 1024 characters). IF no summary was generated for the signal, THEN the `summary` field SHALL be `null`.
5. THE Webhook_Payload SHALL include an `attachments` array containing metadata only (filename as string, content type as string, size in bytes as integer) for each attachment, without binary content. IF the signal has no attachments, THEN the `attachments` field SHALL be an empty array.
6. IF a field in the `data` object has no value for a given signal (e.g., sender name is absent), THEN THE Webhook_Payload SHALL include that field with a `null` value rather than omitting the field, so that consumers can rely on a consistent set of keys in every payload.

### Requirement 5: Webhook Delivery and Signing

**User Story:** As a developer, I want webhook deliveries signed with HMAC-SHA256, so that I can verify the payload originated from the system and was not tampered with.

#### Acceptance Criteria

1. WHEN delivering a Webhook_Payload, THE System SHALL compute an HMAC-SHA256 signature over the concatenation of the `X-Webhook-Timestamp` value, a period character (`.`), and the raw JSON request body, using the Webhook_Secret as the key.
2. WHEN delivering a Webhook_Payload, THE System SHALL include the signature in an `X-Webhook-Signature` header, formatted as `sha256=<hex-encoded-signature>`.
3. WHEN delivering a Webhook_Payload, THE System SHALL include a delivery ID (UUID v4) in an `X-Webhook-Delivery-Id` header for idempotency tracking by the receiver.
4. WHEN delivering a Webhook_Payload, THE System SHALL include an `X-Webhook-Timestamp` header containing the Unix timestamp (seconds) at which the signature was computed, to allow receivers to reject stale deliveries.
5. WHEN delivering a Webhook_Payload, THE System SHALL set the `Content-Type` header to `application/json` and the `User-Agent` header to `EmailCatcher-Webhook/1.0`.
6. WHEN delivering a Webhook_Payload, THE System SHALL send the request using the HTTP POST method.
7. WHEN a Webhook_Endpoint has two active secrets during rotation, THE System SHALL include two `X-Webhook-Signature` headers, one for each secret, both computed over the same timestamp-and-body concatenation.

### Requirement 6: Webhook Delivery Retry

**User Story:** As a developer, I want failed webhook deliveries to be retried automatically, so that transient network issues do not cause me to miss signals.

#### Acceptance Criteria

1. THE System SHALL consider a delivery successful when the Webhook_Endpoint responds with an HTTP status code in the 2xx range within 10 seconds.
2. IF a delivery attempt fails (non-2xx response, network error, or timeout), THEN THE System SHALL retry the delivery up to 3 times with exponential backoff (delays of 30 seconds, 2 minutes, and 10 minutes), recomputing the `X-Webhook-Signature` and `X-Webhook-Timestamp` headers at the time of each retry attempt.
3. IF all retry attempts for a delivery are exhausted, THEN THE System SHALL record the final failure in the Delivery_Log and increment a consecutive-failure counter on the Webhook_Endpoint.
4. THE System SHALL use the same `X-Webhook-Delivery-Id` and the same Webhook_Payload body across all retry attempts for a single delivery, so the receiver can deduplicate.
5. IF a delivery attempt receives an HTTP 410 (Gone) response, THEN THE System SHALL immediately disable the Webhook_Endpoint and stop retrying, recording the reason as "endpoint_gone".
6. IF the Webhook_Endpoint is disabled (manually or by auto-disable) while retry attempts are still pending, THEN THE System SHALL cancel remaining retries for that endpoint and record the delivery as failed in the Delivery_Log.

### Requirement 7: Webhook Endpoint Auto-Disable

**User Story:** As a system operator, I want endpoints that consistently fail to be automatically disabled, so that the system does not waste compute on dead endpoints.

#### Acceptance Criteria

1. THE System SHALL track a consecutive-failure counter for each Webhook_Endpoint, incremented when all retries for a delivery are exhausted and reset to zero on any successful delivery.
2. IF the consecutive-failure counter for a Webhook_Endpoint reaches 15, THEN THE System SHALL automatically disable the endpoint, record the disable timestamp and reason as "consecutive_failures" on the endpoint record, and cease dispatching new deliveries to that endpoint.
3. WHEN a Webhook_Endpoint is auto-disabled, THE System SHALL create a Delivery_Log entry indicating the auto-disable event so that the operator can discover the disable reason via the delivery log API.
4. THE System SHALL allow a user to manually re-enable a disabled Webhook_Endpoint regardless of the disable reason, resetting the consecutive-failure counter to zero.
5. IF a Webhook_Endpoint is disabled while deliveries for that endpoint are already queued, THEN THE System SHALL skip those queued deliveries without incrementing the failure counter.

### Requirement 8: Webhook Delivery Logging

**User Story:** As a developer, I want to see recent delivery attempts for my webhook endpoints, so that I can debug integration issues.

#### Acceptance Criteria

1. THE System SHALL record each delivery attempt in the Delivery_Log, including: delivery ID, endpoint ID, signal ID, HTTP status code (or error type for network failures categorised as `timeout`, `connection_refused`, `dns_failure`, or `network_error`), response time in milliseconds, attempt number (1 through 4), and timestamp.
2. THE System SHALL retain Delivery_Log entries for 7 days, after which entries are automatically deleted (DynamoDB TTL).
3. THE System SHALL expose the Delivery_Log via an API endpoint, returning entries for a given Webhook_Endpoint owned by the authenticated user, ordered by timestamp descending, in pages of up to 50 entries with cursor-based pagination.
4. THE Delivery_Log entry SHALL NOT store the full request or response body to limit storage cost.
5. IF a Delivery_Log query references a Webhook_Endpoint that does not exist or does not belong to the authenticated user, THEN THE System SHALL return an error indicating the endpoint was not found.

### Requirement 9: Webhook Dispatch Integration with Side-Effect Worker

**User Story:** As a system architect, I want webhook delivery to execute within the existing side-effect pipeline, so that it benefits from the same async dispatch, retry isolation, and idempotency guarantees as other side-effects.

#### Acceptance Criteria

1. WHEN a signal is processed and at least one enabled Webhook_Endpoint matches, THE Processor SHALL include the matched endpoint IDs and the pre-built Webhook_Payload in the SideEffectPayload dispatched to SQS.
2. THE Side_Effect_Worker SHALL execute webhook deliveries as a best-effort side-effect: delivery failures are logged to the Delivery_Log but do not cause the SQS message to return to the queue for reprocessing.
3. THE Side_Effect_Worker SHALL dispatch webhook deliveries independently for each matching Webhook_Endpoint, so that a failure to one endpoint does not block or delay delivery to others.
4. THE System SHALL load the account's enabled Webhook_Endpoints during signal processing and evaluate Webhook_Filters before dispatching the side-effect, so that the SQS message contains only the matched endpoint IDs.
5. IF the Side_Effect_Worker receives an SQS message that has already been processed (duplicate delivery), THEN THE Side_Effect_Worker SHALL use the X-Webhook-Delivery-Id to skip endpoints that have already received a successful delivery for that signal, preventing duplicate POSTs.

### Requirement 10: Paid-Tier Gating

**User Story:** As a product owner, I want webhook outbound restricted to paid-tier accounts, so that the compute cost of webhook delivery is covered by the pricing plan.

#### Acceptance Criteria

1. IF an account's billing plan does not include webhook access, THEN THE System SHALL reject Webhook_Endpoint creation, secret rotation, and filter modification requests with an error indicating the feature requires a plan upgrade.
2. IF an account's billing plan does not include webhook access, THEN THE Processor SHALL skip webhook filter evaluation and delivery dispatch for that account, even if Webhook_Endpoints exist from a prior plan.
3. WHEN an account downgrades from a plan with webhook access to one without, THE System SHALL disable all Webhook_Endpoints for that account, record the disable reason as "plan_downgrade", and preserve the endpoint records.
4. IF an account's billing plan does not include webhook access, THEN THE System SHALL still allow the account to list, view, and delete existing Webhook_Endpoints and view their Delivery_Log history.
5. WHEN an account upgrades to a plan that includes webhook access, THE System SHALL retain all previously preserved Webhook_Endpoints in disabled state, allowing the user to manually re-enable them.
