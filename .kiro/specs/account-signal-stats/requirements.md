# Requirements Document

## Introduction

Track per-account signal receiving statistics in the email-catcher backend. The system records how many email signals an account has received, broken down by outcome (allowed, quarantined, blocked, violation_report) at multiple time granularities: lifetime totals, daily (last 7 days), monthly (last 2 months), and yearly (all years). Stats are stored as a single DynamoDB row in the ACCOUNTS_TABLE and updated atomically after the processor determines signal outcome.

## Glossary

- **Stats_Writer**: The component that increments signal counters and prunes stale date-prefixed attributes in the ACCOUNTS_TABLE after the processor determines signal outcome.
- **Stats_Reader**: The component that reads the stats row from DynamoDB and returns a structured response grouped by time granularity.
- **Signal_Outcome**: The category a signal falls into after processing: `allowed` (status `active`), `quarantined` (status `quarantine_visible` or `quarantine_hidden`), `blocked` (status `block_hidden` or `block_reject`), or `violation_report` (status `report_violation`).
- **Stats_Row**: The single DynamoDB item storing all counters for an account, keyed by `pk: ACCT#${accountId}`, `sk: STATS`.
- **Lifetime_Counter**: An attribute tracking the all-time total for a given outcome category (e.g. `totalAllowed`, `totalBlocked`).
- **Daily_Counter**: A date-prefixed attribute tracking signals for a single calendar day (e.g. `d_2025-01-15_allowed`). Retained for the last 7 days.
- **Monthly_Counter**: A date-prefixed attribute tracking signals for a single calendar month (e.g. `m_2025-01_allowed`). Retained for the last 2 months.
- **Yearly_Counter**: A date-prefixed attribute tracking signals for a single calendar year (e.g. `y_2025_allowed`). Never pruned.
- **Processor**: The `SignalProcessor` class that orchestrates inbound email processing and determines signal status.
- **ACCOUNTS_TABLE**: The DynamoDB table storing account data, keyed by `pk: ACCT#${accountId}` with various `sk` prefixes.

## Requirements

### Requirement 1: Increment Stats on Signal Processing

**User Story:** As a system operator, I want signal stats to be updated every time a signal is processed, so that the stats reflect the current state of the account.

#### Acceptance Criteria

1. WHEN the Processor determines a Signal_Outcome for a signal with status `active`, `quarantine_visible`, `quarantine_hidden`, `block_hidden`, `block_reject`, or `report_violation`, THE Stats_Writer SHALL increment by 1 the corresponding Lifetime_Counter, Daily_Counter, Monthly_Counter, and Yearly_Counter in a single DynamoDB UpdateCommand, using the current UTC date at processing time to determine the Daily, Monthly, and Yearly attribute names.
2. THE Stats_Writer SHALL map signal statuses to outcome categories as follows: `active` → `allowed`, `quarantine_visible` or `quarantine_hidden` → `quarantined`, `block_hidden` or `block_reject` → `blocked`, `report_violation` → `reported`.
3. THE Stats_Writer SHALL increment the `totalSignals` Lifetime_Counter by 1 for every processed signal with a non-draft status, regardless of outcome category.
4. THE Stats_Writer SHALL use DynamoDB `ADD` expressions for all counter increments, which initializes non-existent attributes to 0 before adding.
5. IF a signal has status `draft`, THEN THE Stats_Writer SHALL NOT increment any counters.

### Requirement 2: Prune Stale Date-Prefixed Attributes

**User Story:** As a system operator, I want stale daily and monthly counters removed automatically, so that the stats row does not grow unbounded.

#### Acceptance Criteria

1. WHEN the Stats_Writer increments counters, THE Stats_Writer SHALL include a `REMOVE` expression in the same UpdateCommand that deletes all Daily_Counter attributes whose date suffix represents a date more than 7 calendar days before the current date, covering the contiguous range from day-8 through day-14 relative to today.
2. WHEN the Stats_Writer increments counters, THE Stats_Writer SHALL include a `REMOVE` expression in the same UpdateCommand that deletes all Monthly_Counter attributes whose month suffix represents a calendar month earlier than the month 2 calendar months before the current month (e.g., if the current month is March, remove January and earlier, covering the contiguous range from month-3 through month-4 relative to the current month).
3. THE Stats_Writer SHALL never prune Yearly_Counter attributes.
4. THE Stats_Writer SHALL compute stale attribute names deterministically from the current date by generating the fixed set of date-formatted suffixes for the removal window, without reading the existing row first.
5. IF the `REMOVE` expression targets an attribute name that does not exist on the row, THEN THE Stats_Writer SHALL treat the absence as a no-op and SHALL NOT fail the UpdateCommand.

