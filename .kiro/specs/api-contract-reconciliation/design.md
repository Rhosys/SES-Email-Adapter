# Technical Design

## Overview

Reconcile `email-catcher/site/src/types/server.ts` and all dependent stores/components with the backend API contract at `https://api.email.rhosys.cloud/.well-known/api-catalog`. This is a find-and-replace-by-concept pass followed by a structural rewrite of the Signal type, plus UI additions for newly surfaced data.

The backend API spec is the single source of truth. The frontend types must be a verbatim mirror of it — no renames, no omissions, no invented fields.

## Architecture

### Layered change propagation

```
1. src/types/server.ts        ← rewrite types to match wire shape
2. src/lib/api.ts             ← update response type casts (no logic changes)
3. src/stores/*.ts            ← update all .id references to .{entity}Id
4. src/components/*.vue       ← update template bindings and :key attrs
5. src/views/*.vue            ← update template bindings
6. tests/**/*.ts              ← update mock objects
7. TODO.md                    ← record follow-up tasks
```

Each layer is a concept-level pass: grep before editing (define scope), replace all in one pass, grep after (zero results = done).

---

## Data Models

### Account (Req 1, 7, 11, 12)

```ts
// Backend wire shape
interface Account {
  accountId: string                                    // ✅ already fixed
  name: string
  retentionDuration?: RetentionDuration
  notifications?: NotificationSettings
  filtering?: AccountFilteringConfig
  onboarding?: AccountOnboarding
  billingPlan?: string
  afterSendAction?: 'archive' | 'keep_active'         // NEW — Req 7
  defaultCalendarInviteForwardingAddress?: string      // NEW — Req 7
  createdAt: string
  updatedAt: string
}

type RetentionDuration = 'P1M' | 'P2M' | 'P3M' | 'P5M' | 'P6M' | 'P1Y' | 'P2Y' | 'P5Y' | 'P10Y' | 'P100Y' | 'Infinity'

interface AccountOnboarding {
  completed: boolean
  completedAt?: string
}
```

**Frontend-invented fields to remove (Req 11):**
- `deletionRetentionDays` → backend uses `retentionDuration` (ISO 8601 duration string)
- `emailConfigs` → not in the API response; alias management is via `/aliases` endpoint
- `onboarding.domainAdded`, `onboarding.testEmailReceived`, `onboarding.senderConfigured`, `onboarding.notificationCoachCompleted`, `onboarding.featureTourCompleted` → backend only has `completed` and `completedAt`

**Follow-up:** The frontend onboarding wizard currently writes these granular progress fields. Either the backend needs to support them or the frontend needs to track progress client-side (localStorage).

---

### Arc (Req 1, 5, 12)

```ts
interface Arc {
  arcId: string                          // was `id`
  workflow: Workflow
  labels: string[]
  status: ArcStatus
  summary: string
  lastSignalAt: string
  deletedAt?: string                     // NEW — Req 5
  createdAt: string
  updatedAt: string
  retentionDuration?: RetentionDuration  // NEW — Req 5
  urgency?: ArcUrgency
}
```

