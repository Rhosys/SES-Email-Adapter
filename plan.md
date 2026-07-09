# Alias + sender records are owned by processing, not by the quarantine handler

> Working doc for TDD. Assumes the reprocess `lastSignalAt` fix is already done.
> Scope: inbound email processing + the quarantine-response handler.

## Model (the whole thing in three rules)
1. **Alias is an invariant of a received address.** Every inbound email the
   processor accepts is to a real address on a registered domain, so the
   processor **always** ensures the `ALIAS#` record exists — before any
   disposition branch, for every outcome (active / quarantine / block). Idempotent.
2. **A `SENDER#` record only ever means `allow` or a block policy** — there is no
   "quarantine" sender policy (`SENDER_POLICIES = allow | block_hidden |
   block_reject | report_violation`). An unknown/pending sender therefore has **no**
   sender record; the alias's `unknownSenderPolicy` governs its default handling.
3. **A sender disposition is only written when it is actually decided.** At ingest
   that is exactly the `allow` case (allow_all, or an `approve_sender` rule) —
   today's `autoApprove`. The quarantine-response *is* the user deciding, so the
   approve→`allow` / block→`<policy>` write happens there — unconditionally, with
   no rule inspection, and with no `ensureAlias` (guaranteed by rule 1).

Consequence: the quarantine handler stops calling `ensureAliasExists` entirely and
stops inspecting `matchedRules`. `ensureAliasExists` (`aliasesApi.ts:27`) becomes
dead and is deleted; alias creation moves into the processor where the account,
alias config, default policy and idempotency key are already in hand (the "missing
critical information" the handler lacked).

---

## Matrix A — actions AT INGEST (processing an inbound email)
Columns: existing `SENDER#` record · alias `unknownSenderPolicy` · rule outcome →
resulting signal status · **ensureAlias** · **saveSender**.

| # | Existing sender | Alias policy | Rule outcome | → Status | ensureAlias | saveSender |
|---|-----------------|--------------|--------------|----------|-------------|------------|
| 1 | `allow` | any | none | active | ✔ (idempotent) | — (already allow) |
| 2 | `block_*` | any | none | block per sender policy | ✔ | — (already set) |
| 3 | none | any | `approve_sender` fires (e.g. SR-01) | active | ✔ | **allow** |
| 4 | none | `allow_all` | none | active | ✔ | **allow** |
| 5 | none | `quarantine_visible` | none | quarantine_visible | ✔ **(new)** | — |
| 6 | none | `quarantine_hidden` | none | quarantine_hidden | ✔ **(new)** | — |
| 7 | none | `block_hidden` / `block_reject` / `report_violation` | none | block per alias policy | ✔ **(new)** | — |
| 8 | none/allow | any | content rule → quarantine (SR-02/03/05/06 or user rule) | quarantine | ✔ **(new)** | — |
| 9 | none/allow | any | content rule → block (e.g. SR-04) | block | ✔ **(new)** | — |
| 10 | n/a | n/a | DKIM/DMARC fail (pre-classify hard block, `processor.ts:761`) | block_reject | ✔ **(new)** * | — |

`—` = no sender write. **(new)** = behaviour this change adds (today only rows
1/2/3/4 ensure the alias, via `autoApprove` or a pre-existing record).

\* Row 10 open call: the recipient is real, so ensuring the alias is consistent
with rule 1, but this path builds a minimal signal before classification. Default:
include it. Flag if we'd rather keep that path minimal.

Implementation note: satisfy rows 5–10 with **one** idempotent `ensureAlias` call
placed immediately after account/alias resolution (`processor.ts:~716`), before
the first early-return disposition branch, so every path inherits it. `autoApprove`
keeps its `saveSender("allow")` (rows 3/4); its own `ensureAlias` becomes redundant
and can defer to the top-level call.

---

## Matrix B — actions AT QUARANTINE RESPONSE (user acts on a held signal)
The handler no longer touches aliases (rule 1 guarantees them). It only records
the user's sender decision, unconditionally.

| User action (`body.status`) | Signal status change | ensureAlias | saveSender |
|---|---|---|---|
| `active` (approve) | → active + (re)attach thread | — (exists) | **allow** |
| `block_hidden` | → block_hidden | — | **block_hidden** |
| `block_reject` | → block_reject | — | **block_reject** |
| `report_violation` | → report_violation | — | **report_violation** |

Why unconditional (no check, no lookup): to reach `quarantineResponse` the signal
is quarantined, so `saveSender` must always run. We do **not** and should not read
`getSender`/`matchedRules` first — a quarantined signal that the user is deciding
on has no settled allow/block record for that sender, and in the one case where it
does (a content rule quarantined an already-`allow`ed sender), the unconditional
write is still correct: approve→`allow` is idempotent, block→ records the user's
explicit new decision. Sender scope = eTLD+1 (unchanged). The handler's only
sender-related work is this one `saveSender`; `ensureAliasExists` is removed
(alias guaranteed at ingest). Also fold `threadsApi.ts:201` (report-violation on a
thread, which calls `saveSender` without `ensureAlias`) onto the same guarantee.

---

## Implementation checklist
1. Processor: one invariant `ensureAlias(...)` right after account/alias
   resolution (covers Matrix A rows 5–10); keep `autoApprove`'s `saveSender`.
2. `signalsApi.ts` quarantine-response: delete `wasQuarantinedByUnknownSender`,
   delete both `ensureAliasExists` calls, keep a single unconditional `saveSender`
   per Matrix B; keep `matchedThreadId` thread reuse.
3. Delete `ensureAliasExists` (`aliasesApi.ts:27`) — now unused.
4. No migration (explicitly out of scope).

## TDD tests to create (one per distinct matrix row)
- **Processor** (`tests/processor/processor.spec.ts`): rows 5–10 assert
  `ensureAlias` called once with the recipient address and the signal still
  reaches the expected status; rows 3/4 assert `ensureAlias` + `saveSender("allow")`;
  rows 1/2 assert no duplicate/conflicting sender write; idempotent on reprocess.
- **Handler** (`tests/api/unblock-signal-update.test.ts`): Matrix B — approve →
  `saveSender allow` and never `ensureAlias`; each block status → matching
  `saveSender`; no `matchedRules`-dependent branching; `matchedThreadId` reuse
  still holds.
