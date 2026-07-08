# DRAFT — Quarantine approve/block must not depend on rule evaluation

> Temporary working doc for iteration. Delete before merge once the approach is
> agreed and implemented. Nothing here is implemented yet.

---

## 1. Business problem (full restatement)

### What the user experiences
A user opens a **quarantined** email (an email held back because it came from an
unrecognised sender) and clicks **Approve sender**. They expect two things:

1. The email becomes an active thread they can read/reply to.
2. The address it was sent to (e.g. `receipts@theirdomain.com`) now shows up in
   **Settings → Email Addresses** (the alias list), and future mail from that
   sender is allowed through.

What actually happens: the thread activates, but **no alias appears in the alias
list**, and the sender is not reliably whitelisted.

### Why this is a real problem (product model)
The product promises (README / spec, `TODO.md` "Unlimited Aliases"):
- Any address on a registered domain that receives mail becomes a first-class
  **alias** automatically — "the alias exists as soon as mail arrives."
- Each alias carries its own filter config and **approved-senders** list.

So an alias is fundamentally a property of **a receiving address**, and an
approved-sender is a **user decision about a sender**. Neither concept has
anything to do with *why* a particular email was quarantined.

### The actual defect
The approve/block handler decides whether to create the alias and record the
sender decision by **inspecting rule-evaluation output** (`signal.data.matchedRules`).
The processor now attaches a synthetic `SR-00` "rule" to explain unknown-sender
quarantines, and that flipped the gate so the alias-creation / sender-write block
was skipped for exactly the unknown-sender case.

Root cause framed correctly: **two unrelated concerns (alias existence, sender
disposition) were coupled to a third unrelated concern (rule evaluation).** The
fix is to sever that coupling. Rule evaluation happens at ingest and answers
"should this be quarantined?" The approve/block handler is a user action and
answers "the user wants this sender allowed/blocked, and this address is real."
These must not reference each other.

---

## 2. Flows through the app / call chains that matter

### Flow A — Ingest: how a signal becomes an unknown-sender quarantine
`SES → SQS → SignalProcessor.processMessage` (`src/processor/processor.ts`):
1. Resolve account + alias config from recipient address.
2. Classify, embed, thread-match.
3. `applyRules(...)` → `deriveOutcome(...)` (`processor.ts:165`, `:216`).
4. No rule set a status **and** sender is untrusted → fallback to the alias's
   `unknownSenderPolicy`, and a **synthetic `SR-00` matched rule** is pushed with a
   `statusChange` to explain it (`processor.ts:1211-1223`).
5. Quarantine branch saves the signal and **returns early**
   (`processor.ts:1248-1270`) — it never reaches the auto-approve block, so **no
   `ALIAS#` record is created for the quarantined address**.

→ Key consequence: for unknown-sender quarantines, the alias genuinely does not
exist yet at the moment the user clicks approve.

### Flow B — User approves/blocks (THE contested code)
`UI → POST /accounts/{accountId}/signals/{id}/quarantineResponse`
→ handler in `src/api/signalsApi.ts:85-194`:
- `signalsApi.ts:114` computes
  `wasQuarantinedByUnknownSender = !matchedRules.some(r => r.statusChange && r.ruleId !== "SR-00")`.
- **Block path** (`signalsApi.ts:116-131`): `ensureAliasExists` + `saveSender`
  are BOTH nested inside `if (wasQuarantinedByUnknownSender)` — alias creation is
  still coupled to rules here.
- **Approve path** (`signalsApi.ts:133-194`): `ensureAliasExists` is now
  unconditional (`:186`), but `saveSender("allow")` is still gated (`:191`).
- (`matchedThreadId` reuse at `:140-153` is thread matching — unrelated, keep.)

### Flow C — Ingest allow-path: where aliases ARE created today
`processor.ts:1272-1276` → `SignalProcessor.autoApprove` (`processor.ts:1756`):
- Runs only when `outcome.approveSender` or `effectiveFilterMode === "allow_all"`.
- Calls `accountDb.ensureAlias(...)` then `accountDb.saveSender(..., "allow")`.
- Confirms the intended pairing (alias record + sender record) but shows it is
  bypassed entirely for the quarantine path.

### Flow D — Alias list read (what the user stares at)
`GET /accounts/{accountId}/aliases` → `aliasesApi.ts:59-77` →
`accountDb.listAliases` (`account-database.ts:214`) queries only `ALIAS#…` items.
If only a `SENDER#…` item exists (or neither), the address is invisible here.

### Data model (why the two writes are separate)
- `accountDb.saveSender` (`account-database.ts:345`) writes a `SENDER#…` item and
  does **not** create the `ALIAS#…` item.
- `accountDb.ensureAlias` (`account-database.ts:190`) writes the `ALIAS#…` item.
- `ensureAliasExists` (`aliasesApi.ts:27`) exists purely to uphold the invariant
  "a sender disposition implies the alias record exists" — it is a band-aid that
  every caller must remember to invoke alongside `saveSender`.
