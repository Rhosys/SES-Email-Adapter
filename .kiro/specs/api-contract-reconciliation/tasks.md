# Implementation Plan: API Contract Reconciliation

## Overview

Align the email-catcher site frontend types, stores, components, and views with the backend API contract. Each task is executed serially — type-check + tests must pass and a commit must be created before proceeding to the next task.

## Tasks

- [x] 1. Rewrite `src/types/server.ts` to match backend wire shape exactly
  - [x] 1.1 Fetch the full API spec from `https://api.email.rhosys.cloud/.well-known/api-catalog`. Rewrite all entity interfaces (field names, types, optionality). Define Signal as a discriminated union by `type` with nested `data` fields per variant. Add all signal variant types and data interfaces. Rename ID fields: `Arc.id` → `arcId`, `Rule.id` → `ruleId`, `Domain.id` → `domainId`, `SavedView.id` → `viewId`, `EmailTemplate.id` → `templateId`. Rewrite Label (key=`label`), ForwardingAddress (key=`address`), TeamMember (`{userId, role}`), DnsRecord (`host`→`name`, add `currentValue`, `failed`→`failing`), Domain (remove `status`/`dnsRecords`, add boolean flags, add `DomainWithRecords`), RuleAction (generic `value`+`disabled`), Account (add `afterSendAction`/`retentionDuration`/`defaultCalendarInviteForwardingAddress`, remove `deletionRetentionDays`/`emailConfigs`, simplify OnboardingState). Fix enums (SignalStatus, SignalSource, Workflow, RuleActionType). Remove `Page<T>`. Create `src/lib/signal-guards.ts`. Expect downstream type errors — do NOT fix them here.
    - _Requirements: 1, 2, 5, 6, 7, 8, 9, 10, 11_

- [x] 2. Update `src/lib/api.ts` response types
  - [x] 2.1 Update all return type generics to use new entity shapes. Add `rsvpSignal()` method. Remove any response mapping/transformation — cast directly to wire type. Run `vue-tsc --noEmit` and `vitest run`, fix errors in this file only. Commit: `🟣 align api.ts response types with backend wire shape`.
    - _Requirements: 1, 2, 4, 11_

- [x] 3. Update stores — entity key references
  - [x] 3.1 In `arcs.ts`: `.id` → `.arcId`. In `signals.ts`: `.id` → `.signalId`, update field access through `signal.data.*`. In `rules.ts`: `.id` → `.ruleId`. In `labels.ts`: `.id` → `.label`. In `views.ts`: `.id` → `.viewId`. In `templates.ts`: `.id` → `.templateId`. In `quarantine.ts`: update Signal field access for nested `data` structure. Run `vue-tsc --noEmit` and `vitest run`, fix errors in store files. Commit: `🟣 update stores to use backend entity key fields`.
    - _Requirements: 1, 10, 13_

- [x] 4. Update components — template bindings and `:key` attributes
  - [x] 4.1 `AppSidebar.vue`: `view.id` → `view.viewId`, `label.id` → `label.label`. `SignalCard.vue`: read from `signal.data.from`, `signal.data.subject`, etc. `DraftSignalCard.vue`: update signal field access. `WorkflowPanel.vue`: read `signal.data.workflowData`. All other components referencing entity `.id` fields. Run `vue-tsc --noEmit` and `vitest run`. Commit: `🟣 update components for wire-shape entity keys and Signal.data nesting`.
    - _Requirements: 1, 2, 13_

- [x] 5. Update views — template bindings
  - [x] 5.1 `InboxView.vue`: `arc.id` → `arc.arcId`. `ArcDetailView.vue`: signal rendering, arc key references. `RulesView.vue`: `rule.id` → `rule.ruleId`. `RuleEditorView.vue`: rule key references, `RuleAction.value` usage. `LabelsView.vue`: `label.id` → `label.label`. `TemplatesView.vue`: `template.id` → `template.templateId`. `SettingsView.vue`: domain/forwarding/team member key references, DnsRecord `name` field. `SearchView.vue`: entity key references. `QuarantineView.vue`: signal field access. Run `vue-tsc --noEmit` and `vitest run`. Commit: `🟣 update views for wire-shape entity keys`.
    - _Requirements: 1, 8, 9, 10, 13_

