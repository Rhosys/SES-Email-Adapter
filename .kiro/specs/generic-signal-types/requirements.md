# Requirements Document

## Introduction

The `Signal` interface in the email-catcher backend is currently a flat object containing all possible fields for every signal type (email, deliverability, system alerts). Non-email signals are forced to populate email-specific fields with meaningless placeholder values (empty arrays, empty strings, fake addresses) to satisfy the type system.

This feature introduces a generic `Signal<T>` type where `T` represents the type-specific data payload. Each signal type value maps to its own distinct payload interface carrying only the fields meaningful to that type. Functions encode in their parameters which signal variant they handle, enabling compile-time enforcement of correctness and eliminating placeholder values.

## Glossary

- **Signal**: A record representing an event in the system — an inbound email, a user-composed draft, a deliverability notification, or a system alert.
- **Signal_Generic**: The parameterised type `Signal<T>` where `T` is the type-specific data payload.
- **Base_Fields**: The shared fields present on every signal regardless of type: id, signalLookupId, arcId, accountId, source, type (required), status, createdAt, ttl, urgency, retentionDuration.
- **SIGNAL_TYPES**: The set of valid values for the `type` field: "email", "deliverability", "invalid_rule_function", "invalid_template_function", "auto_send_blocked".
- **EmailSignalData**: The data payload type for email signals containing receivedAt, summary, embeddings, classificationModelId, from, to, cc, replyTo, subject, sentAt, textBody, htmlBody, attachments, headers, recipientAddress, workflow, workflowData, spamScore, s3Key, matchedRules, sesMessageId, sendInitiatedAt, sendFailureReason.
- **DeliverabilitySignalData**: The data payload type for deliverability bounce signals containing relatedSignalId, bouncedRecipients, subject.
- **InvalidRuleFunctionData**: The data payload type for invalid rule function signals containing resourceName, issue.
- **InvalidTemplateFunctionData**: The data payload type for invalid template function signals containing resourceName, functionName, issue.
- **AutoSendBlockedData**: The data payload type for auto-send blocked signals containing fromAddress, replyToAddress, recipientAddress.
- **Data_Property**: The `data: T` field on Signal_Generic that holds the type-specific payload.
- **DynamoDB_Storage**: The persistence layer where signals are stored as flat items with the data property serialised as a nested map attribute.

## Requirements

### Requirement 1: Generic Signal Type Definition

**User Story:** As a developer, I want the Signal type to be parameterised by its data payload, so that functions can express which signal variant they handle at compile time.

#### Acceptance Criteria

1. THE Signal_Generic SHALL define a type parameter `T` representing the type-specific data payload.
2. THE Signal_Generic SHALL include all Base_Fields as required direct properties, including `type` which holds a value from SIGNAL_TYPES.
3. THE Signal_Generic SHALL include a `data` property of type `T` holding the type-specific payload.
4. WHEN Signal_Generic is referenced without an explicit type parameter, THE Signal_Generic SHALL default `T` to `EmailSignalData`.

### Requirement 2: Email Signal Data Type

**User Story:** As a developer, I want email-specific fields grouped into a dedicated data type, so that only email signal handlers are required to provide them.

#### Acceptance Criteria

1. THE EmailSignalData SHALL contain the fields: receivedAt, summary, embeddings, classificationModelId, from, to, cc, replyTo, subject, sentAt, textBody, htmlBody, attachments, headers, recipientAddress, workflow, workflowData, spamScore, s3Key, matchedRules, sesMessageId, sendInitiatedAt, sendFailureReason.
2. THE EmailSignalData SHALL preserve the same optionality for each field as the current Signal interface (embeddings optional, replyTo optional, sentAt optional, textBody optional, htmlBody optional, matchedRules optional, sesMessageId optional, sendInitiatedAt optional, sendFailureReason optional; all others required).
3. THE EmailSignalData SHALL preserve the same types for each field as the current Signal interface.

### Requirement 3: Deliverability Signal Data Type

**User Story:** As a developer, I want a dedicated data type for deliverability signals, so that bounce-processing code only deals with bounce-relevant fields.

#### Acceptance Criteria

1. THE DeliverabilitySignalData SHALL contain the fields: relatedSignalId, bouncedRecipients, subject.
2. THE DeliverabilitySignalData SHALL type bouncedRecipients as an array of objects with address (string), bounceType ("permanent" | "transient"), and optional reason (string).
3. THE DeliverabilitySignalData SHALL type relatedSignalId as a string.

### Requirement 4: Invalid Rule Function Data Type

**User Story:** As a developer, I want a dedicated data type for invalid rule function signals, so that the payload carries the structured rule name and issue rather than a pre-formatted description string.

#### Acceptance Criteria

1. THE InvalidRuleFunctionData SHALL contain the fields: resourceName (string), issue (string).
2. WHEN a signal is created with type "invalid_rule_function", THE InvalidRuleFunctionData SHALL be the required data payload.

### Requirement 5: Invalid Template Function Data Type

**User Story:** As a developer, I want a dedicated data type for invalid template function signals, so that the payload carries the structured template name, function name, and issue.

#### Acceptance Criteria

