# Requirements Document

## Introduction

Enhancements to the existing ForwardingTarget system: improved verification UX (deep-link auto-submit), loop detection (setup-time and runtime), forward-attempt tracking via system signals, bounce-triggered target disabling, and re-verification for disabled targets. Builds on top of the existing unified forwarding target resource (email + webhook).

## Glossary

- **Forwarding_Service**: The `ForwardingService` class responsible for sending verification emails, verifying webhooks, and dispatching forwarded emails/webhooks to targets.
- **Feedback_Processor**: The `FeedbackProcessor` class that processes SES bounce/complaint notifications from SNS.
- **Forwarding_Target**: A DynamoDB record representing an email address or webhook URL that receives forwarded signals. Statuses: `pending`, `verified`, `disabled`.
- **Account_Database**: The database layer managing account data including forwarding targets, rules, and domains.
- **Processor**: The signal processor that executes rule side-effects including forwarding.
- **Settings_UI**: The frontend settings view (SettingsView.vue) containing the `email-forwarding` tab.
- **Verification_Token**: A cryptographically random string stored on the ForwardingTarget record, sent in the verification email and validated on the verify endpoint.
- **Account_Domain**: A domain registered and verified by an account, stored as `DOMAIN#{name}` records in DynamoDB.
- **Forward_Signal**: A system signal (type `forward_attempt`) saved to the thread when a forward is attempted. Records the target, status (`sent`, `failed`, `skipped`), and failure reason if applicable. Follows the same pattern as auto-draft signals.

## Requirements

### Requirement 1: Verification Deep-Link Auto-Submit

**User Story:** As a user verifying a forwarding address, I want the verification link to take me directly to the settings email-forwarding tab and automatically complete verification, so that I don't need to manually click a second button after landing on the page.

#### Acceptance Criteria

1. WHEN the Forwarding_Service sends a verification email, THE Forwarding_Service SHALL include a verification URL in the format `{appBaseUrl}/settings?tab=email-forwarding&verifyAddress={target}&token={token}&accountId={accountId}` where `{target}` is percent-encoded
2. WHEN the Settings_UI mounts with `verifyAddress`, `token`, and `accountId` query parameters present and the user is authenticated for the specified account, THE Settings_UI SHALL automatically submit a verification request to `POST /accounts/{accountId}/forwarding-addresses/{address}/verify` with the token within 1 second of mount
3. WHILE the auto-verification request is in-flight, THE Settings_UI SHALL display a loading indicator on the forwarding target row identified by the `verifyAddress` parameter
4. WHEN the auto-verification request succeeds (HTTP 200), THE Settings_UI SHALL update the target status to `verified`, display a success notification, and remove the `verifyAddress`, `token`, and `accountId` query parameters from the browser URL without triggering a page reload
5. IF the auto-verification request fails with error code `INVALID_TOKEN`, THEN THE Settings_UI SHALL display an error message indicating the token is invalid or expired and remove the `token` query parameter from the browser URL
6. IF the auto-verification request fails with error code `FORWARDING_ADDRESS_NOT_FOUND`, THEN THE Settings_UI SHALL display an error message indicating the forwarding address was not found and remove the verification query parameters from the browser URL
7. IF the Settings_UI mounts with verification query parameters but the user is not authenticated, THEN THE Settings_UI SHALL redirect the user to login and preserve the full verification URL for post-login redirect

### Requirement 2: Loop Detection — Setup-Time Rejection

**User Story:** As a system operator, I want forwarding targets pointing to the account's own domains to be rejected at creation time, so that obvious forwarding loops are prevented before they can occur.

#### Acceptance Criteria

1. WHEN a user creates a forwarding target of type `email` and the eTLD+1 (extracted via `tldts` `getDomain()`) of the target email address matches the eTLD+1 of any of the account's registered Account_Domains (compared case-insensitively), THE API SHALL reject the creation with a 422 status and error code `FORWARD_LOOP_DETECTED`
2. IF the account domain lookup fails during forwarding target creation, THEN THE API SHALL reject the creation with a 500 status and log with code `api.forwarding.create.domain_check_failed`
3. WHEN a forwarding target of type `webhook` is created, THE API SHALL skip domain-based loop detection

### Requirement 3: Loop Detection — Runtime Forward Suppression

**User Story:** As a system operator, I want forwarding to be suppressed at execution time when the target would create a loop, so that loops caused by domains added after target creation are still prevented.

#### Acceptance Criteria

1. WHEN the Processor executes a `forward` rule action for an email target, THE Processor SHALL check whether the eTLD+1 of the target email address matches the eTLD+1 of any of the current account's registered Account_Domains; if it matches, THE Processor SHALL skip the forward, save a Forward_Signal with status `skipped` and reason `loop_own_domain`, and log with code `processor.forward_loop_own_domain`
2. WHEN the Processor executes a `forward` rule action for an email target, THE Processor SHALL check whether the eTLD+1 of the target email address matches the eTLD+1 of the inbound signal's sender address (from header) or envelope domain (Return-Path); if it matches, THE Processor SHALL skip the forward, save a Forward_Signal with status `skipped` and reason `loop_sender_domain`, and log with code `processor.forward_loop_sender_domain`
3. WHEN the Processor receives an inbound email containing any header whose name starts with `X-Numaeel-` (case-insensitive), THE Processor SHALL skip all `forward` rule actions for that signal, save a Forward_Signal with status `skipped` and reason `loop_internal_header`, and log a TRACK with code `processor.forward_loop_internal_header`
4. WHEN the Processor skips a forward due to any loop detection rule, THE Processor SHALL continue executing all non-forward side-effects (notifications, pong, auto-draft, calendar forwarding) normally

