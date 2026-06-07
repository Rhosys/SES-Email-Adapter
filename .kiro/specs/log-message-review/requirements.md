# Requirements Document

## Introduction

Comprehensively review and rewrite all non-DEBUG/INFO log messages in the email-catcher backend to include verbose WHAT/HOW/WHY/DO context. Define formal log level semantics and persist them to the existing structured-logging design document. Introduce a `code` field carrying the terse dot-separated identifier for programmatic filtering, while the `message` field becomes a human-readable description containing WHAT/HOW/WHY/DO context. The Logger interface is updated to support the `code` field.

## Glossary

- **Logger**: The `Logger` interface and `RequestLogger` class in `src/logger.ts` providing structured logging methods
- **Log_Level**: One of the six levels in the ADR 002 taxonomy: DEBUG, INFO, TRACK, WARN, ERROR, CRITICAL
- **Code_Field**: A new structured field (`code`) carrying a terse dot-separated identifier (e.g., `processor.signal.failed`) for programmatic filtering and alerting
- **Message_Field**: The `message` field in a LogEntry, now containing a verbose human-readable string describing WHAT happened, HOW it happened, WHY it matters, and what to DO about it
- **WHAT_HOW_WHY_DO**: A structured prose pattern for verbose log messages — WHAT went wrong, HOW it happened (mechanism/trigger), WHY it matters (impact), and DO (suggested remediation or next step)
- **Context_Object**: The structured data object passed alongside the message, carrying IDs, error details, and other machine-parseable fields
- **Design_Document**: The existing file at `.kiro/specs/structured-logging/design.md`
- **Source_Files**: The set of backend TypeScript files containing TRACK, WARN, ERROR, or CRITICAL log calls

## Requirements

### Requirement 1: Log Level Semantics Definition

**User Story:** As a developer, I want formal definitions of when to use each log level, so that log level selection is consistent across the codebase and meaningful for alerting.

#### Acceptance Criteria

1. THE Design_Document SHALL contain a "Log Level Semantics" section defining the purpose, audience, alerting expectation, and example usage for each of the six Log_Levels
2. THE Design_Document SHALL define DEBUG as development-time diagnostic detail that is disabled in production
3. THE Design_Document SHALL define INFO as routine operational milestones confirming the system is working as expected (no action required)
4. THE Design_Document SHALL define TRACK as per-invocation outcome records used for metrics, dashboards, and post-hoc analysis (no immediate action required)
5. THE Design_Document SHALL define WARN as degraded-but-recoverable conditions where the system compensated automatically but an operator should investigate if the pattern persists
6. THE Design_Document SHALL define ERROR as failures requiring operator attention — the current operation failed but the system remains operational
7. THE Design_Document SHALL define CRITICAL as failures indicating the system itself is compromised and immediate intervention is required

### Requirement 2: Code Field Introduction

**User Story:** As an operator, I want a stable machine-readable identifier on every log entry, so that I can build CloudWatch alarms and filters without parsing human-readable text.

#### Acceptance Criteria

1. THE Logger interface SHALL accept a `code` parameter as a field within the context object on all level methods (debug, info, track, warn, error, critical)
2. WHEN a `code` value is provided in the context, THE RequestLogger SHALL include it as a top-level `code` field in the emitted LogEntry
3. THE Code_Field SHALL use dot-separated lowercase identifiers (e.g., `processor.signal.failed`, `reindex.worker.s3_fetch_failed`)
4. WHEN no `code` value is provided, THE RequestLogger SHALL omit the `code` field from the LogEntry (backward-compatible with existing calls)

### Requirement 3: Verbose Message Rewrite for ERROR Level

**User Story:** As an on-call operator, I want ERROR log messages to tell me what failed, how it failed, why it matters, and what to do next, so that I can triage incidents without reading source code.

#### Acceptance Criteria

1. WHEN an ERROR-level log is emitted, THE Message_Field SHALL describe WHAT operation failed in plain language
2. WHEN an ERROR-level log is emitted, THE Message_Field SHALL describe HOW the failure occurred (the mechanism or trigger)
3. WHEN an ERROR-level log is emitted, THE Message_Field SHALL describe WHY the failure matters (impact on the user or system)
4. WHEN an ERROR-level log is emitted, THE Message_Field SHALL describe DO — what action an operator should take or what the system will do automatically
5. THE Context_Object SHALL carry the structured data (IDs, error strings, counts) separately from the verbose message