**Frontend-invented fields to remove (Req 11):**
- `accountId` → not in the wire shape (it's implicit from the URL path)
- `groupingKey` → not in the wire shape
- `lastUserConfirmedAt` → not in the wire shape
- `ttl` → not in the wire shape
- `sentMessageIds` → not in the wire shape

---

### Signal (Req 1, 2, 3, 12)

The backend Signal is a discriminated union. Each variant shares base fields and has type-specific content under `data`.

```ts
// Shared base (appears on every variant)
interface SignalBase {
  signalId: string                       // was `id`
  arcId: string
  source: 'system' | 'user'
  status: SignalStatus
  createdAt: string
}

type SignalStatus =
  | 'active' | 'block_hidden' | 'block_reject' | 'report_violation'
  | 'quarantine_visible' | 'quarantine_hidden'
  | 'draft' | 'pending_send' | 'sent'

// Full union
type Signal =
  | EmailInboundSignal
  | EmailOutboundSignal
  | DeliverabilitySignal
  | InvalidRuleFunctionSignal
  | InvalidTemplateFunctionSignal
  | AutoSendBlockedSignal
  | CalendarEventSignal
  | CalendarResponseSignal
  | CalendarInviteInvalidSignal
  | DomainMisconfigurationSignal

interface EmailInboundSignal extends SignalBase {
  type: 'email'
  data: InboundEmailSignalData
}

interface EmailOutboundSignal extends SignalBase {
  type: 'email'
  data: OutboundEmailSignalData
}
// ... etc for each variant
```

**Frontend-invented fields to remove (Req 11):**
- `accountId` on Signal → not in wire shape
- `receivedAt` at top level → moved inside `data` for email signals
- `from`, `to`, `cc`, `subject`, `textBody`, `htmlBody`, `spamScore`, `attachments`, `workflowData`, `matchedRules` at top level → all nested under `data`

**Structural migration:** Every component that reads `signal.from`, `signal.subject`, etc. must be updated to read `signal.data.from`, `signal.data.subject` (with a type guard on `signal.type === 'email'`).

---

### Rule (Req 1, 6, 12)

```ts
interface Rule {
  ruleId: string                         // was `id`
  name: string
  condition?: string                     // optional in backend (missing = match all)
  conditionType?: 'json_logic' | 'js'    // NEW — Req 6
  actions: RuleAction[]
  status: 'enabled' | 'disabled'
  priorityOrder: number
  createdAt: string
  updatedAt: string
}

interface RuleAction {
  type: RuleActionType
  value?: string                         // backend uses generic `value` field
  disabled?: boolean                     // NEW — backend has this
}

type RuleActionType =
  | 'assign_label' | 'assign_workflow' | 'archive' | 'forward'
  | 'block_hidden' | 'block_reject' | 'quarantine' | 'quarantine_hidden'
  | 'set_urgency' | 'suppress_notification' | 'pong' | 'approve_sender'
  | 'auto_draft' | 'webhook' | 'forwardCalendarInvite'
```

**Frontend-invented fields to remove (Req 11):**
- `accountId` on Rule → not in wire shape
- `RuleAction.labelId`, `RuleAction.workflow`, `RuleAction.urgency`, `RuleAction.forwardTo`, `RuleAction.templateId` → backend uses a single `value` field for all action parameters
- `RuleActionType` values `'delete'`, `'block'`, `'auto_reply'` → not in backend; backend has `block_hidden`, `block_reject`, `webhook`, `forwardCalendarInvite` instead

**Follow-up:** The UI condition builder types (`ConditionField`, `ConditionOperator`, `ConditionLeaf`, `ConditionGroup`) are UI-only models for the visual builder. They don't go on the wire — they serialize to the `condition` JSON string. These stay.

---

### Domain + DnsRecord (Req 1, 8, 12)

```ts
interface Domain {
  domainId: string                       // was `id`
  domain: string
  receivingSetupComplete: boolean        // NEW — backend has this
  senderSetupComplete: boolean           // NEW — backend has this
  createdAt: string
  updatedAt: string
}

interface DomainWithRecords extends Domain {
  records: DnsRecord[]                   // was `dnsRecords`
}

interface DnsRecord {
  name: string                           // was `host` — Req 8
  type: 'CNAME' | 'MX' | 'TXT'
  value: string
  currentValue?: string                  // NEW — Req 8
  status: 'verified' | 'failing' | 'pending'  // `failed` → `failing`
}
```

**Frontend-invented fields to remove (Req 11):**
- `Domain.accountId` → not in wire shape
- `Domain.status` (DnsStatus) → not on Domain; backend has boolean flags instead
- `DnsRecord.ttl` → not in wire shape

---

### View (Req 1, 12)

```ts
interface View {
  viewId: string                         // was `id`
  name: string
  icon?: string
  color?: string
  workflow?: Workflow
  labels: string[]
  sortField: 'lastSignalAt' | 'createdAt'
  sortDirection: 'asc' | 'desc'
  position: number
  layout?: unknown[]                     // NEW — backend has this
  createdAt: string
  updatedAt: string
}
```

**Frontend-invented fields to remove (Req 11):**
- `accountId` → not in wire shape

---

### Label (Req 10, 12)

```ts
interface Label {
  label: string                          // was `id` — this IS the key
  name: string
  color?: string
  icon?: string
  createdAt: string
}
```

**Frontend-invented fields to remove (Req 11):**
- `id` → replaced by `label`
- `accountId` → not in wire shape

---

### ForwardingAddress (Req 9, 12)

```ts
interface ForwardingAddress {
  address: string                        // key field (was `id`)
  status: 'pending' | 'verified'
  createdAt: string
  verifiedAt?: string                    // NEW
}
```

**Frontend-invented fields to remove (Req 11):**
- `id` → replaced by `address`
- `accountId` → not in wire shape

---

### EmailTemplate (Req 1, 12)

```ts
interface EmailTemplate {
  templateId: string                     // was `id`
  name: string
  subject: string
  body: string
  functions?: TemplateFunction[]
  createdAt: string
  updatedAt: string
}

interface TemplateFunction {
  name: string
  code: string
  lastError?: string                     // NEW — backend has this
}
```

**Frontend-invented fields to remove (Req 11):**
- `accountId` → not in wire shape

---

### TeamMember (Req 1, 12)

```ts
interface TeamMember {
  userId: string
  role: UserRole
}
```

**Frontend-invented fields to remove (Req 11):**
- `id`, `accountId`, `email`, `name`, `status`, `invitedAt`, `joinedAt` → none of these are in the backend response

**Follow-up:** The UI currently displays email, name, and status for team members. The backend only returns `userId` and `role`. Either the backend needs to include display fields, or the frontend resolves them via another call (e.g. Authress user profiles).

---

### Alias (Req 12)

```ts
interface Alias {
  alias: string                          // key — was `id` / not present
  address: string
  unknownSenderPolicy: UnknownSenderPolicy
  spamScoreThreshold?: number            // NEW
  createdAt: string
  updatedAt: string
}
```

---

### AliasSender (Req 12)

```ts
interface AliasSender {
  alias: string                          // NEW — backend has this
  sender: string                         // was `domain`
  policy: SenderPolicy
  createdAt: string
  updatedAt: string
}
```

---

## Component Changes

### Signal rendering (Req 3)

Create a dispatcher component `SignalRenderer.vue` that narrows the Signal union by `type` and delegates to specialized renderers:

```
SignalRenderer.vue
  ├── EmailSignalCard.vue        (current SignalCard.vue, refactored)
  ├── DeliverabilityCard.vue     (NEW)
  ├── CalendarEventCard.vue      (NEW — includes RSVP buttons per Req 4)
  ├── CalendarResponseCard.vue   (NEW)
  ├── SystemAlertCard.vue        (NEW — covers invalid_rule_function, invalid_template_function, auto_send_blocked, domain_misconfiguration)
  └── DraftSignalCard.vue        (existing — email drafts only)
```

### Settings → Account (Req 7)

Add to the Account tab in SettingsView:
- "After send" toggle: Archive / Keep active
- "Calendar forwarding address" input (populated from verified forwarding addresses)

### Rule Editor (Req 6)

Add a `conditionType` toggle at the top of the condition section:
- `json_logic` (default) → shows existing visual builder
- `js` → shows a CodeMirror editor (already a dependency) for the JS function body

### DNS Records (Req 8)

In SettingsView domains section:
- Show `currentValue` alongside expected `value` when available (helps user see what's actually configured vs what should be)
- Change status badge text from "failed" → "failing"

---

## Migration Strategy

### Phase order (minimizes broken intermediate states)

1. **Types** — rewrite `server.ts` wholesale to match backend
2. **API layer** — update `api.ts` response casts (types change, fetch logic doesn't)
3. **Stores** — update entity key references (grep `.id` per entity, replace)
4. **Components + Views** — update template bindings, `:key` attrs, type guards for Signal union
5. **Tests** — update mock objects to match new shapes
6. **New components** — add signal type renderers, account settings fields, RSVP buttons
7. **Audit + TODO** — document unused properties and removed frontend fields

### Type-check-driven migration

After rewriting `server.ts`, `vue-tsc --noEmit` will produce errors at every mismatched usage site. This is the migration guide — fix each error, don't grep manually. The type checker finds every reference.

---

## Follow-up Tasks (to be filed in TODO.md)

### Frontend fields requiring backend support
- `OnboardingState` granular progress fields (`domainAdded`, `testEmailReceived`, etc.)
- `TeamMember` display fields (`email`, `name`, `status`, `invitedAt`)
- `Arc.groupingKey`, `Arc.sentMessageIds`

### Unused backend properties requiring UI
- `Account.retentionDuration` — needs a retention policy picker in settings
- `Account.afterSendAction` — needs a toggle in settings (Req 7 covers this)
- `Account.defaultCalendarInviteForwardingAddress` — needs input in settings (Req 7)
- `Arc.retentionDuration` — could show per-arc retention badge
- `Arc.deletedAt` — could show "deleted on" info for soft-deleted arcs
- `Rule.conditionType` — needs editor toggle (Req 6 covers this)
- `RuleAction.disabled` — needs per-action disable toggle in rule editor
- `Domain.receivingSetupComplete` / `Domain.senderSetupComplete` — needs status badges
- `DnsRecord.currentValue` — needs comparison display (Req 8 covers this)
- `View.layout` — needs layout editor (deferred to modular component system V2)
- `TemplateFunction.lastError` — needs error indicator in template editor
- `Alias.spamScoreThreshold` — needs per-alias spam threshold control
- `ForwardingAddress.verifiedAt` — needs timestamp display (Req 9 covers this)
- New Signal types (deliverability, calendar, system alerts) — Req 3 covers these

---

## Components and Interfaces

### Modified files (exhaustive list)

| File | Change |
|------|--------|
| `src/types/server.ts` | Full rewrite — all entity types, Signal union, enums |
| `src/lib/api.ts` | Update response type generics, remove `Page<T>` wrapper in favor of direct collection shapes |
| `src/stores/account.ts` | Already done (`accountId`) |
| `src/stores/arcs.ts` | `arc.id` → `arc.arcId` throughout, add `archiveArc`/`labelArc` (already moved) |
| `src/stores/signals.ts` | `signal.id` → `signal.signalId`, add type guards for Signal union |
| `src/stores/rules.ts` | `rule.id` → `rule.ruleId` |
| `src/stores/labels.ts` | `label.id` → `label.label` |
| `src/stores/views.ts` | `view.id` → `view.viewId` |
| `src/stores/templates.ts` | `template.id` → `template.templateId` |
| `src/stores/quarantine.ts` | Signal field access updates for nested `data` |
| `src/components/SignalCard.vue` | Refactor to `EmailSignalCard.vue`, read from `signal.data.*` |
| `src/components/SignalRenderer.vue` | NEW — discriminated union dispatcher |
| `src/components/DeliverabilityCard.vue` | NEW |
| `src/components/CalendarEventCard.vue` | NEW — with RSVP buttons |
| `src/components/CalendarResponseCard.vue` | NEW |
| `src/components/SystemAlertCard.vue` | NEW |
| `src/components/AppSidebar.vue` | `view.id` → `view.viewId`, `label.id` → `label.label` |
| `src/views/ArcDetailView.vue` | Signal rendering delegation |
| `src/views/InboxView.vue` | `arc.id` → `arc.arcId` |
| `src/views/RulesView.vue` | `rule.id` → `rule.ruleId` |
| `src/views/RuleEditorView.vue` | `conditionType` toggle, `RuleAction.value` generic field |
| `src/views/SettingsView.vue` | Domain boolean flags, DnsRecord `name`/`currentValue`, forwarding `verifiedAt`, account `afterSendAction` |
| `src/views/LabelsView.vue` | `label.id` → `label.label` |
| `src/views/TemplatesView.vue` | `template.id` → `template.templateId`, `lastError` display |

### New exports from `src/types/server.ts`

- `Signal` (union type)
- `EmailInboundSignal`, `EmailOutboundSignal`, `DeliverabilitySignal`, `CalendarEventSignal`, `CalendarResponseSignal`, `CalendarInviteInvalidSignal`, `InvalidRuleFunctionSignal`, `InvalidTemplateFunctionSignal`, `AutoSendBlockedSignal`, `DomainMisconfigurationSignal`
- `InboundEmailSignalData`, `OutboundEmailSignalData`, `DeliverabilitySignalData`, `CalendarEventData`, `CalendarResponseData`, etc.
- `RetentionDuration`
- `DomainWithRecords`

### API helper functions

Add type guard utilities to `src/lib/signal-guards.ts`:

```ts
export function isEmailSignal(s: Signal): s is EmailInboundSignal | EmailOutboundSignal {
  return s.type === 'email'
}
export function isCalendarEventSignal(s: Signal): s is CalendarEventSignal {
  return s.type === 'calendar_event'
}
// ... one per variant
```

---

## Correctness Properties

### Property 1: Type-check passes cleanly
After migration, `vue-tsc --noEmit` must pass with zero errors.
**Validates: Requirements 1, 2, 5, 6, 7, 8, 9, 10**

### Property 2: Test suite passes
After migration, `vitest run` must pass with zero failures (175+ existing tests).
**Validates: Requirements 1, 2, 3**

### Property 3: No unsafe casts
No `as unknown as T` casts permitted — types must flow naturally from API response to component.
**Validates: Requirements 1, 2, 11**

### Property 4: Key field consistency
Every entity `key` field used in `:key` bindings, store lookups, and API URL construction must match the wire shape field name exactly.
**Validates: Requirements 1, 10**

### Property 5: No mapping layer
The `api.ts` `request<T>()` generic must produce the correct type at every call site without intermediate mapping functions.
**Validates: Requirements 1, 2, 11, 12**

---

## Error Handling

No new error types are introduced. The existing `ApiError` (from API responses) and `NoCurrentAccountError` (precondition failure) cover all cases.

For RSVP interactions (Req 4): the `api.rsvpSignal()` method returns `Result<Signal, ApiError>`. On error, the component displays `error.message` inline and retains the RSVP buttons.

---

## Testing Strategy

1. **Type-check is the primary verification** — `vue-tsc --noEmit` catches every mismatched field access
2. **Existing tests** — update mock objects to use new field names and Signal structure; test count must not decrease
3. **New component tests** — one test per signal type renderer verifying it renders the correct content from `signal.data`
4. **RSVP interaction test** — mock `api.rsvpSignal`, verify button state transitions
5. **No E2E changes** — Playwright tests operate at the visual level and don't assert field names
