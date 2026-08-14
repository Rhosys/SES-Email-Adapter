# Implementation Plan: Thread Snooze

## Overview

One code change: clear `followupAt` when the processor reactivates an archived thread due to a new signal. Everything else already works.

## Tasks

- [ ] 1. Clear `followupAt` on processor reactivation
  - [ ] 1.1 In `src/processor/processor.ts`, when the processor reactivates an archived thread (the block near line 1368 where `matchedThread.status === "archived" && thread.status === "active"`), pass `followupAt: ""` (empty string to trigger the DynamoDB REMOVE) in the `updateThread` fields so the stale snooze timestamp is wiped
    - _Requirements: 1.1_

  - [ ] 1.2 Verify `updateThread` handles clearing `followupAt` — check that passing an empty string or explicit clear value removes the attribute from DynamoDB rather than storing an empty string
    - _Requirements: 1.1_

- [ ] 2. Run `npm test` to confirm no regressions
  - _Requirements: 1.2_
