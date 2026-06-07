# Requirements Document

## Introduction

All outbound emails sent via SES (forward, reply, pong, draft-send) currently use bare tag names (`type`, `accountId`). This feature prefixes all outbound SES tags with `X-Numaeel-` to namespace them, adds `SignalId` and `ArcId` tags where context is available, and updates the feedback processor to read the new tag names. The prefix "Numaeel" is the internal codename and is defined as a single constant for future swapping.

## Glossary

- **Email_Service**: The `EmailService` class that wraps SESv2 `SendEmailCommand` for all outbound email.
- **External_Email_Handler**: The `ExternalEmailSignalHandler` class that implements `ReplySender` and `Forwarder` interfaces, delegating to Email_Service.
- **Draft_Send_Worker**: The `DraftSendWorker` class that processes queued draft-send payloads via the ReplySender interface.
- **Feedback_Processor**: The `FeedbackProcessor` class that processes SES bounce and complaint notifications and correlates them back to accounts and signals.
- **Tag_Prefix**: The string constant `X-Numaeel-` used to namespace all outbound SES message tags.
- **SES_Tag**: A name-value pair attached to an outbound SES message, returned in feedback notifications for correlation.

## Requirements

### Requirement 1: Centralised Tag Prefix Constant

**User Story:** As a developer, I want the tag prefix defined in a single constant, so that the codename can be swapped later without a multi-file search-and-replace.

#### Acceptance Criteria

1. THE Tag_Prefix SHALL be defined as a single exported constant with the value `X-Numaeel-`.
2. WHEN any outbound SES tag is constructed, THE Email_Service or calling code SHALL concatenate the Tag_Prefix constant with the tag suffix to produce the full tag name.
3. THE codebase SHALL contain no hardcoded `X-Numaeel-` string literals outside the Tag_Prefix constant definition and test assertions.

### Requirement 2: Prefix Existing Outbound Tags

**User Story:** As a platform operator, I want all outbound SES tags namespaced with the prefix, so that they are distinguishable from tags set by other systems sharing the same SES configuration set.

#### Acceptance Criteria

1. WHEN the External_Email_Handler sends a reply, THE External_Email_Handler SHALL include the tag `X-Numaeel-Type` with value `reply`.
2. WHEN the External_Email_Handler forwards an email, THE External_Email_Handler SHALL include the tag `X-Numaeel-Type` with value `forward` and the tag `X-Numaeel-AccountId` with the account identifier.
3. WHEN the Draft_Send_Worker sends a draft, THE Draft_Send_Worker SHALL include the tag `X-Numaeel-Type` with value `draft-send`.
4. WHEN the processor executes a pong side-effect, THE processor SHALL include the tag `X-Numaeel-Type` with value `reply`.

### Requirement 3: Add SignalId and ArcId Tags

**User Story:** As a platform operator, I want bounces and complaints to carry the originating signal and arc identifiers, so that the feedback processor can correlate delivery failures to the exact conversation without a database lookup.

#### Acceptance Criteria

1. WHEN the External_Email_Handler sends a reply and the signal identifier is a non-empty string, THE External_Email_Handler SHALL include the tag `X-Numaeel-SignalId` with the signal identifier value.
2. WHEN the External_Email_Handler sends a reply and the arc identifier is a non-empty string, THE External_Email_Handler SHALL include the tag `X-Numaeel-ArcId` with the arc identifier value.
3. WHEN the External_Email_Handler forwards an email and the signal identifier is a non-empty string, THE External_Email_Handler SHALL include the tag `X-Numaeel-SignalId` with the signal identifier value.
4. WHEN the External_Email_Handler forwards an email and the arc identifier is a non-empty string, THE External_Email_Handler SHALL include the tag `X-Numaeel-ArcId` with the arc identifier value.
5. WHEN the Draft_Send_Worker sends a draft, THE Draft_Send_Worker SHALL include the tag `X-Numaeel-SignalId` with the signal identifier value.
6. WHEN the Draft_Send_Worker sends a draft and the signal has an arc identifier that is a non-empty string, THE Draft_Send_Worker SHALL include the tag `X-Numaeel-ArcId` with the arc identifier value.
7. WHEN the processor executes a pong side-effect, THE processor SHALL include the tag `X-Numaeel-SignalId` with the signal identifier and the tag `X-Numaeel-ArcId` with the arc identifier.
8. IF the signal identifier or arc identifier is null or an empty string at send time, THEN THE sending component SHALL omit the corresponding `X-Numaeel-SignalId` or `X-Numaeel-ArcId` tag from the outbound message.

