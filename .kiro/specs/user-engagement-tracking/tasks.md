# Implementation Plan: User Engagement Tracking

## Overview

Add a staleness checker to the existing `domain-health-job.ts` handler that identifies outstanding arcs (active, non-silent urgency, `lastSignalAt` older than 7 days) per account and emits structured TRACK-level logs. Pure logic functions live in a separate `staleness-logic.ts` file for testability. A new `listStaleActiveArcs` method on `ArcDatabase` queries the existing GSI. No new Lambda, no new GSI, no new tables.

## Tasks

- [x] 1. Implement pure staleness logic functions
  - [x] 1.1 Create `src/jobs/staleness-logic.ts` with types and pure functions
    - Define `OutstandingArc` and `AccountStalenessReport` interfaces
    - Implement `isOutstandingArc(arc, cutoffDate)`: returns true iff `status === "active"` AND `urgency !== "silent"` (undefined treated as `"normal"`) AND `lastSignalAt < cutoffDate`
    - Implement `buildAccountReports(arcs)`: groups by accountId, computes count and min `lastSignalAt` per account
    - Implement `buildAccountLogEntry(report, timestamp)`: returns TRACK-level structured log object
    - Implement `buildRunCompleteLogEntry(reports, durationMs, timestamp)`: returns INFO-level structured log object
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.3_

  - [x] 1.2 Write property test: outstanding arc classification
    - **Property 1: Outstanding arc classification**
    - Generate random arcs with all valid `ArcStatus`, `ArcUrgency | undefined`, `Workflow`, and ISO timestamp values
    - Assert `isOutstandingArc` returns true iff all three conditions hold; workflow has no effect
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [x] 1.3 Write property test: account report grouping correctness
    - **Property 2: Account report grouping correctness**
    - Generate random lists of `OutstandingArc` with varying accountIds and timestamps
    - Assert one report per unique accountId, correct count, and min `lastSignalAt`
    - **Validates: Requirements 1.4, 3.5**

  - [x] 1.4 Write property test: TRACK log entry structure
    - **Property 3: TRACK log entry structure**
    - Generate random `AccountStalenessReport` and timestamp
    - Assert output contains exactly: `level: "track"`, `message: "staleness_checker.outstanding_arcs"`, `accountId`, `outstandingArcCount`, `oldestArcLastSignalAt`, `timestamp`
    - **Validates: Requirements 2.1**

  - [x] 1.5 Write property test: run-complete log entry structure
    - **Property 4: Run-complete log entry structure**
    - Generate random report lists and positive `durationMs`
    - Assert output contains exactly: `level: "info"`, `message: "staleness_checker.run_complete"`, `accountsWithOutstandingArcs` equal to list length, `totalOutstandingArcs` equal to sum of counts, `durationMs`, `timestamp`
    - **Validates: Requirements 2.3**

- [x] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Add `listActiveArcsBefore` to ArcDatabase
  - [x] 3.1 Implement `listActiveArcsBefore(accountId, beforeDate)` in `src/database/arc-database.ts`
    - Query `gsi1` with partition key `ACCT#${accountId}` and sort key between `LASTACT#active#` and `LASTACT#active#${beforeDate}#`
    - Return results in ascending `lastSignalAt` order (oldest first)
    - Cast returned items to `Arc[]`
    - _Requirements: 3.2, 3.5_

  - [x] 3.2 Write unit test for `listActiveArcsBefore`
    - Mock DynamoDB client, verify QueryCommand uses correct key condition expression
    - Verify ascending sort order (ScanIndexForward: true)
    - _Requirements: 3.2, 3.5_

- [x] 4. Integrate staleness check into domain-health-job handler
  - [x] 4.1 Add staleness check to the per-account loop in `src/jobs/domain-health-job.ts`
    - After domain health checks for each account, compute cutoff date (now - 7 days)
    - Call `arcDb.listActiveArcsBefore(accountId, cutoffDate)`
    - Filter results with `isOutstandingArc`
    - If outstanding arcs exist, emit TRACK-level log via `buildAccountLogEntry`
    - Wrap per-account staleness query in try/catch: log error at ERROR level and continue to next account
    - _Requirements: 1.1, 2.1, 2.2, 3.1, 3.4_

  - [x] 4.2 Add run-complete summary log after all accounts processed
    - Track start time at beginning of handler
    - After all accounts processed, compute duration and emit INFO-level log via `buildRunCompleteLogEntry`
    - _Requirements: 2.3, 3.3_

  - [x] 4.3 Write unit test for staleness integration in domain-health-job
    - Mock `ArcDatabase.listActiveArcsBefore` and verify TRACK logs emitted for accounts with outstanding arcs
    - Verify no log emitted for accounts with zero outstanding arcs
    - Verify error in one account does not prevent processing of remaining accounts
    - Verify run-complete log always emitted with correct totals
    - _Requirements: 2.1, 2.2, 3.4_

- [x] 5. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 4 correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses vitest + fast-check for property-based testing
- All code is TypeScript strict mode, ESM, targeting Node.js >=24
- ONE LAMBDA PER PROJECT: staleness check is added to the existing `domain-health-job.ts` handler, not a new Lambda
- Pure logic in `staleness-logic.ts` for testability; integration in `domain-health-job.ts`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "3.1"] },
    { "id": 2, "tasks": ["3.2", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3"] }
  ]
}
```
