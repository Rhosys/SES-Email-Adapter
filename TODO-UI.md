# TODO-UI — Frontend Work

Frontend work derived from backend capabilities. Covers screens, components, API integration, validations, and real-time features.

Surfaces: **Website** · **Extension** · **Mobile** · **CLI/Desktop**

---

## Feature Gap Summary

| Feature | Website | Extension | Mobile |
|---------|---------|-----------|--------|
| Arcs (inbox, detail, actions) | ✅ | ❌ | ❌ |
| Signals (thread, drafts, send) | ✅ | ❌ | ❌ |
| Quarantine | ✅ | ❌ | ❌ |
| Views (custom filters) | ✅ | ❌ | ❌ |
| Labels | ✅ | ❌ | ❌ |
| Rules (incl. JS code editor) | ✅ | ❌ | ❌ |
| Domains (register, DNS, verify) | ✅ | 🟡 reads list | ❌ |
| Aliases (CRUD, sender policies) | ✅ | 🟡 create/search | ❌ |
| Forwarding addresses | 🟡 missing verify UI | ❌ | ❌ |
| Templates (CRUD, functions) | ✅ | ❌ | ❌ |
| Account settings | 🟡 partial | ❌ | ❌ |
| Team/Users | ✅ | ❌ | ❌ |
| Search | ✅ | ❌ | ❌ |
| WebSocket (real-time) | ✅ | ❌ | ❌ |
| Notifications (push) | 🟡 tab-only | ❌ | ❌ |
| Audit log | ✅ | ❌ | ❌ |
| Billing | 🟡 UI ready, no backend | ❌ | ❌ |
| OTP autofill | ❌ | ❌ | ❌ |
| Domain DELETE | ❌ | ❌ | ❌ |

---

## Website — Missing / Partial

- [ ] **Account settings: filtering config** — no UI for global `defaultUnknownSenderPolicy`, `newAddressHandling`, `spamScoreThreshold`
  - Website
- [ ] **Account settings: deletionRetentionDays** — no UI to configure how long deleted arcs are kept
  - Website
- [ ] **Account settings: afterSendAction** — no UI to choose archive vs keep_active after sending
  - Website
- [ ] **Account stats dashboard** — `GET /accounts/:id/stats` endpoint exists, no UI
  - Website
- [ ] **Forwarding address verification UI** — no route/view to handle the token submission from the verification email link
  - Website
- [ ] **Domain DELETE** — backend supports `DELETE /domains/:id`, site API client doesn't expose it, no UI
  - Website
- [ ] **Web Push service worker** — notifications only work while tab is open (via WebSocket). Need: service worker registration, push subscription management, background notifications
  - Website
- [ ] **Unapproved sender breach hint** — when viewing a quarantined signal (or any arc/signal from an unapproved sender), fetch the alias's approved senders list and display them. Surface a suggestion: "One of these approved senders likely shared or sold your address." Recommend `violate_report` as the primary action. Applies to quarantine review and arc detail for signals from unknown senders.
  - Website
- [ ] **Workflow-specific structured data cards** — `workflowData` fields should render as rich cards (tracking links, OTP codes, invoice amounts, flight details) instead of raw text
  - Website · Mobile

---

## Extension — Missing Features

The extension is currently alias-generation only. These are features that would make it a fuller companion:

- [ ] **OTP autofill** — receive auth codes via WebSocket/Web Push, match to active tab, inject into focused input
  - Extension
- [ ] **WebSocket connection** — connect to WS for real-time signal notifications (at minimum for auth/OTP workflow)
  - Extension
- [ ] **Web Push service worker** — receive push notifications when tab is closed; show OTP codes as notification actions
  - Extension
- [ ] **Quick inbox view** — popup showing recent arcs (last 5-10) with urgency badges, one-click archive
  - Extension
- [ ] **Quarantine notifications** — badge count on extension icon when quarantined signals await review; popup action to approve/block
  - Extension
- [ ] **Domain management** — currently read-only; add ability to register new domains from extension popup
  - Extension
- [ ] **Alias sender policy management** — after creating an alias, allow configuring sender policies from the popup
  - Extension
- [ ] **Input validation** — zero client-side validation currently; add email format, domain format checks
  - Extension

---

## Mobile — Full App (Future)

- [ ] **Inbox (arc list)** — workflow icons, urgency badges, sender, summary, labels, swipe actions
  - Mobile
- [ ] **Arc detail (signal thread)** — chronological signal cards, workflow data panels, reply composer
  - Mobile
- [ ] **OTP autofill via OS framework** — Android Autofill Framework / iOS AutoFill Credential Provider; surface codes as autofill suggestions
  - Mobile
- [ ] **Push notifications (FCM)** — receive signal:created events, deep-link to arc; OTP codes as actionable notifications
  - Mobile
