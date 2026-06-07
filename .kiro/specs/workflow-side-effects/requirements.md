# Requirements Document

## Introduction

A per-workflow side-effect dispatcher framework for the email-catcher backend. After signal classification and arc creation, the processor dispatches a workflow-specific handler that can enrich the signal, push structured data to connected clients, or schedule future actions. The framework uses a registry pattern so adding a new workflow handler requires only a single file and registration — no changes to the dispatcher itself.

The first concrete handler is `auth`, which pushes a structured OTP payload to connected WebSocket clients in real-time, enabling auto-fill and code display without navigating to the inbox.

## Glossary

- **Dispatcher**: The routing component that receives a processed signal+arc pair and invokes the registered handler for that arc's workflow
- **Workflow_Handler**: A per-workflow module that executes side-effects specific to that workflow (e.g., data enrichment, structured push, scheduled actions)
- **Handler_Registry**: The mapping from workflow name to its handler implementation; new handlers register here
- **OTP_Payload**: The structured message pushed to clients for auth signals: `{ code, authType, expiresInMinutes, originDomain, signalId, subject }`
- **Signal**: An inbound email that has been parsed, classified, and stored
- **Arc**: A grouping of related signals (thread/conversation) with workflow metadata
- **Side_Effect_Pipeline**: The existing SQS-driven pipeline that runs after arc creation (forward, notify, pong, auto_draft)
- **WS_Deliverer**: The existing WebSocket delivery component that sends messages to connected clients via API Gateway Management API
- **Connected_Client**: A browser extension, web app, or mobile client connected via WebSocket to the user's account

## Requirements

### Requirement 1: Dispatcher Framework

**User Story:** As a developer, I want a workflow side-effect dispatcher that routes to per-workflow handlers after arc creation, so that each workflow can execute its own enrichment, push, or scheduling logic without coupling to the core processor.

#### Acceptance Criteria

1. WHEN a side-effect is processed, THE Dispatcher SHALL invoke the registered Workflow_Handler for the arc's workflow type
2. IF no Workflow_Handler is registered for a workflow, THEN THE Dispatcher SHALL skip workflow side-effects silently and continue processing remaining side-effects
3. THE Dispatcher SHALL execute the Workflow_Handler after the existing notification side-effect completes (notify fires first, then workflow handler)
4. IF a Workflow_Handler returns an error Result, THEN THE Dispatcher SHALL propagate the failure to trigger SQS retry — the handler itself decides whether a failure is retriable by returning err() vs ok()
5. IF a Workflow_Handler returns ok(), THEN THE Dispatcher SHALL continue processing normally regardless of whether the handler's internal operations fully succeeded (the handler swallows its own non-critical failures)
6. THE Dispatcher SHALL pass the Signal, Arc, and account context to the Workflow_Handler

### Requirement 2: Handler Registry

**User Story:** As a developer, I want to register workflow handlers via a simple registry pattern, so that adding a new handler requires only creating a handler file and adding a single registration entry.

#### Acceptance Criteria

1. THE Handler_Registry SHALL map each Workflow name to at most one Workflow_Handler
2. WHEN a new Workflow_Handler is registered, THE Handler_Registry SHALL accept it without modification to the Dispatcher source code
3. THE Handler_Registry SHALL expose a typed interface that Workflow_Handlers must implement
4. THE Handler_Registry SHALL allow handlers to declare which workflow they handle via the handler's own metadata (self-registering pattern)

### Requirement 3: Workflow Handler Interface

**User Story:** As a developer, I want a clear interface for workflow handlers, so that each handler has a consistent contract and access to the dependencies it needs.

#### Acceptance Criteria

1. THE Workflow_Handler interface SHALL define an `execute` method that receives the Signal, Arc, and a context object containing shared dependencies
2. THE Workflow_Handler interface SHALL return a Result type indicating success or failure
3. THE context object SHALL provide access to the WS_Deliverer, the account's device store, and a logger
4. THE Workflow_Handler interface SHALL define a `workflow` property identifying which workflow it handles

### Requirement 4: Auth Workflow Handler — OTP Push

**User Story:** As a user, I want my OTP codes pushed to my connected devices as a structured payload the moment they arrive, so that I can auto-fill or read the code without navigating to my inbox.

#### Acceptance Criteria

1. WHEN an auth signal with a `code` field in its workflowData arrives, THE Auth_Handler SHALL push an OTP_Payload to all Connected_Clients for that account
2. THE OTP_Payload SHALL contain the fields: `code`, `authType` (from workflowData), `expiresInMinutes`, `originDomain` (extracted from the signal's sender domain), `signalId`, and `subject` (the signal's email subject line)
3. THE Auth_Handler SHALL deliver the OTP_Payload via the existing WS_Deliverer infrastructure (API Gateway Management API)
4. THE OTP_Payload message type SHALL be distinct from the generic notification payload (type: `"otp"` rather than type: `"signal"`)
5. IF the auth signal has no `code` field, THEN THE Auth_Handler SHALL skip the OTP push and return ok()
6. IF delivery to a Connected_Client fails with a GoneException (stale connection), THEN THE Auth_Handler SHALL mark the device as stale for cleanup
7. THE Auth_Handler SHALL push all codes regardless of expiration time — the client is responsible for displaying expired state
8. THE Auth_Handler SHALL treat OTP push as best-effort — return ok() regardless of delivery outcome
9. THE Auth_Handler SHALL set the arc status to `archived` after processing — auth arcs do not need to remain in the active inbox since the OTP payload was already pushed to the client

### Requirement 5: Integration with Existing Side-Effect Pipeline

**User Story:** As a developer, I want the workflow dispatcher to integrate cleanly into the existing `processSideEffect` flow, so that it runs alongside forward/notify/pong/auto_draft without disrupting them.

#### Acceptance Criteria

1. THE Dispatcher SHALL execute within the existing `processSideEffect` method of the SignalProcessor class
2. THE Dispatcher SHALL run after the notify side-effect and before the auto_draft side-effect
3. IF the Workflow_Handler returns an error Result, THE Dispatcher SHALL propagate the failure to trigger SQS retry
4. WHEN the Dispatcher executes, THE processor SHALL log a trackPoint `"side_effect_workflow_start"` before invocation and `"side_effect_workflow_complete"` after

### Requirement 6: Security Alert Signals — System Rule

**User Story:** As a user, I want security alert emails ("someone is trying to access your account") quarantined by default, so that I'm not alarmed by routine security notices but can review them if needed.

#### Acceptance Criteria

1. THE classifier SHALL assign a distinct `authType` value (e.g., `"security_alert"`) to auth signals whose content indicates an account access warning ("someone is trying to access your account", "new sign-in from", "unrecognized device", "if this wasn't you")
2. THE system SHALL include a new System Rule that matches signals with `authType: "security_alert"` (via a system label `system:auth:security_alert`) and applies `quarantine_hidden` as the default disposition
3. THE System Rule SHALL be disableable by the user — if disabled, security alert signals proceed to the inbox normally
4. THE classifier SHALL NOT assign `authType: "security_alert"` to emails that are actual phishing attempts impersonating security alerts — those receive a high spamScore instead
