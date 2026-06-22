# Requirements Document

## Introduction

The SignalProcessor's `processSideEffect` method has three structural problems that reduce observability and lose failure information. This spec addresses: (1) shared SES error classification so all email-sending callers get Result-based handling that automatically swallows non-retriable failures, (2) full context (arc, signal, payload, error) in all side-effect log messages for traceability, and (3) accumulating multiple critical failures into a single AggregateError instead of overwriting with the last one.

## Glossary

- **Email_Sender**: The existing `EmailService` class, updated to classify SES errors into permanent vs transient categories. Permanent failures are logged and swallowed (returns `ok`); transient failures are returned as `err` so the caller can retry.
- **Processor**: The `SignalProcessor` class that orchestrates side-effect execution (forward, pong, notify, auto-draft, calendar forward, webhooks).
- **Permanent_Error**: An SES failure that will not succeed on retry — `MessageRejected`, `AccountSendingPausedException`, or any 4xx HTTP status.
- **Transient_Error**: An SES failure that may succeed on retry — any 5xx HTTP status or network-level error.
- **Critical_Failure**: A side-effect failure that forces SQS retry (forward, pong, workflow dispatch, calendar forward, auto-draft save).
- **Side_Effect_Log**: Any `logger.track`, `logger.warn`, `logger.error`, or `logger.critical` call within `processSideEffect` that reports a failure or anomaly.
- **ProcessorError**: The error type returned when `processSideEffect` fails, wrapping an `AggregateError` of all critical failures from the invocation.
- **Full_Context**: The complete set of structured log metadata accompanying a side-effect log entry, comprising the full `Signal`, the full `Arc`, the full incoming request/payload, and the full error object (when applicable).

## Requirements

### Requirement 1: Shared Email Sender that Swallows Permanent Failures

**User Story:** As a developer, I want a shared email sender class that classifies SES errors and absorbs non-retriable failures, so that callers (pong, draft-send, future senders) only deal with transient errors that warrant retry, without duplicating classification logic.

#### Acceptance Criteria

1. THE Email_Sender SHALL wrap `EmailService.send` and return a `Result` whose success value contains the SES message ID (when one is produced) and whose error value represents only Transient_Error cases.
2. WHEN `EmailService.send` fails with error name `MessageRejected`, THE Email_Sender SHALL classify the failure as a Permanent_Error.
3. WHEN `EmailService.send` fails with error name `AccountSendingPausedException`, THE Email_Sender SHALL classify the failure as a Permanent_Error.
4. WHEN `EmailService.send` fails with an HTTP status code in the range 400–499, THE Email_Sender SHALL classify the failure as a Permanent_Error.
5. WHEN `EmailService.send` fails with an HTTP status code in the range 500–599, THE Email_Sender SHALL classify the failure as a Transient_Error.
6. WHEN `EmailService.send` fails with no HTTP status code (network-level error), THE Email_Sender SHALL classify the failure as a Transient_Error.
7. WHEN a Permanent_Error occurs, THE Email_Sender SHALL log the failure at `error` level including the SES error name, HTTP status code, and the full original error in the structured metadata, AND THE Email_Sender SHALL return `ok` so the caller treats the operation as terminal (no retry).
8. WHEN a Transient_Error occurs, THE Email_Sender SHALL log the failure at `warn` level including the SES error name, error message, and when present the HTTP status code in the structured metadata, AND SHALL return `err` containing the original error, the SES error name, and the HTTP status code (when present), so the caller can retry.
9. THE Processor SHALL use Email_Sender for the pong side-effect instead of calling `ReplySender.sendReply` directly.
10. THE `DraftSendWorker` SHALL use Email_Sender instead of its inline error classification logic.
11. IF `EmailService.send` fails with an error matching both a named error (criteria 2–3) and an HTTP status code range (criteria 4–5), THEN THE Email_Sender SHALL classify based on the named error check first.

### Requirement 2: Full Context in All Side-Effect Logs

**User Story:** As an operator, I want every side-effect log entry to include the full Signal, full Arc, full incoming payload, and full error object, so that I can reconstruct the exact state of any failure or anomaly without cross-referencing other logs.

#### Acceptance Criteria

1. WHEN any side-effect produces a log entry at `track`, `warn`, `error`, or `critical` level within `processSideEffect`, THE Processor SHALL include the full `Signal` object, the full `Arc` object, and (when one is present) the full incoming SQS message payload in the structured log metadata.
2. WHEN a side-effect log entry corresponds to a failure (either a `Result` error or a thrown exception), THE Processor SHALL additionally include the full original error object in the structured log metadata.
3. WHEN the forward side-effect produces a log entry, THE Full_Context SHALL also include `toAddress`.
4. THE Processor SHALL NOT log only partial identifiers (such as `signalId` alone or `arcId` alone) when the full `Signal` and `Arc` objects are available in scope.
5. WHEN sensitive fields (such as raw email bodies or PII) are present in the `Signal` or `Arc`, THE Processor SHALL still include them in the log metadata so the operator has complete diagnostic information; redaction is the logger's responsibility, not the caller's.

### Requirement 3: Accumulate All Critical Failures into a Single AggregateError

**User Story:** As a developer, I want `processSideEffect` to collect every critical failure and return them all in a consistent shape, so that the caller's error-handling code never has to branch on whether one or many side-effects failed.

#### Acceptance Criteria

1. THE Processor SHALL maintain a list of critical failures during side-effect execution rather than a single mutable variable.
2. WHEN a critical side-effect fails, THE Processor SHALL append the failure to the list in the order it occurred, without discarding previous failures.
3. WHEN one or more critical side-effects fail, THE Processor SHALL return a `ProcessorError` whose `cause` is an `AggregateError` containing all individual failure causes.
4. THE Processor SHALL always wrap the failures in an `AggregateError` regardless of failure count, including when only one critical side-effect failed.
5. WHEN no critical side-effects fail, THE Processor SHALL return `ok(undefined)`.
6. THE `ProcessorError` returned for any failure count SHALL include a `message` that states the count of failures (e.g. "1 critical side-effect failure", "3 critical side-effect failures").
