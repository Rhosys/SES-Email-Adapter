# DRAFT — Unify alias + sender record generation into processing

> Temporary working doc for iteration. Delete before merge once agreed and
> implemented. Nothing here is implemented yet.

## Decision (chosen direction)
Create the **alias** record consistently during **ingestion / processing**, and
funnel **all** alias+sender record generation through the one code path the
processor already uses (`autoApprove`-style), instead of the ad-hoc
`ensureAliasExists` + `saveSender` calls in the quarantine-response handler, which
run with less context than the processor has. Remove alias/sender generation from
`signalsApi.ts`'s quarantine-response handler.

Critical caveat surfaced by the dependency analysis (§4): the **sender
disposition** (allow / block) is intrinsically the user's decision *at response
time* — the processor cannot know it at ingest. So "remove from the handler" must
be paired with an explicit decision about where the approve→`allow` /
block→`<policy>` write lands. See §5.

---

## 1. Business problem
A user opens a quarantined email and clicks **Approve sender**. They expect the
address it was sent to to appear in the alias list, and future mail from that
sender to be allowed. Today the alias often does not appear, because:
- An alias is a property of a **receiving address** (product model: "the alias
  exists as soon as mail arrives"), and an approved-sender is a **user decision
  about a sender**. Neither has anything to do with *why* an email was
  quarantined — yet the handler gates both on rule-evaluation output
  (`matchedRules` / synthetic `SR-00`), which is the wrong axis and where the bug
  lives.
The clean model: aliases are created by the processor for any received address;
sender dispositions are written by the explicit user/allow/block actions — all via
one shared routine, never gated on rule evaluation.

## 2. Flows / call chains
- **Flow A — Ingest → unknown-sender quarantine** (`processor.ts`): classify →
  `applyRules`/`deriveOutcome` (`:165`,`:216`) → unknown-sender fallback pushes
  synthetic `SR-00` (`:1211-1223`) → quarantine branch saves the signal and
  **returns early** (`:1248-1270`), so it never reaches the auto-approve block and
  **no `ALIAS#` record is created**.
- **Flow B — Ingest allow-path** (`processor.ts:1272-1276` → `autoApprove`
  `:1756`): the only place today that creates alias+sender together
  (`ensureAlias` then `saveSender(…, "allow")`), and it is skipped for quarantine.
- **Flow C — Approve/block handler** (`signalsApi.ts:85-194`): the contested
  `wasQuarantinedByUnknownSender` gate (`:114`) around `ensureAliasExists` +
  `saveSender` (block `:120-128`, approve `:186`/`:191`).
- **Flow D — Alias list read** (`aliasesApi.ts:59` → `listAliases`
  `account-database.ts:214`): shows only `ALIAS#…` items; a `SENDER#…` item alone
  is invisible here.
- **Data model**: `saveSender` (`account-database.ts:345`) writes `SENDER#…`;
  `ensureAlias` (`:190`) writes `ALIAS#…`; they are independent writes.

---

## 3. Proposed implementation
1. **Ingest always ensures the alias.** In `processor.ts`, ensure the `ALIAS#`
   record exists for the recipient address on every processed inbound email,
   including the quarantine branch (`:1248`) and the explicit-sender-block branch
   (`:1122`). Reuse the existing `accountDb.ensureAlias(...)` +
   `incrementStatMetric("totalAliases", …, idempotencyKey)` already used by
   `autoApprove` (`:1756-1773`). Must stay idempotent under reprocess.
2. **Extract one shared helper** (e.g. `ensureAliasAndSender(accountId, address,
   senderETLD1, policy, idempotencyKey)`) used by `autoApprove`, by the new
   quarantine/block ingest alias creation, and by the response-time sender write.
   This is the "unify … with the rest of the calls" step: one place computes
   eTLD+1, ensures the alias with the correct default `unknownSenderPolicy`, and
   increments the stat idempotently.
3. **Strip the handler.** Remove `ensureAliasExists` + `saveSender` and the
   `wasQuarantinedByUnknownSender` computation from
   `signalsApi.ts` quarantine-response. Keep the `matchedThreadId` thread reuse.
4. **Delete the now-dead `ensureAliasExists` helper** (`aliasesApi.ts:27`) — see
   §4.5; it has no other caller.

---

## 4. EXPLICIT: what depends on the handler's alias/sender writes
These are the things that break or change if we simply delete the handler writes.
Ordered by severity.

1. **(CRITICAL) Future-mail filtering depends on `saveSender("allow")` at approve.**
   At ingest the processor reads the per-sender disposition:
   `getSender(recipientAddress, senderETLD1)` (`processor.ts:867-870`) and
   `assignSystemLabels` treats the sender as trusted **only** when
   `aliasSenderConfig.policy === "allow"` (or `allow_all`) — `filter.ts:30-33`.
   The handler's `saveSender("allow")` on approve is precisely what makes the
   *next* email from that sender skip quarantine. If we remove it from the handler
   and do not relocate it, **approving a sender no longer whitelists them → every
   future email from them re-quarantines.** This write cannot move to ingest (the
   user hasn't decided yet at ingest); it must live at response time (§5).
2. **(CRITICAL) Future-mail blocking depends on `saveSender(body.status)` at block.**
   Same read path short-circuits to block when `policy !== "allow"`
   (`processor.ts:872-873`, `:1122-1123`). Blocking a quarantined email is what
   blocks *future* mail from that sender; removing the handler write means a block
   only affects the one signal.
3. **(MEDIUM) Alias-list visibility** (`listAliases`, Flow D) depends on an
   `ALIAS#` record existing. Moving creation to ingest (§3.1) satisfies this for
   all future mail; **pre-existing quarantined signals** created before this change
   will have no alias until reprocessed or acted on — note for migration.
4. **(LOW–MEDIUM) `AliasSender` → `Alias` invariant.** `ensureAliasExists` exists
   to guarantee "a sender disposition implies its alias record exists." Any
   response-time `saveSender` we keep must still ensure the alias (via the §3.2
   helper), or we recreate the drift. Note: `threadsApi.ts:201` (report-violation)
   already calls `saveSender` **without** `ensureAlias` — a pre-existing latent
   inconsistency; fold it into the shared helper while we're here.
5. **(LOW) Dead code.** `ensureAliasExists` (`aliasesApi.ts:27`) is imported only
   by `signalsApi.ts` (`:10`,`:124`,`:186`). Removing the handler calls makes it
   unused — delete it (or repurpose as the §3.2 helper).
6. **(LOW) Tests.** `tests/api/unblock-signal-update.test.ts` asserts
   `ensureAlias`/`saveSender` are called from the handler — these expectations
   move to processor tests once creation moves to ingest.

No other consumers found: `getSender`/`listSenders` callers are the ingest filter
(`processor.ts:570`,`:867`), the senders sub-resource API (`aliasesApi.ts:211-259`),
and alias rename/delete cascades (`account-database.ts:263`,`:319`) — none rely on
the quarantine handler specifically.

---

## 5. Design decision REQUIRED before implementing
Because of §4.1/§4.2, the approve→`allow` and block→`<policy>` sender writes
must still happen at response time. Pick one:

- **(5a) Keep a single sender-disposition write in the handler, via the §3.2
  shared helper.** Smallest, honest: alias creation is fully at ingest; the handler
  only records the user's sender decision through the unified routine (no rule
  inspection, full context). "Removed from the handler" becomes "the handler no
  longer *creates aliases* and no longer has ad-hoc logic — it calls the one
  shared routine."
- **(5b) Approve/block set the sender policy, then reprocess the signal.** The
  handler flips the sender disposition (shared helper) and calls
  `reprocessSignal`, letting the processor re-run the unified path end-to-end.
  Most "unified," but heavier and changes approve latency/semantics.
- **(5c) Move sender writes to a dedicated sender-management call** the UI invokes
  alongside the quarantine response (reuse `PUT …/senders/{domain}`,
  `aliasesApi.ts:242`). Cleanest separation, but requires a UI change.

Recommendation: **5a** — matches "unify the calls" with the least risk, and fully
satisfies the original complaint (alias creation leaves the handler and stops
depending on rule evaluation).

## 6. Open questions
1. Approve → whitelist sender **eTLD+1** or **exact address**? (Current code uses
   eTLD+1.)
2. Should ingest create the alias for **explicit-block** signals too, or only
   allow/quarantine? (Proposed: yes, all — an address that received mail is real.)
3. Backfill for **pre-existing quarantined signals** with no alias (§4.3)?

## 7. Tests to update
- Move alias-creation assertions from `tests/api/unblock-signal-update.test.ts`
  into `tests/processor/processor.spec.ts` (alias created on quarantine/block
  ingest, idempotent on reprocess).
- Keep, in the handler test: `matchedThreadId` thread reuse, and (per 5a) that the
  handler records the sender disposition via the shared helper.
