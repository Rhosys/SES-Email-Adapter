# Requirements Document

## Introduction

Migrate the email-catcher backend from ad-hoc `console.log/error/warn` calls with inline `JSON.stringify` to a centralized `RequestLogger` class. The logger implements the six-level taxonomy from ADR 002 (DEBUG, INFO, TRACK, WARN, ERROR, CRITICAL), provides per-invocation correlation via `invocationId`, records timing track points, redacts secrets from output, and guards against CloudWatch's 256KB payload limit. All existing inline `log()` helpers and raw console calls in source files are replaced with injected logger instances.

## Glossary

- **RequestLogger**: The class (`src/logger.ts`) that provides structured logging methods for all six ADR 002 levels
- **Invocation**: A single Lambda execution (cold or warm start through to response/completion)
- **Track_Point**: A named timing milestone recorded during an invocation, storing elapsed milliseconds and optional context data
- **Container_ID**: A stable random identifier generated once per Lambda cold start, correlating all invocations on the same container
- **Log_Entry**: A single JSON line written to stdout via `console.log`, containing at minimum `level`, `message`, `timestamp`, and `invocationId`
- **Message_Identifier**: A dot-separated string (e.g., `processor.signal.failed`) used as the `message` field — never a human sentence
- **Secret_Pattern**: A field name or value matching redaction rules (authorization headers, fields matching `/secret|signature/i`, cognito identity objects)
- **Payload_Limit**: CloudWatch's 256KB (262,144 bytes) per-event size limit

## Requirements

### Requirement 1: Structured JSON Output

**User Story:** As a developer, I want every log entry to be a single JSON line with consistent fields, so that CloudWatch Insights queries work reliably across all log sources.

#### Acceptance Criteria

1. THE RequestLogger SHALL write every log entry as a single JSON line to stdout via `console.log`
2. THE RequestLogger SHALL include `level`, `message`, `timestamp`, and `invocationId` fields in every Log_Entry
3. THE RequestLogger SHALL format the `timestamp` field as an ISO 8601 string
4. THE RequestLogger SHALL accept the `message` field only as a Message_Identifier (dot-separated, no spaces)
5. WHEN additional context fields are provided, THE RequestLogger SHALL merge them into the Log_Entry without overwriting the required fields

### Requirement 2: Log Level Methods

**User Story:** As a developer, I want level-specific methods on the logger, so that I can emit logs at the correct ADR 002 level without manually setting the `level` field.

#### Acceptance Criteria

1. THE RequestLogger SHALL expose methods `debug()`, `info()`, `track()`, `warn()`, `error()`, and `critical()` corresponding to the six ADR 002 levels
2. WHEN `error()` or `critical()` is called, THE RequestLogger SHALL capture and include a stack trace in the Log_Entry
3. WHEN `error()` or `critical()` is called, THE RequestLogger SHALL include all recorded Track_Points in the Log_Entry
4. WHEN `track()` is called, THE RequestLogger SHALL include all recorded Track_Points in the Log_Entry
5. THE RequestLogger SHALL write all levels to stdout via `console.log` (never `console.error` or `console.warn`)

### Requirement 3: Per-Invocation State

**User Story:** As an operator, I want each Lambda invocation to have a unique correlation ID and timing data, so that I can trace a request's lifecycle in CloudWatch.

#### Acceptance Criteria

1. WHEN `startInvocation()` is called, THE RequestLogger SHALL generate a new `invocationId` (UUID v4) and record the start time
2. WHEN `startInvocation()` is called, THE RequestLogger SHALL clear any Track_Points from a previous invocation
3. THE RequestLogger SHALL include the Container_ID in every Log_Entry
4. THE Container_ID SHALL remain stable across all invocations on the same Lambda container (generated once at module load)

### Requirement 4: Track Points

**User Story:** As a developer, I want to record timing milestones during processing, so that ERROR and CRITICAL logs include a timeline of what happened before the failure.

#### Acceptance Criteria

1. WHEN `trackPoint(name, data?)` is called, THE RequestLogger SHALL record the name, elapsed milliseconds since `startInvocation()`, and optional context data
2. WHEN an ERROR or CRITICAL Log_Entry is emitted, THE RequestLogger SHALL include the array of Track_Points recorded during the current invocation
3. WHEN a TRACK Log_Entry is emitted, THE RequestLogger SHALL include the array of Track_Points recorded during the current invocation

### Requirement 5: Secret Redaction

**User Story:** As a security engineer, I want secrets to be automatically redacted from log output, so that sensitive data never appears in CloudWatch.

#### Acceptance Criteria

1. WHEN serializing a Log_Entry, THE RequestLogger SHALL redact string values of fields whose keys match the pattern `/secret|signature/i` — preserving the first 8 characters and replacing the remainder with `[REDACTED]`
2. WHEN serializing a Log_Entry, THE RequestLogger SHALL redact Authorization header string values — preserving the first 8 characters and replacing the remainder with `[REDACTED]`
3. WHEN serializing a Log_Entry, THE RequestLogger SHALL redact cognito identity objects (replacing with `[REDACTED]`)
4. THE RequestLogger SHALL apply redaction recursively to nested objects and arrays within the Log_Entry
5. IF a redactable string value is 8 characters or shorter, THE RequestLogger SHALL replace the entire value with `[REDACTED]`

### Requirement 6: Payload Truncation

**User Story:** As an operator, I want oversized log entries to be truncated rather than silently dropped by CloudWatch, so that I always get at least partial diagnostic data.

#### Acceptance Criteria

1. IF the serialized Log_Entry exceeds 256KB (262,144 bytes), THEN THE RequestLogger SHALL truncate the payload and append a `_truncated: true` field
2. IF truncation occurs, THEN THE RequestLogger SHALL emit a separate WARN-level Log_Entry indicating the original message identifier and the pre-truncation size

### Requirement 7: Injectability for Testing

**User Story:** As a developer writing tests, I want to inject a mock logger instead of spying on `console`, so that tests are decoupled from the logging implementation.

#### Acceptance Criteria

1. THE RequestLogger SHALL be injectable as a required constructor parameter (never optional, never defaulting to a new instance) in all consumer classes
2. WHERE a module was previously a standalone exported function, THE module SHALL be converted to a class that accepts the logger via constructor
3. WHEN a mock logger is injected, THE system SHALL route all log calls through the mock without writing to stdout

### Requirement 8: Migration of Existing Log Sites

**User Story:** As a developer, I want all existing `console.log/error/warn` calls in source files replaced with logger calls, so that the codebase uses a single consistent logging mechanism.

#### Acceptance Criteria

1. WHEN the migration is complete, THE source files SHALL contain zero direct `console.log`, `console.error`, or `console.warn` calls (excluding the logger implementation itself)
2. WHEN the migration is complete, THE inline `log()` helper functions in `processor.ts` and `reindex-worker.ts` SHALL be removed
3. WHEN the migration is complete, THE test files SHALL use injected mock loggers instead of `vi.spyOn(console, ...)` patterns
4. THE migrated log calls SHALL preserve the original log level semantics (e.g., existing `console.error` with `level: "track"` becomes `logger.track()`)