### Requirement 4: Include AccountId on All Outbound Emails

**User Story:** As a platform operator, I want every outbound email tagged with the account identifier, so that feedback notifications can always be routed to the correct account.

#### Acceptance Criteria

1. WHEN the External_Email_Handler sends a reply, THE External_Email_Handler SHALL include the tag `X-Numaeel-AccountId` with the account identifier associated with the signal being replied to.
2. WHEN the External_Email_Handler forwards an email, THE External_Email_Handler SHALL include the tag `X-Numaeel-AccountId` with the account identifier passed by the caller.
3. WHEN the Draft_Send_Worker sends a draft, THE Draft_Send_Worker SHALL include the tag `X-Numaeel-AccountId` with the account identifier from the draft-send payload.
4. WHEN the processor executes a pong side-effect, THE processor SHALL include the tag `X-Numaeel-AccountId` with the account identifier from the side-effect payload.
5. IF the account identifier is not available at the point of sending, THEN THE sending component SHALL log a warning and omit the `X-Numaeel-AccountId` tag rather than failing the send operation.

### Requirement 5: Update Feedback Processor to Read Prefixed Tags

**User Story:** As a platform operator, I want the feedback processor to read the new prefixed tag names, so that bounce and complaint correlation continues to work after the rename.

#### Acceptance Criteria

1. WHEN the Feedback_Processor receives a bounce or complaint notification, THE Feedback_Processor SHALL read the account identifier from the tag named `X-Numaeel-AccountId`.
2. WHEN the Feedback_Processor receives a bounce or complaint notification, THE Feedback_Processor SHALL read the email type from the tag named `X-Numaeel-Type`.
3. IF the Feedback_Processor receives a bounce or complaint notification and the tag `X-Numaeel-AccountId` is absent, THEN THE Feedback_Processor SHALL skip account-specific correlation (forward-rule disabling and sent-signal lookup) and proceed with address suppression only.
4. WHEN the Feedback_Processor receives a bounce or complaint notification and the tag `X-Numaeel-SignalId` is present, THE Feedback_Processor SHALL look up the originating signal by the signal identifier directly, without querying by SES message identifier.
5. WHEN the Feedback_Processor receives a bounce or complaint notification and the tag `X-Numaeel-ArcId` is present, THE Feedback_Processor SHALL assign the deliverability signal to the arc identified by the arc identifier, without performing an arc-matching lookup.
6. IF the Feedback_Processor receives a bounce or complaint notification and neither `X-Numaeel-SignalId` nor the prefixed account identifier is present, THEN THE Feedback_Processor SHALL fall back to looking up the originating signal by SES message identifier using the existing database query path.

### Requirement 6: ReplySender Interface Expansion

**User Story:** As a developer, I want the ReplySender interface to accept optional tag context (accountId, signalId, arcId), so that callers can pass correlation identifiers without breaking existing consumers.

#### Acceptance Criteria

1. THE ReplySender interface SHALL accept optional fields for accountId, signalId, and arcId in the sendReply options.
2. WHEN a caller invokes sendReply without providing accountId, signalId, or arcId, THE External_Email_Handler SHALL send the message with its existing tags unchanged.
3. WHEN accountId is provided in the sendReply options, THE External_Email_Handler SHALL include the tag `X-Numaeel-AccountId` with the provided value on the outbound message.
4. WHEN signalId is provided in the sendReply options, THE External_Email_Handler SHALL include the tag `X-Numaeel-SignalId` with the provided value on the outbound message.
5. WHEN arcId is provided in the sendReply options, THE External_Email_Handler SHALL include the tag `X-Numaeel-ArcId` with the provided value on the outbound message.

### Requirement 7: Forwarder Interface Expansion

**User Story:** As a developer, I want the Forwarder interface to accept optional signalId and arcId, so that forwarded emails carry full correlation context.

#### Acceptance Criteria

1. THE Forwarder interface SHALL accept optional fields for signalId and arcId in the forward method signature, in addition to the existing required parameters (s3Key, toAddress, accountId).
2. WHEN a signalId is provided in the forward call, THE External_Email_Handler SHALL include the tag `X-Numaeel-SignalId` with the provided signal identifier on the forwarded message.
3. WHEN an arcId is provided in the forward call, THE External_Email_Handler SHALL include the tag `X-Numaeel-ArcId` with the provided arc identifier on the forwarded message.
4. WHEN signalId or arcId is omitted from the forward call, THE External_Email_Handler SHALL send the message without the corresponding tag.