- `lastSignalAt` and alias/sender records are all in the accounts/signals tables;
  the alias list is driven solely by `ALIAS#` items.

---

## 3. Five possible solutions

### Solution 1 — Unconditional in the handler (smallest change)
Delete `wasQuarantinedByUnknownSender` and all `matchedRules` inspection from
`signalsApi.ts`. Approve → always `ensureAliasExists` + `saveSender(…, "allow")`.
Block → always `ensureAliasExists` + `saveSender(…, body.status)`.
- **Pros:** tiny diff; fully removes the rule/alias coupling; fixes the reported
  bug directly.
- **Cons:** approving a signal that was quarantined for a non-sender reason
  (spam label, security alert) now also whitelists the sender's whole eTLD+1.
  May be exactly what we want, or too broad — see open question.
- **Touches:** `signalsApi.ts` + its test only.

### Solution 2 — Decouple alias, narrow the sender grant
Same as Solution 1 for alias (always create). For the sender write, record the
disposition against the **exact sender address** rather than the eTLD+1 domain, so
approving one email never silently trusts an entire domain.
- **Pros:** decoupled from rules; safer default; least "surprising" whitelisting.
- **Cons:** changes approved-sender semantics (address-level vs domain-level);
  needs matching logic in the ingest matcher (`assignSystemLabels` / sender
  lookup) so future mail is actually matched at the same granularity.
- **Touches:** `signalsApi.ts`, sender-matching in `processor.ts`, tests.

### Solution 3 — Create the alias at ingest, not at approve (fix upstream)
Add the `ensureAlias` call to the quarantine branch in `processor.ts:1248-1270`
(and/or the explicit-block branch) so **every email received at a real address
creates its `ALIAS#` record immediately**, matching the "alias exists as soon as
mail arrives" spec. The approve/block handler then only records sender
disposition and never calls `ensureAliasExists`.
- **Pros:** most faithful to the product model; the alias list is correct even
  before the user ever opens quarantine; handler becomes purely about sender
  disposition + thread activation.
- **Cons:** touches the hot ingest path; adds a write (and a `totalAliases` stat
  increment) per new quarantined address; must stay idempotent on reprocess.
- **Touches:** `processor.ts` quarantine/block branches, `signalsApi.ts`, tests.

### Solution 4 — Push the invariant into the data layer
Make `accountDb.saveSender` itself ensure the `ALIAS#` record exists (call
`ensureAlias` internally) whenever a sender disposition is written. Callers
(handler, `autoApprove`) then simply call `saveSender`; alias creation becomes an
implementation detail they cannot forget. Remove `ensureAliasExists` from the
handler.
- **Pros:** eliminates the entire class of "sender without alias" drift; single
  source of truth for the invariant; call sites get simpler everywhere.
- **Cons:** `saveSender` gains a side effect (surprising name); needs the default
  `unknownSenderPolicy` available in the DB layer; still leaves the "always create
  alias on approve even without a sender write" question to the handler.
- **Touches:** `account-database.ts` (`saveSender`), remove `ensureAliasExists`
  helper, `signalsApi.ts`, `autoApprove`, tests.

### Solution 5 — Derive the alias list from received mail (data-model change)
Stop treating `ALIAS#` as a record that must be explicitly created and kept in
sync. Instead derive/participate the alias list from the set of recipient
addresses that have actually received signals (a GSI/projection keyed by
`recipientAddress`, or a maintained set), so the list can never be missing an
address that got mail. Explicit `ALIAS#` items remain only for per-alias config
overrides.
- **Pros:** structurally impossible to "lose" an alias; removes ensureAlias
  band-aids; alias list always reflects reality.
- **Cons:** largest change; new index/projection + read-path rewrite of
  `listAliases`; migration for existing data; overkill for the immediate bug.
- **Touches:** `thread-database.ts`/`account-database.ts` schema + GSI,
  `listAliases`, ingest write path, migration, broad tests.

---

## 4. Recommendation (for discussion)
Short term, **Solution 1** (or **Solution 3** if we want the alias list correct
before the user ever touches quarantine) resolves the reported bug and the
coupling with minimal risk. **Solution 4** is the best "make it impossible to
regress" cleanup and pairs well with either. **Solution 5** is the long-term
correct model but out of scope for this fix.

## 5. Open questions
1. On **approve**, whitelist the sender's whole **eTLD+1** domain, or only the
   exact sender address? (Solution 1 vs 2.)
2. Should **block** also always create the alias, or is an alias for a
   never-wanted address undesirable noise in the list?
3. Do we want aliases to exist the moment mail is quarantined (Solution 3), or
   only once the user acts on it?

## 6. Tests to update when implemented
`tests/api/unblock-signal-update.test.ts`: drop/invert the "content-rule
quarantine → no sender allow" expectation; keep alias-ensured-on-approve/block
and the `matchedThreadId` thread-reuse assertions.
