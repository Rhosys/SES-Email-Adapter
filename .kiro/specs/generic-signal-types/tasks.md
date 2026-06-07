# Tasks

## Task 1: Define data payload interfaces and generic Signal<T> type

Define the five data payload interfaces and refactor the Signal interface into a generic `Signal<T>` with a `data` property.

### Sub-tasks

- [x] 1.1: Create `EmailSignalData` interface containing all email-specific fields moved out of Signal (receivedAt, summary, urgency, embeddings, from, to, cc, replyTo, subject, sentAt, textBody, htmlBody, attachments, headers, recipientAddress, workflow, workflowData, spamScore, s3Key, matchedRules, sesMessageId, sendInitiatedAt, sendFailureReason, relatedSignalId, bouncedRecipients)
- [x] 1.2: Create `DeliverabilitySignalData` interface with fields: relatedSignalId (string), bouncedRecipients (Array<{ address: string; bounceType: "permanent" | "transient"; reason?: string }>), subject (string)
- [x] 1.3: Create `InvalidRuleFunctionData` interface with fields: resourceName (string), issue (string)
- [x] 1.4: Create `InvalidTemplateFunctionData` interface with fields: resourceName (string), functionName (string), issue (string)
- [x] 1.5: Create `AutoSendBlockedData` interface with fields: fromAddress (string), replyToAddress (string), recipientAddress (string)
- [x] 1.6: Create `SignalBase` interface with shared fields: id, signalLookupId, arcId?, accountId, source, type (required SignalType), status, createdAt, ttl?, retentionDuration?
- [x] 1.7: Redefine `Signal<T = EmailSignalData>` as `SignalBase & { data: T }` — default type parameter ensures backward compatibility
- [x] 1.8: Add "email" to the SIGNAL_TYPES array (currently missing — needed for the discriminated union to work)
- [x] 1.9: Export `AnySignal` union type: `Signal<EmailSignalData> | Signal<DeliverabilitySignalData> | Signal<InvalidRuleFunctionData> | Signal<InvalidTemplateFunctionData> | Signal<AutoSendBlockedData>`
- [x] 1.10: Export type guard functions: `isEmailSignal`, `isDeliverabilitySignal`, `isInvalidRuleFunctionSignal`, `isInvalidTemplateFunctionSignal`, `isAutoSendBlockedSignal`

Requirements: 1, 2, 3, 4, 5, 6, 7, 12

## Task 2: Migrate all Signal field accesses from flat to `signal.data.*`

Update all code that accesses email-specific fields directly on Signal (e.g. `signal.from`, `signal.subject`) to use `signal.data.from`, `signal.data.subject` etc.

### Sub-tasks

- [x] 2.1: Update processor code (src/processor/) — all signal construction and field access to use `data` property
- [x] 2.2: Update API routes (src/api/) — all signal field access to use `data` property
- [x] 2.3: Update database layer (src/database/) — signal serialisation/deserialisation to nest type-specific fields under `data`
- [x] 2.4: Update notifier code (src/notifier/) — signal field access to use `data` property
- [x] 2.5: Update jobs code (src/jobs/) — signal field access to use `data` property
- [x] 2.6: Update utility/model code (src/utils/, src/models/) — signal field access to use `data` property
- [x] 2.7: Update all test files to use `signal.data.*` access pattern and construct signals with `data` property
- [x] 2.8: Ensure `npm test` passes with zero type errors and all tests green

Requirements: 8, 9

Depends on: Task 1

## Task 3: Refactor SystemSignalCreator to produce typed signals without placeholders

Update `DynamoSystemSignalCreator` to construct `Signal<InvalidRuleFunctionData>`, `Signal<InvalidTemplateFunctionData>`, and `Signal<AutoSendBlockedData>` with only base fields + structured data payload. Remove all placeholder email fields.

### Sub-tasks

- [x] 3.1: Refactor `createInvalidRuleFunctionSignal` to construct `Signal<InvalidRuleFunctionData>` with `data: { resourceName, issue }` — no from, to, cc, attachments, headers, workflow, workflowData, spamScore, s3Key, summary, receivedAt
- [x] 3.2: Refactor `createInvalidTemplateFunctionSignal` to construct `Signal<InvalidTemplateFunctionData>` with `data: { resourceName, functionName, issue }` — no placeholder fields
- [x] 3.3: Refactor `createAutoSendBlockedSignal` to construct `Signal<AutoSendBlockedData>` with `data: { fromAddress, replyToAddress, recipientAddress }` — no placeholder fields
- [x] 3.4: Update `SignalStore` interface to accept `AnySignal` instead of `Signal`
- [x] 3.5: Update existing system-signal-creator tests to assert new signal shape (no placeholder fields, structured data payload)
- [x] 3.6: Ensure `npm test` passes

Requirements: 10

Depends on: Task 2

## Task 4: Refactor FeedbackProcessor to produce typed deliverability signals

Update the feedback processor to construct `Signal<DeliverabilitySignalData>` with only base fields + structured data payload. Remove all placeholder email fields from deliverability signals.

### Sub-tasks

- [x] 4.1: Refactor deliverability signal construction in feedback-processor.ts to produce `Signal<DeliverabilitySignalData>` with `data: { relatedSignalId, bouncedRecipients, subject }`
- [x] 4.2: Update `FeedbackSignalStore` interface to use `AnySignal` where appropriate
- [x] 4.3: Update existing feedback-processor tests to assert new signal shape
- [x] 4.4: Ensure `npm test` passes

Requirements: 11

Depends on: Task 2

## Task 5: Write type narrowing and round-trip tests

Add tests verifying type guard correctness and DynamoDB round-trip fidelity for all signal variants.

### Sub-tasks

- [x] 5.1: Write `it.each` test verifying each type guard returns true for its own type and false for all others (Property 1 from design)
- [x] 5.2: Write tests verifying SystemSignalCreator signals contain only expected data fields and no email-specific fields (Property 2)
- [x] 5.3: Write tests verifying FeedbackProcessor signals contain only expected data fields and no email-specific fields (Property 2)
- [x] 5.4: Write tests verifying DynamoDB save/read round-trip preserves `data` property for each signal variant (Property 3)
- [x] 5.5: Write compile-time verification test that `Signal` (no type param) resolves to `Signal<EmailSignalData>` and `signal.data.from` is accessible (Property 4)
- [x] 5.6: Ensure `npm test` passes with all new tests green

Requirements: 9, 12

Depends on: Task 3, Task 4