- [ ] **Quarantine review** — approve/block quarantined signals from notification or dedicated screen
  - Mobile
- [ ] **Settings** — account, domains, aliases, forwarding, team, notifications
  - Mobile
- [ ] **Search** — full-text across arcs
  - Mobile
- [ ] **Offline support** — cache recent arcs/signals for offline viewing
  - Mobile

---

## OTP / Auth Code Autofill

Backend pushes `{ code, expiresInMinutes, originDomain, signalId }` via WebSocket + Web Push + FCM when an `auth` workflow signal arrives.

- [ ] **Receive OTP via WebSocket** — listen for `auth_code` message type on the existing WS connection
  - Extension · Website
- [ ] **Receive OTP via Web Push** — service worker receives push event with OTP payload; show notification with "Copy code" action
  - Extension
- [ ] **Receive OTP via FCM push** — parse structured payload; show notification with code and "Autofill" action
  - Mobile
- [ ] **Match originDomain to active tab** — compare against active tab's eTLD+1; if match, autofill; if not, show popup
  - Extension
- [ ] **Autofill into focused input** — detect code input (type=text/tel, autocomplete=one-time-code); inject value; dispatch events
  - Extension
- [ ] **OS autofill framework** — register as autofill provider; surface OTP codes as suggestions
  - Mobile
- [ ] **Copy-to-clipboard fallback** — toast/popup with code + one-tap copy + countdown timer
  - Extension · Website · Mobile
- [ ] **Expiry countdown** — show remaining validity; auto-dismiss when expired
  - Extension · Website · Mobile
- [ ] **OTP inline on arc row** — show code directly on the arc card with "Copy" button (no need to open email)
  - Website · Mobile
- [ ] **Deep-link from notification** — tapping notification opens the specific auth arc
  - Website · Mobile

---

## Client-Side Validations

Validations from the backend that could run client-side for instant feedback.

### Rules
- [ ] Code/condition size limit (10KB) — byte counter
  - Website · Extension · CLI/Desktop
- [ ] Code AST validation (acorn) — inline syntax errors as user types
  - Website · Extension
- [ ] conditionType requires code field — disable save when empty
  - Website · Extension · Mobile
- [ ] Condition valid JSON — parse on blur
  - Website · Extension
- [ ] Condition valid JSONLogic — dry-run with json-logic-js
  - Website · Extension
- [ ] Actions min 1 — disable save when empty
  - Website · Extension · Mobile
- [ ] Action type enum — constrained dropdown (14 values)
  - Website · Extension · Mobile

### Templates
- [ ] Function name valid JS identifier — regex on keystroke
  - Website · Extension
- [ ] Function code size limit (10KB) — byte counter
  - Website · Extension · CLI/Desktop
- [ ] Function code AST validation — same as rule code
  - Website · Extension

### Aliases
- [ ] unknownSenderPolicy enum — dropdown
  - Website · Extension · Mobile
- [ ] Email format validation — RFC 5322 regex (site has it, extension doesn't)
  - Extension · Mobile
- [ ] spamScoreThreshold 0–1 — slider/constrained input
  - Website · Mobile

### Account Settings
- [ ] deletionRetentionDays positive integer — constrained input
  - Website · Mobile
- [ ] afterSendAction enum — toggle
  - Website · Mobile
- [ ] notification frequency enum — dropdown
  - Website · Mobile
- [ ] newAddressHandling enum — toggle
  - Website · Mobile

### Team
- [ ] Invite email format — validate before submit
  - Website · Extension · Mobile
- [ ] Role enum — dropdown (admin, member, viewer)
  - Website · Mobile

---

## Notes

- The **website** has most backend features implemented but is missing: account filtering settings, retention config, afterSendAction, stats dashboard, forwarding verification UI, domain deletion, Web Push, and workflow data cards
- The **extension** is narrowly scoped to alias generation — no inbox, no real-time, no notifications, no validation
- A shared validation package (Zod schemas + acorn AST validator) could serve website, extension, and mobile
- The mobile app doesn't exist yet — all items are greenfield

---

## Security & Trust — Outbound Validation

- [ ] **Signal detail: show envelope metadata** — Display Return-Path, Reply-To, CC with trust indicators. Show warning if Reply-To domain ≠ From domain. Show warning if user was BCC'd (recipient not in To/CC).
  - Website · Extension · Mobile
- [ ] **Manual compose: unapproved recipient warning** — When composing/replying, if any To/CC/BCC domain is not in the alias's approved senders list, prompt user to confirm and offer to add to approved senders.
  - Website
- [ ] **Auto-send suppression indicator** — When auto-send is suppressed due to Reply-To domain mismatch, show explanation on the draft signal's compose page with the reason.
  - Website
