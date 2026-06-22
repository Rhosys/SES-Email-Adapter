# Tasks

## Task 1: Add GSI2 to signals table (infrastructure)
- [x] Add `gsi2pk` attribute definition (type S) to the signals DynamoDB table in `email-catcher/infrastructure/`
- [x] Add `global_secondary_index` block: name `gsi2`, hash key `gsi2pk`, no range key, projection type `INCLUDE`, non-key attributes `["arcId", "accountId", "id", "signalLookupId", "source", "status", "type"]`
- [x] Run `tofu plan` to verify the change is additive (no replacement)

Requirements: R5

## Task 2: Add `gsi2pk` to SignalBase type
- [x] Add `gsi2pk?: string` to the `SignalBase` interface in `src/types/index.ts`

Requirements: R1, R2

## Task 3: Implement `extractMsgId` and `buildGsi2pk` utility functions
- [x] Create `src/processor/message-id.ts` with:
  - `extractMsgId(raw: string): string | null` — extracts content between first `<` and `>`, or trims raw value if no brackets. Returns null if empty/whitespace.
  - `buildGsi2pk(accountId: string, msgId: string): string` — constructs `ACCT#{accountId}#MSGID#{msgId}`, truncates to 1024 chars.
  - `buildOutboundMsgId(sesMessageId: string, sesRegion: string): string` — returns `{sesMessageId}@{sesRegion}.amazonses.com`.
  - `extractFirstInReplyTo(headerValue: string): string | null` — extracts first msg-id from In-Reply-To header (content of first `<...>` pair). Returns null if no match.
- [x] Write unit tests for all functions: empty, null, whitespace, normal, long (>1024), multiple msg-ids, no brackets, malformed

Requirements: R1, R2, R3

## Task 4: Add `findSignalByEmailMessageId` to ArcDatabase
- [x] Add method `findSignalByEmailMessageId(gsi2pk: string): Promise<Result<{ arcId?: string; id: string; signalLookupId: string; accountId: string; status: string; source: string; type: string } | null, DbError>>` to `ArcDatabase`
- [x] Implementation: DynamoDB `Query` on index `gsi2`, `KeyConditionExpression: gsi2pk = :val`, `Limit: 1`
- [x] Return null if no items found

Requirements: R3

## Task 5: Populate `gsi2pk` on inbound signal save
- [x] In `processor.ts` `processMessage()`, after MIME parsing: extract `message-id` header via `extractMsgId(parsed.headers["message-id"])`, compute `gsi2pk` if non-null
- [x] Include `gsi2pk` on the signal object before calling `arcDb.saveSignal()`
- [x] Also populate on blocked/quarantined signals (they have a message-id too — needed so replies to quarantined emails can still thread)

Requirements: R1

## Task 6: Populate `gsi2pk` on outbound signal (draft-send-worker)
- [x] In `draft-send-worker.ts`, after successful SES send: compute `buildOutboundMsgId(messageId, SES_REGION)`, then `buildGsi2pk(accountId, outboundMsgId)`
- [x] Include `gsi2pk` in the DynamoDB update expression that transitions the signal to `status: "sent"`
- [x] Add `SES_REGION` environment variable to the Lambda configuration (same region as the SESv2 client — `eu-central-1`)

Requirements: R2

## Task 7: Implement parallel arc matching with discrepancy logging
- [x] Restructure `processMessage()` step 6 to execute all three tiers in parallel:
  - Tier 1: existing grouping key lookup (unchanged logic, just wrapped in a promise)
  - Tier 1.5: `extractFirstInReplyTo(parsed.headers["in-reply-to"])` → `buildGsi2pk` → `arcDb.findSignalByEmailMessageId` → if result has `arcId`, fetch arc
  - Tier 2: existing embedding generation + similarity search (unchanged logic, just wrapped in a promise)
- [x] Await all three results
- [x] Compare results: if multiple tiers returned arcs with different `arcId` values, log TRACK with code `"processor.arc_match_discrepancy"` including all tier results, accountId, sesMessageId, and which tier was selected
- [x] Select arc by priority: Tier 1 > Tier 1.5 > Tier 2
- [x] If no tier matched, create new arc (existing behavior)
- [x] Log selected match method as `"groupingKey"`, `"inReplyTo"`, `"similarity"`, or `"none"`
- [x] If Tier 1.5 GSI2 query fails (transient error), treat as miss (don't fail the record)

Requirements: R3, R4, R6

## Task 8: Tests for parallel arc matching
- [x] Test: all three tiers agree on same arc → no discrepancy log, arc used
- [x] Test: Tier 1 and Tier 1.5 disagree → TRACK logged, Tier 1 arc selected
- [x] Test: only Tier 1.5 matches → that arc used, no discrepancy
- [x] Test: only Tier 2 matches → that arc used
- [x] Test: no tier matches → new arc created
- [x] Test: Tier 1.5 returns signal without arcId → treated as miss
- [x] Test: Tier 1.5 GSI2 query throws → treated as miss, falls through
- [x] Test: In-Reply-To header absent → Tier 1.5 result is null, no query made

Requirements: R3, R4, R7
