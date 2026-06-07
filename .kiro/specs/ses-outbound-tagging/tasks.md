# Implementation Plan: SES Outbound Tagging

## Overview

Namespace all outbound SES message tags with `X-Numaeel-`, add correlation tags (SignalId, ArcId, AccountId) to every outbound path, and update the feedback processor to read the new prefixed tag names. Implementation proceeds bottom-up: shared tag module → interface expansion → caller updates → feedback processor.

## Tasks

- [x] 1. Create tag construction module
  - [x] 1.1 Create `src/email/ses-tags.ts` with TAG_PREFIX constant, tag name constants, TagContext interface, OutboundType type, and `buildOutboundTags` pure function
    - Export `TAG_PREFIX = "X-Numaeel-"`, `TAG_TYPE`, `TAG_ACCOUNT_ID`, `TAG_SIGNAL_ID`, `TAG_ARC_ID`
    - Export `TagContext` interface with optional `accountId`, `signalId`, `arcId`
    - Export `OutboundType = "reply" | "forward" | "draft-send"`
    - Export `buildOutboundTags(type, context?)` returning `Array<{ Name: string; Value: string }>`
    - Omit tags for empty/undefined correlation IDs
    - _Requirements: 1.1, 1.2, 3.8, 4.5_

  - [x] 1.2 Write unit tests for `ses-tags.ts` in `src/email/ses-tags.test.ts`
    - Test TAG_PREFIX equals `"X-Numaeel-"`
    - `it.each` table covering: reply with no context → only Type tag; forward with accountId → Type + AccountId; reply with all three IDs → four tags; empty signalId → SignalId absent; undefined arcId → ArcId absent
    - Verify every tag name starts with TAG_PREFIX for each type × context combination (Property 1)
    - Verify non-empty IDs produce corresponding tags (Property 2)
    - Verify empty/undefined IDs omit tags (Property 3)
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4, 3.8_

- [x] 2. Expand ReplySender and Forwarder interfaces
  - [x] 2.1 Update `ReplySender` interface in `src/processor/processor.ts` to add optional `accountId`, `signalId`, `arcId` fields to the `sendReply` opts parameter
    - _Requirements: 6.1, 6.2_

  - [x] 2.2 Update `Forwarder` interface in `src/processor/processor.ts` to accept an optional `opts` parameter `{ signalId?: string; arcId?: string }` after `accountId`
    - _Requirements: 7.1, 7.4_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Update ExternalEmailSignalHandler to build tags
  - [x] 4.1 Update `sendReply` in ExternalEmailSignalHandler to call `buildOutboundTags("reply", { accountId, signalId, arcId })` using the optional fields from opts, and pass the resulting tags to EmailService
    - _Requirements: 2.1, 4.1, 6.3, 6.4, 6.5_

  - [x] 4.2 Update `forward` in ExternalEmailSignalHandler to call `buildOutboundTags("forward", { accountId, signalId: opts?.signalId, arcId: opts?.arcId })` and pass the resulting tags to EmailService
    - _Requirements: 2.2, 4.2, 7.2, 7.3_

  - [x] 4.3 Write unit tests for ExternalEmailSignalHandler tag integration in the existing test file
    - `sendReply` without optional fields → tags = [Type:reply]
    - `sendReply` with all fields → tags include AccountId, SignalId, ArcId
    - `forward` without opts → tags = [Type:forward, AccountId:X]
    - `forward` with signalId + arcId → tags include all four
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 7.2, 7.3, 7.4_

- [x] 5. Update processor side-effects to pass correlation context
  - [x] 5.1 Update the pong side-effect in `SignalProcessor.processSideEffect` to pass `accountId`, `signalId: signal.id`, `arcId: arc.id` to `replySender.sendReply`
    - _Requirements: 2.4, 3.7, 4.4_

  - [x] 5.2 Update the forward side-effect in `SignalProcessor.processSideEffect` to pass `{ signalId: signal.id, arcId: arc.id }` as the opts parameter to `forwarder.forward`
    - _Requirements: 3.3, 3.4_

  - [x] 5.3 Write unit tests for processor side-effects verifying correlation context is passed
    - Pong calls sendReply with accountId, signalId, arcId
    - Forward calls forwarder.forward with signalId, arcId in opts
    - _Requirements: 2.4, 3.3, 3.4, 3.7, 4.4_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Update DraftSendWorker to include tags
  - [x] 7.1 Update `DraftSendWorker.process` to pass `accountId`, `signalId: signal.id`, `arcId: signal.arcId` to `replySender.sendReply`
    - _Requirements: 2.3, 3.5, 3.6, 4.3_

  - [x] 7.2 Write unit tests for DraftSendWorker tag inclusion
    - Successful send includes accountId, signalId in sendReply opts
    - Signal with arcId → arcId passed in opts
    - Signal without arcId → arcId omitted or empty
    - _Requirements: 2.3, 3.5, 3.6, 3.8, 4.3_

- [x] 8. Update FeedbackProcessor to read prefixed tag names
  - [x] 8.1 Update `FeedbackProcessor.processFeedback` to import tag name constants from `ses-tags.ts` and read `TAG_ACCOUNT_ID`, `TAG_TYPE`, `TAG_SIGNAL_ID`, `TAG_ARC_ID` from feedback notification tags instead of bare names
    - _Requirements: 5.1, 5.2_

  - [x] 8.2 Implement direct signal lookup when `TAG_SIGNAL_ID` is present — look up signal by ID directly instead of querying by SES message ID
    - Add `getSignalById` to the FeedbackSignalStore interface if not already present
    - When `TAG_SIGNAL_ID` is present, call `getSignalById` for direct lookup
    - _Requirements: 5.4_

  - [x] 8.3 Implement direct arc assignment when `TAG_ARC_ID` is present — assign deliverability signal to that arc without arc-matching lookup
    - _Requirements: 5.5_

  - [x] 8.4 Implement fallback logic: if neither `TAG_SIGNAL_ID` nor `TAG_ACCOUNT_ID` is present, fall back to existing `getSignalByMessageId` path; if `TAG_ACCOUNT_ID` is absent, skip account-specific correlation and proceed with address suppression only
    - _Requirements: 5.3, 5.6_

  - [x] 8.5 Write unit tests for FeedbackProcessor prefixed tag reading
    - Bounce with `X-Numaeel-AccountId` + `X-Numaeel-Type=forward` → disables forward rules
    - Bounce without `X-Numaeel-AccountId` → suppression only
    - Bounce with `X-Numaeel-SignalId` → direct signal lookup used
    - Bounce with `X-Numaeel-ArcId` → deliverability signal assigned to that arc
    - Bounce without any new tags → falls back to SES message ID lookup
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints run `npm test` (tsc --noEmit -p tsconfig.check.json && vitest run)
- The project uses static expectations only — no fast-check or random generation
- Property tests are implemented as `it.each` tables over finite meaningful inputs
- Error handling uses neverthrow Result types throughout

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.2"] },
    { "id": 2, "tasks": ["4.1", "4.2", "5.1", "5.2", "7.1"] },
    { "id": 3, "tasks": ["4.3", "5.3", "7.2"] },
    { "id": 4, "tasks": ["8.1"] },
    { "id": 5, "tasks": ["8.2", "8.3", "8.4"] },
    { "id": 6, "tasks": ["8.5"] }
  ]
}
```
