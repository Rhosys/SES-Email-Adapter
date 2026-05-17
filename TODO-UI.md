# TODO-UI — Frontend Validation Opportunities

Validations from the backend that could be replicated client-side for instant feedback.

Surfaces: **Website** · **Extension** · **Mobile** · **CLI/Desktop**

---

## Rules

- [ ] **Code size limit (10KB)** — show byte counter, reject before upload
  - Website · Extension · CLI/Desktop
- [ ] **Code AST validation** — parse with acorn in-browser, show inline syntax errors with line/column as user types; reject disallowed nodes (eval, Function, import, require, globalThis/process/Deno/Bun, unbounded loops, var)
  - Website · Extension
- [ ] **conditionType requires code field** — disable save when conditionType is "js" but code is empty
  - Website · Extension · Mobile
- [ ] **Condition size limit (10KB)** — byte counter
  - Website · Extension · CLI/Desktop
- [ ] **Condition valid JSON** — JSON.parse on blur, show syntax error inline
  - Website · Extension
- [ ] **Condition valid JSONLogic** — dry-run with json-logic-js against empty context, show operator errors
  - Website · Extension
- [ ] **Actions min 1** — disable save when actions array is empty
  - Website · Extension · Mobile
- [ ] **Action type enum** — type-safe dropdown (14 values: assign_label, assign_workflow, archive, delete, forward, block_hidden, block_reject, quarantine, quarantine_hidden, set_urgency, suppress_notification, pong, approve_sender, auto_draft)
  - Website · Extension · Mobile
- [ ] **priorityOrder integer ≥ 0** — input constraint
  - Website · Mobile
- [ ] **status enum** — toggle between enabled/disabled only
  - Website · Extension · Mobile

---

## Templates

- [ ] **Template name min 1 char** — disable save when empty
  - Website · Mobile
- [ ] **Function name valid JS identifier** — validate `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/` on keystroke
  - Website · Extension
- [ ] **Function code size limit (10KB per function)** — byte counter
  - Website · Extension · CLI/Desktop
- [ ] **Function code AST validation** — same as rule code (acorn parse + disallowed node walk)
  - Website · Extension

---

## Aliases

- [ ] **unknownSenderPolicy enum** — dropdown (allow_all, quarantine_visible, quarantine_hidden, block_hidden, block_reject, violate_report)
  - Website · Extension · Mobile
- [ ] **Email format validation** — RFC 5322 regex on blur (site already has `isValidEmail`, extension has nothing)
  - Extension · Mobile
- [ ] **spamScoreThreshold 0–1 range** — slider or constrained number input
  - Website · Mobile

---

## Alias Senders

- [ ] **Sender policy enum** — dropdown (allow, block_hidden, block_reject, violate_report)
  - Website · Extension · Mobile

---

## Views

- [ ] **Workflow enum** — dropdown (15 values)
  - Website · Mobile
- [ ] **sortField enum** — dropdown (lastSignalAt, createdAt)
  - Website · Mobile
- [ ] **sortDirection enum** — toggle (asc, desc)
  - Website · Mobile

---

## Arcs

- [ ] **Status enum** — constrained to active/archived/deleted
  - Website · Mobile
- [ ] **Urgency enum** — dropdown (critical, high, normal, low, silent)
  - Website · Mobile

---

## Signals (Drafts)

- [ ] **To min 1 recipient** — disable send when to array is empty
  - Website · Mobile
- [ ] **Draft status guard** — only show edit/send/delete actions on draft signals
  - Website · Mobile

---

## Account Settings

- [ ] **deletionRetentionDays positive integer** — constrained number input
  - Website · Mobile
- [ ] **spamScoreThreshold 0–1 range** — slider
  - Website · Mobile
- [ ] **afterSendAction enum** — toggle (archive, keep_active)
  - Website · Mobile
- [ ] **notification frequency enum** — dropdown (instant, hourly, daily)
  - Website · Mobile
- [ ] **newAddressHandling enum** — toggle (auto_allow, block_until_approved)
  - Website · Mobile

---

## Users (Team)

- [ ] **Invite email format** — validate before submit (extension already has no validation)
  - Website · Extension · Mobile
- [ ] **Role enum** — dropdown (admin, member, viewer)
  - Website · Mobile

---

## Notes

- The **site** currently has only `isValidEmail()` and `isValidDomain()` in `src/lib/validation.ts` — everything else is missing
- The **extension** has zero client-side validation — all payloads sent directly to API
- Highest UX impact: rule code AST validation (instant syntax feedback), JSONLogic validation, size limits with byte counters, enum-constrained dropdowns
- Shared validation logic (Zod schemas, acorn AST validator) could be published as an internal package consumed by both site and extension


---

## OTP / Auth Code Autofill

Backend pushes `{ code, expiresInMinutes, originDomain, signalId }` via WebSocket + Web Push + FCM when an `auth` workflow signal arrives.

- [ ] **Receive OTP via WebSocket** — listen for `auth_code` message type on the existing WS connection; parse payload
  - Extension · Website
- [ ] **Receive OTP via Web Push** — service worker receives push event with OTP payload; show notification with "Copy code" action button
  - Extension
- [ ] **Receive OTP via FCM push notification** — parse structured payload from push; show notification with code and "Autofill" action
  - Mobile
- [ ] **Match originDomain to active tab** — compare `originDomain` from payload against the active tab's eTLD+1; if match, proceed to autofill; if no match, show popup with code + "Copy" button
  - Extension
- [ ] **Autofill OTP into focused input** — detect the focused input field (type=text, type=tel, or autocomplete=one-time-code); inject the code value; dispatch input/change events so frameworks detect the change
  - Extension
- [ ] **Autofill via OS autofill framework** — register as an autofill provider (Android Autofill Framework / iOS AutoFill Credential Provider); surface OTP codes as autofill suggestions when the OS detects a code input field
  - Mobile
- [ ] **Copy-to-clipboard fallback** — if no matching tab or no focused input, show a toast/popup with the code and a one-tap copy button; include countdown timer showing `expiresInMinutes`
  - Extension · Website · Mobile
- [ ] **Expiry countdown** — show remaining validity time on the OTP notification/popup; auto-dismiss when expired
  - Extension · Website · Mobile
- [ ] **OTP notification in inbox** — show the code inline on the arc row (no need to open the email); "Copy" button directly on the arc card
  - Website · Mobile
- [ ] **Deep-link from notification** — tapping the push notification opens the app/site to the specific auth arc
  - Website · Mobile

---

## Notes

- The **site** currently has only `isValidEmail()` and `isValidDomain()` in `src/lib/validation.ts` — everything else is missing
- The **extension** has zero client-side validation — all payloads sent directly to API
- Highest UX impact: rule code AST validation (instant syntax feedback), JSONLogic validation, size limits with byte counters, enum-constrained dropdowns
- Shared validation logic (Zod schemas, acorn AST validator) could be published as an internal package consumed by both site and extension