### Requirement 3: Stats Row Storage Schema

**User Story:** As a developer, I want a well-defined storage schema for the stats row, so that the read and write paths agree on attribute naming.

#### Acceptance Criteria

1. THE Stats_Row SHALL be stored with `pk: ACCT#${accountId}` and `sk: STATS` in the ACCOUNTS_TABLE.
2. THE Stats_Row SHALL store Lifetime_Counters as DynamoDB Number attributes named `totalSignals`, `totalAllowed`, `totalBlocked`, `totalQuarantined`, and `totalreported`.
3. THE Stats_Row SHALL store Daily_Counters as DynamoDB Number attributes named `d_YYYY-MM-DD_<category>` where the date is in UTC and category is one of `allowed`, `blocked`, `quarantined`, `reported`.
4. THE Stats_Row SHALL store Monthly_Counters as DynamoDB Number attributes named `m_YYYY-MM_<category>` where the month is in UTC and category is one of `allowed`, `blocked`, `quarantined`, `reported`.
5. THE Stats_Row SHALL store Yearly_Counters as DynamoDB Number attributes named `y_YYYY_<category>` where the year is in UTC and category is one of `allowed`, `blocked`, `quarantined`, `reported`.

### Requirement 4: Read Stats via API

**User Story:** As a user, I want to retrieve my account's signal statistics via the API, so that I can see how many emails have been received and their outcomes over time.

#### Acceptance Criteria

1. WHEN a GET request is received at `/accounts/:accountId/stats`, THE Stats_Reader SHALL retrieve the Stats_Row using a single DynamoDB GetItem operation and return an HTTP 200 response.
2. THE Stats_Reader SHALL return a JSON response with four top-level keys: `lifetime` (object containing `totalSignals`, `totalAllowed`, `totalBlocked`, `totalQuarantined`, `totalreported`), `daily` (array of objects each containing `date` as `YYYY-MM-DD` string and `allowed`, `blocked`, `quarantined`, `reported` integer counters), `monthly` (array of objects each containing `month` as `YYYY-MM` string and the same four counters), and `yearly` (array of objects each containing `year` as `YYYY` string and the same four counters).
3. IF the Stats_Row does not exist for the account, THEN THE Stats_Reader SHALL return an HTTP 200 response with all lifetime counters set to zero and empty arrays for daily, monthly, and yearly.
4. THE Stats_Reader SHALL sort daily entries by date descending, monthly entries by month descending, and yearly entries by year descending.
5. THE Stats_Reader SHALL require the same authorization as other account-scoped endpoints (`stats:read` permission on `accounts/${accountId}/stats`).
6. IF the DynamoDB GetItem operation fails, THEN THE Stats_Reader SHALL return an HTTP 500 response with an error message indicating the stats could not be retrieved.

### Requirement 5: Stats Write Atomicity and Failure Handling

**User Story:** As a system operator, I want stats writes to be atomic and non-blocking, so that a stats failure does not prevent signal processing from completing.

#### Acceptance Criteria

1. THE Stats_Writer SHALL execute all counter increments and attribute removals in a single DynamoDB UpdateCommand (one network round-trip).
2. IF the Stats_Writer UpdateCommand fails after SDK-level retries are exhausted, THEN THE Processor SHALL log a warning containing the accountId and the error message, and continue processing without returning an error to the caller.
3. THE Stats_Writer SHALL NOT require reading the existing Stats_Row before writing (no read-modify-write pattern).
4. THE Stats_Writer SHALL NOT implement its own idempotency tracking, relying on the Processor's existing signal-level deduplication.
5. THE Stats_Writer SHALL NOT add application-level retry logic beyond the retries provided by the DynamoDB SDK client.

### Requirement 6: Outcome Category Mapping Completeness

**User Story:** As a developer, I want the outcome category mapping to cover all non-draft signal statuses, so that no processed signal is silently dropped from stats.

#### Acceptance Criteria

1. THE Stats_Writer SHALL map every SignalStatus value except `draft` to exactly one outcome category.
2. IF a new SignalStatus value is added to the type system without a corresponding mapping entry, THEN the TypeScript compiler SHALL produce a type error at build time.
3. IF the Stats_Writer receives a signal whose status does not match any mapping entry at runtime, THEN THE Stats_Writer SHALL log an error containing the unrecognized status value and skip counter increments for that signal without throwing.