### Requirement 4: Verbose Message Rewrite for WARN Level

**User Story:** As a developer reviewing logs, I want WARN messages to explain the degraded condition and its implications, so that I can decide whether to investigate further.

#### Acceptance Criteria

1. WHEN a WARN-level log is emitted, THE Message_Field SHALL describe WHAT condition was detected
2. WHEN a WARN-level log is emitted, THE Message_Field SHALL describe HOW the system compensated or degraded
3. WHEN a WARN-level log is emitted, THE Message_Field SHALL describe WHY the condition matters if it persists
4. WHEN a WARN-level log is emitted, THE Message_Field SHALL describe DO — what to investigate or monitor
5. THE Context_Object SHALL carry the structured data (IDs, thresholds, counts) separately from the verbose message

### Requirement 5: Verbose Message Rewrite for TRACK Level

**User Story:** As a developer building dashboards, I want TRACK messages to clearly describe the outcome being recorded, so that metric queries are self-documenting.

#### Acceptance Criteria

1. WHEN a TRACK-level log is emitted, THE Message_Field SHALL describe WHAT outcome or event occurred
2. WHEN a TRACK-level log is emitted, THE Message_Field SHALL describe HOW the outcome was reached (brief mechanism)
3. WHEN a TRACK-level log is emitted, THE Message_Field SHALL describe WHY the outcome is being tracked (what metric or decision it informs)
4. THE Context_Object SHALL carry the structured data (IDs, counts, durations) separately from the verbose message

### Requirement 6: Comprehensive Source File Rewrite

**User Story:** As a developer, I want all existing TRACK/WARN/ERROR/CRITICAL log calls rewritten in a single pass, so that the codebase is consistent and no terse-only messages remain.

#### Acceptance Criteria

1. WHEN the rewrite is complete, THE Source_Files SHALL contain zero log calls at TRACK, WARN, ERROR, or CRITICAL level that use only a terse dot-separated string as the message without WHAT/HOW/WHY/DO context
2. WHEN the rewrite is complete, every TRACK, WARN, ERROR, and CRITICAL log call SHALL include a `code` field in the context object carrying the original terse dot-separated identifier
3. THE rewrite SHALL cover all log calls in `src/processor/processor.ts`
4. THE rewrite SHALL cover all log calls in `src/jobs/reindex/reindex-worker.ts`
5. THE rewrite SHALL cover all log calls in `src/jobs/domain-health-job.ts`
6. THE rewrite SHALL cover all log calls in `src/notifier/feedback-processor.ts`
7. THE rewrite SHALL cover the warn call in `src/database/arc-database.ts`
8. THE rewrite SHALL cover the warn call in `src/processor/rule-evaluator.ts`

### Requirement 7: Backward Compatibility

**User Story:** As a developer, I want the Logger interface changes to be backward-compatible, so that existing DEBUG and INFO calls continue to work without modification.

#### Acceptance Criteria

1. THE Logger interface SHALL remain backward-compatible — existing calls passing only `message` and an optional context object SHALL continue to compile and function correctly
2. WHEN existing DEBUG or INFO calls do not include a `code` field, THE RequestLogger SHALL emit the LogEntry without a `code` field
3. THE LogEntry type SHALL include an optional `code` field of type `string`
4. IF existing property-based tests for the Logger validate the message format as dot-separated identifiers, THEN those tests SHALL be updated to accommodate verbose message strings

### Requirement 8: Design Document Integration

**User Story:** As a future developer, I want the log level semantics and WHAT/HOW/WHY/DO pattern documented in the existing design document, so that new log calls follow the established convention.

#### Acceptance Criteria

1. THE Design_Document SHALL contain a "Message Format" section describing the WHAT/HOW/WHY/DO pattern with examples for each applicable level (TRACK, WARN, ERROR, CRITICAL)
2. THE Design_Document SHALL contain guidance on when to use the `code` field and how to construct code identifiers
3. THE Design_Document SHALL include at least one before/after example showing a terse message transformed into a verbose WHAT/HOW/WHY/DO message with a `code` field