1. THE InvalidTemplateFunctionData SHALL contain the fields: resourceName (string), functionName (string), issue (string).
2. WHEN a signal is created with type "invalid_template_function", THE InvalidTemplateFunctionData SHALL be the required data payload.

### Requirement 6: Auto-Send Blocked Data Type

**User Story:** As a developer, I want a dedicated data type for auto-send blocked signals, so that the payload carries the structured addresses involved in the block decision.

#### Acceptance Criteria

1. THE AutoSendBlockedData SHALL contain the fields: fromAddress (string), replyToAddress (string), recipientAddress (string).
2. WHEN a signal is created with type "auto_send_blocked", THE AutoSendBlockedData SHALL be the required data payload.

### Requirement 7: Signal Union Type

**User Story:** As a developer, I want a union type representing any valid signal, so that functions handling heterogeneous signals can accept the full set.

#### Acceptance Criteria

1. THE Signal_Generic module SHALL export a union type `AnySignal` representing `Signal<EmailSignalData> | Signal<DeliverabilitySignalData> | Signal<InvalidRuleFunctionData> | Signal<InvalidTemplateFunctionData> | Signal<AutoSendBlockedData>`.
2. WHEN a function accepts signals of any type, THE function SHALL use `AnySignal` or `Signal<unknown>` as the parameter type.

### Requirement 8: Backward Compatibility

**User Story:** As a developer, I want existing code that uses `Signal` without a type parameter to continue working without changes, so that migration is incremental.

#### Acceptance Criteria

1. WHEN existing code references `Signal` without a type parameter, THE type system SHALL resolve it to `Signal<EmailSignalData>`.
2. WHEN existing code accesses email-specific fields via `signal.data.from` or `signal.data.to`, THE type system SHALL permit access without type narrowing.
3. THE refactoring SHALL NOT require changes to any file that already correctly handles only email signals, beyond updating field access from `signal.from` to `signal.data.from`.

### Requirement 9: DynamoDB Storage Format

**User Story:** As a developer, I want the data payload stored as a nested map attribute in DynamoDB, so that no table schema migration is needed.

#### Acceptance Criteria

1. WHEN a signal is persisted to DynamoDB, THE database layer SHALL store the `data` property as a nested map attribute within the signal item.
2. WHEN a signal is read from DynamoDB, THE database layer SHALL reconstruct the typed `data` property from the nested map attribute.
3. THE database layer SHALL preserve all existing Base_Fields as top-level DynamoDB attributes.

### Requirement 10: System Signal Creator Refactoring

**User Story:** As a developer, I want the system signal creator to produce signals with type-specific structured payloads without placeholder values, so that the code is honest about what it creates.

#### Acceptance Criteria

1. WHEN a signal is created with type "invalid_rule_function", THE DynamoSystemSignalCreator SHALL construct a `Signal<InvalidRuleFunctionData>` with only Base_Fields and a data payload containing resourceName and issue.
2. WHEN a signal is created with type "invalid_template_function", THE DynamoSystemSignalCreator SHALL construct a `Signal<InvalidTemplateFunctionData>` with only Base_Fields and a data payload containing resourceName, functionName, and issue.
3. WHEN a signal is created with type "auto_send_blocked", THE DynamoSystemSignalCreator SHALL construct a `Signal<AutoSendBlockedData>` with only Base_Fields and a data payload containing fromAddress, replyToAddress, and recipientAddress.
4. WHEN a system alert signal is created, THE DynamoSystemSignalCreator SHALL NOT populate email-specific fields (from, to, cc, attachments, headers, workflow, workflowData, spamScore, classificationModelId, s3Key).

### Requirement 11: Feedback Processor Refactoring

**User Story:** As a developer, I want the feedback processor to produce `Signal<DeliverabilitySignalData>` without placeholder values, so that bounce signals carry only bounce-relevant data.

#### Acceptance Criteria

1. WHEN a deliverability signal is created, THE feedback processor SHALL construct a `Signal<DeliverabilitySignalData>` with only Base_Fields and a data payload containing relatedSignalId, bouncedRecipients, and subject.
2. WHEN a deliverability signal is created, THE feedback processor SHALL NOT populate email-specific fields (from, to, cc, attachments, headers, spamScore, classificationModelId, s3Key).

### Requirement 12: Type Narrowing by Signal Type

**User Story:** As a developer, I want to narrow a signal's data type based on its required `type` field, so that runtime checks unlock compile-time access to type-specific fields.

#### Acceptance Criteria

1. WHEN a signal has `type` equal to "email", THE type system SHALL allow narrowing its data to EmailSignalData.
2. WHEN a signal has `type` equal to "deliverability", THE type system SHALL allow narrowing its data to DeliverabilitySignalData.
3. WHEN a signal has `type` equal to "invalid_rule_function", THE type system SHALL allow narrowing its data to InvalidRuleFunctionData.
4. WHEN a signal has `type` equal to "invalid_template_function", THE type system SHALL allow narrowing its data to InvalidTemplateFunctionData.
5. WHEN a signal has `type` equal to "auto_send_blocked", THE type system SHALL allow narrowing its data to AutoSendBlockedData.