- [x] 6. Update tests — mock objects
  - [x] 6.1 Update all test files in `tests/unit/` and `tests/component/` to use new entity shapes (arcId, signalId, ruleId, etc.). Update Signal mocks to discriminated union structure with `type` and `data`. Update Label mocks (key=`label`). Update Domain/DnsRecord mocks (`host`→`name`, `failed`→`failing`). Run `vue-tsc --noEmit` (zero errors) and `vitest run` (all pass). Commit: `🟣 update test mocks to match backend wire shape`.
    - _Requirements: 1, 2, 13_

- [x] 7. Add Signal type renderers
  - [x] 7.1 Create `SignalRenderer.vue` (switches on `signal.type`). Rename `SignalCard.vue` → `EmailSignalCard.vue`. Create `DeliverabilityCard.vue`, `CalendarEventCard.vue` (with RSVP buttons), `CalendarResponseCard.vue`, `SystemAlertCard.vue`. Wire `ArcDetailView.vue` to use `SignalRenderer`. Run `vue-tsc --noEmit` and `vitest run`. Commit: `🟣 add signal type renderers for discriminated union`.
    - _Requirements: 2, 3, 13_

- [x] 8. Add Calendar RSVP interaction
  - [x] 8.1 In `CalendarEventCard.vue`: add accept/decline/tentative buttons. Wire to `api.rsvpSignal()`. Handle loading, error, and success states. Run `vue-tsc --noEmit` and `vitest run`. Commit: `🟣 add calendar RSVP interaction`.
    - _Requirements: 4, 13_

- [x] 9. Add Rule conditionType toggle
  - [x] 9.1 Add `conditionType` toggle to `RuleEditorView.vue` (json_logic/js). Show visual builder for json_logic, CodeMirror for js. Default new rules to json_logic. Persist in create/update calls. Run `vue-tsc --noEmit` and `vitest run`. Commit: `🟣 add conditionType toggle to rule editor`.
    - _Requirements: 6, 13_

- [x] 10. Add Account settings fields
  - [x] 10.1 Add "After send action" toggle and "Calendar forwarding address" input to Settings → Account tab. Wire to `api.updateAccount()`. Populate from account store. Run `vue-tsc --noEmit` and `vitest run`. Commit: `🟣 add afterSendAction and calendar forwarding to account settings`.
    - _Requirements: 7, 13_

- [x] 11. Update DNS record display
  - [x] 11.1 Rename `host` references to `name`. Display `currentValue` alongside expected `value`. Update status badge `failed` → `failing`. Show `receivingSetupComplete`/`senderSetupComplete` badges. Run `vue-tsc --noEmit` and `vitest run`. Commit: `🟣 update DNS record display for currentValue and status alignment`.
    - _Requirements: 8, 12, 13_

- [x] 12. Property-by-property audit and follow-up tasks
  - [x] 12.1 Verify every backend field is on the frontend type. Verify every frontend field is surfaced in UI. Document removed frontend-invented fields in TODO.md under "Frontend fields requiring backend support". Document unused backend properties in TODO.md under "Unused backend properties requiring UI". Run `vue-tsc --noEmit` and `vitest run`. Commit: `🟣 document API coverage audit findings in TODO.md`.
    - _Requirements: 11, 12, 13_

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["5.1"] },
    { "id": 5, "tasks": ["6.1"] },
    { "id": 6, "tasks": ["7.1", "9.1", "10.1", "11.1"] },
    { "id": 7, "tasks": ["8.1"] },
    { "id": 8, "tasks": ["12.1"] }
  ]
}
```

Tasks 1-6 are strictly serial (each fixes type errors from the layer above). Tasks 7, 9, 10, 11 are independent of each other but depend on 1-6. Task 8 depends on 7 (RSVP wired into CalendarEventCard). Task 12 depends on all others (final audit).

## Notes

- Task 1 intentionally leaves the codebase in a broken state (type errors everywhere). This is by design — the type-checker becomes the migration guide for tasks 2-6.
- Tasks 7-11 are independent of each other (can be parallelized in separate sessions) but all depend on tasks 1-6 being complete.
- Task 12 is always last — it audits the final state.