### Requirement 4: Forward-Attempt Tracking via System Signals

**User Story:** As a user, I want to see when emails were forwarded (or failed to forward) so that I can diagnose delivery issues without digging through logs.

#### Acceptance Criteria

1. WHEN the Forwarding_Service successfully forwards an email or webhook, THE Processor SHALL save a Forward_Signal to the thread with type `forward_attempt`, status `active`, and data including: `{ targetId, targetType, targetAddress, forwardStatus: "sent", triggeredByRuleId, originalSignalId }`
2. WHEN the Forwarding_Service fails to forward (SES error, webhook non-2xx, timeout), THE Processor SHALL save a Forward_Signal to the thread with type `forward_attempt`, status `active`, and data including: `{ targetId, targetType, targetAddress, forwardStatus: "failed", failureReason, triggeredByRuleId, originalSignalId }`
3. WHEN a forward is skipped due to loop detection (Requirement 3), THE Processor SHALL save a Forward_Signal with `forwardStatus: "skipped"` and the loop detection reason
4. THE Forward_Signal SHALL use `source: "system"` and follow the same TTL as the parent signal's retention duration
5. THE Forward_Signal SHALL be saved with the same `threadId` as the original signal that triggered the forward
6. WHEN the Forwarding_Service sends a forwarded email via SES, THE Forwarding_Service SHALL include an SES message tag with key `X-Numaeel-ForwardRef` and value `{accountId}.{forwardSignalId}.{hmac16}` where `hmac16` is computed via `computeHmac16("{accountId}.{forwardSignalId}")` — this prevents exposing raw signal IDs externally while enabling tamper-proof bounce correlation
7. WHEN the Feedback_Processor receives a permanent bounce for a forwarded email, THE Feedback_Processor SHALL extract the `X-Numaeel-ForwardRef` tag, validate the HMAC via `validateHmac16`, extract the `accountId` and `forwardSignalId`, look up the Forward_Signal by ID, and update its `forwardStatus` to `"bounced"` with the bounce reason

### Requirement 5: Bounce Handling — Target Disabling

**User Story:** As a system operator, I want forwarding targets that permanently bounce to be automatically disabled, so that the system stops sending to unreachable addresses and preserves SES sending reputation.

#### Acceptance Criteria

1. WHEN the Feedback_Processor receives a permanent bounce containing an `X-Numaeel-ForwardRef` SES tag, THE Feedback_Processor SHALL validate the HMAC, extract the accountId and forwardSignalId, look up the Forward_Signal's `targetAddress`, and set the corresponding forwarding target's status to `disabled`
2. WHEN the Feedback_Processor disables a forwarding target due to bounce, THE Feedback_Processor SHALL disable all rules that reference the target in a `forward` action (existing `disableRulesForwardingTo` method)
3. WHEN the Feedback_Processor disables a forwarding target due to bounce, THE Feedback_Processor SHALL log the event with code `feedback.target_disabled_on_bounce` including accountId and target address
4. WHEN the Forwarding_Service attempts to forward to a target with status `disabled`, THE Forwarding_Service SHALL skip the forward, save a Forward_Signal with status `skipped` and reason `target_disabled`, and log with code `forwarding.target_invalid`
5. WHEN the Feedback_Processor disables a forwarding target that is referenced by the account's `defaultCalendarInviteForwardingTargetId`, THE Feedback_Processor SHALL clear the account's `defaultCalendarInviteForwardingTargetId` field
6. WHEN the Feedback_Processor disables a forwarding target that is referenced by the account's `digest.forwardingTargetId`, THE Feedback_Processor SHALL set the account's `digest` to `null`

### Requirement 6: Re-Verification for Disabled Targets

**User Story:** As a user whose forwarding target was disabled due to a bounce, I want to re-verify the target to re-enable it, so that I can resume forwarding after fixing the underlying delivery issue.

#### Acceptance Criteria

1. WHEN a user requests re-verification of a forwarding target with status `disabled`, THE Forwarding_Service SHALL generate a new Verification_Token, update the target status to `pending`, and send a new verification email (for email targets) or re-test the webhook URL (for webhook targets)
2. WHEN a user requests re-verification of a forwarding target with status `verified`, THE API SHALL return a 409 status with error code `ALREADY_VERIFIED`
3. WHEN a user requests re-verification of a forwarding target with status `pending`, THE API SHALL return a 409 status with error code `VERIFICATION_ALREADY_PENDING`
4. IF the verification email fails to send during re-verification, THEN THE API SHALL retain the target status as `disabled` and return a 422 status with an error message indicating the verification email could not be sent
5. THE Settings_UI SHALL display a "Re-verify" action button on forwarding targets with status `disabled`
6. WHEN a disabled forwarding target is re-verified successfully, THE Settings_UI SHALL update the target status to `verified`, remove the disabled visual indicator, and display a notification instructing the user to re-enable any disabled rules from the rules page
