# Design Document

## Overview

Snooze is already implemented — it's `PATCH /threads/:id` with `{ followupAt, status: "archived" }`. The scheduler fires, the FollowupHandler reactivates archived → active. `followupAt` is already persisted and returned in the API.

The one missing behavior: when a new signal arrives and the processor reactivates the thread, it doesn't clear `followupAt`. This leaves a stale `followupAt` on the thread, making the UI think it resurfaced on schedule when it actually woke early.

## Change

In `src/processor/processor.ts`, at the point where it reactivates an archived thread (around line 1368–1398), add `followupAt` clearing to the `updateThread` call's fields object when the matched thread was archived.

## UI contract (no backend change needed)

| status | followupAt | UI meaning |
|--------|-----------|------------|
| `archived` | future | Currently snoozed |
| `active` | past | Resurfaced on schedule — show badge |
| `active` | absent | Normal (or woke early) |
