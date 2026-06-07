# Requirements Document

## Introduction

Rework the Notifier subsystem in the email-catcher backend. The current `SesNotifier` only pushes auth OTP codes over WebSocket. The reworked Notifier becomes a multi-channel notification dispatcher that delivers real-time updates via WebSocket (browser UI) and mobile push notifications. The SES email notification path is removed entirely — sending an email about an email is circular and has no valid use case. Urgency is passed into the notifier so it can decide notification priority, sound, and badge behaviour per channel.

## Glossary

- **Notifier**: The service responsible for dispatching notifications to all registered channels for an account when a signal is processed.
- **Signal**: An immutable inbound email event stored in DynamoDB.
- **Arc**: A materialized aggregate of related Signals (a conversation thread).
- **ArcUrgency**: A five-level urgency enum (`critical`, `high`, `normal`, `low`, `silent`) that drives notification behaviour across all channels.
- **PushPriority**: The mobile push delivery tier derived from ArcUrgency (`interrupt`, `ambient`, `silent`).
- **WebSocket_Channel**: The API Gateway WebSocket connections stored in DynamoDB, used to push real-time updates to the browser UI.
- **Mobile_Push_Channel**: The push notification channel for the native mobile app (FCM for Android, APNs for iOS via a unified gateway).
- **Processor**: The `SignalProcessor` class that orchestrates inbound email processing and dispatches side-effects.

## Requirements

### Requirement 1: Remove SES Email Notification Path

**User Story:** As a system maintainer, I want the SES email notification path removed, so that the system never sends an email notification about a received email (which is circular and confusing).

#### Acceptance Criteria

1. THE Notifier SHALL NOT invoke SES SendEmail or any email-sending operation as part of the notification dispatch flow.
2. THE Notifier SHALL NOT read or evaluate `EmailNotificationSettings` or `notifications.email` from account configuration when deciding which channels to deliver to.
3. WHEN the Notifier is invoked, THE Notifier SHALL limit delivery to WebSocket_Channel and Mobile_Push_Channel (subject to urgency-based channel suppression defined in Requirement 4).
4. THE Notifier SHALL NOT affect SES usage in other subsystems (SesForwarder, SesReplySender, verification mailer), which remain outside the notification dispatch flow.

### Requirement 2: WebSocket Browser Notification

**User Story:** As a user with the app open in a browser, I want to receive real-time signal notifications via WebSocket, so that my inbox updates immediately without polling.

#### Acceptance Criteria

1. WHEN a signal is processed and the signal status is not `blocked`, THE Notifier SHALL send a WebSocket message to all active connections for the account.
2. THE Notifier SHALL include a message type of `signal`, the signal ID, arc ID, sender address, subject, workflow, and urgency in the WebSocket notification payload.
3. IF a WebSocket connection returns HTTP 410 (Gone), THEN THE Notifier SHALL delete the stale connection record from DynamoDB.
4. IF no active WebSocket connections exist for the account, THEN THE Notifier SHALL skip WebSocket delivery without error.
5. IF a WebSocket connection delivery fails with a non-410 error, THEN THE Notifier SHALL log the failure and continue delivering to remaining connections without failing the overall notify call.

### Requirement 3: Mobile Push Notification

**User Story:** As a mobile app user, I want to receive push notifications on my phone when important emails arrive, so that I can triage urgent messages without opening the app.

#### Acceptance Criteria

1. WHEN a signal is processed and notification is not suppressed and PushPriority is not `silent`, THE Notifier SHALL send a mobile push notification to all registered device tokens for the account.
2. WHEN sending a mobile push notification, THE Notifier SHALL set the push priority based on PushPriority (`interrupt` → high priority with sound and badge increment, `ambient` → normal priority with badge increment only and no sound).
3. WHEN sending a mobile push notification, THE Notifier SHALL include the signal ID, arc ID, sender name, subject, and workflow in the push data payload.
4. IF a device token is reported as invalid or unregistered by the push gateway, THEN THE Notifier SHALL delete the stale device token from DynamoDB and continue delivering to remaining device tokens.
5. IF the push gateway is unreachable or returns a server error for a device token, THEN THE Notifier SHALL log the failure and continue delivering to remaining device tokens without failing the overall notify call.
6. THE Notifier SHALL support a maximum of 20 registered device tokens per account.

### Requirement 4: Urgency-Driven Notification Priority

**User Story:** As a user, I want notification priority to reflect the urgency of the email, so that critical messages interrupt me while low-priority messages update silently.

#### Acceptance Criteria

1. THE Notifier SHALL accept the ArcUrgency of the signal as an input parameter.
2. THE Notifier SHALL derive PushPriority from ArcUrgency using the existing `urgencyToPushPriority` mapping (`critical`/`high` → `interrupt`, `normal`/`low` → `ambient`, `silent` → `silent`).
3. IF PushPriority is `interrupt`, THEN THE Notifier SHALL request audible alert and badge increment on mobile push, and deliver via WebSocket_Channel.
4. IF PushPriority is `ambient`, THEN THE Notifier SHALL request badge increment only (no sound) on mobile push, and deliver via WebSocket_Channel.
5. IF PushPriority is `silent`, THEN THE Notifier SHALL deliver via WebSocket_Channel only (no mobile push sent).
6. IF ArcUrgency is not provided for the signal, THEN THE Notifier SHALL default to `normal` urgency before deriving PushPriority.

### Requirement 5: Notifier Interface Contract

**User Story:** As a developer, I want the Notifier interface to accept urgency and be always-present, so that notification dispatch is predictable and null-check-free.

#### Acceptance Criteria

1. THE Notifier interface SHALL require an `urgency` parameter of type ArcUrgency in the `notify` method signature, alongside the existing accountId, Arc, and Signal parameters.
2. THE Notifier SHALL remain a required field in `SignalProcessorOptions` (no optional marker, no null checks).
3. THE Notifier SHALL return `Result<void, DbError>` from all public methods (`notify` and `notifyBlocked`).
4. IF any single channel delivery fails, THEN THE Notifier SHALL log the failure with the channel name and error detail, continue delivering to remaining channels, and return `Ok` from the overall `notify` call.
5. IF all channel deliveries fail, THEN THE Notifier SHALL log each failure and return `Err` with a DbError indicating total delivery failure.

### Requirement 6: Mobile Device Token Storage

**User Story:** As a user, I want to register my mobile device for push notifications, so that I receive alerts on my phone.

#### Acceptance Criteria

1. THE System SHALL store mobile device tokens in DynamoDB, keyed by account ID and device token.
2. WHEN a device token is saved, THE System SHALL store the token value and platform identifier (FCM or APNs).
3. THE System SHALL support a maximum of 10 device tokens per account, enforcing one token per device by replacing any existing record that shares the same device token.
4. WHEN a device token is reported invalid by the push gateway, THE System SHALL delete the token record.
5. WHEN a device token registration is received for a token that already exists under the same account, THE System SHALL update the existing record (platform, timestamp) rather than creating a duplicate.
6. IF a device token registration request contains an empty token value or a platform identifier other than FCM or APNs, THEN THE System SHALL reject the request with a validation error indicating the invalid field.
7. IF the account already has 10 registered device tokens and a new distinct token is submitted, THEN THE System SHALL reject the registration with an error indicating the device limit has been reached.
