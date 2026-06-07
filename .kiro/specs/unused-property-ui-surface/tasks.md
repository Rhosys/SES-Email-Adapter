# Implementation Plan: Unused Property UI Surface

## Overview

Surface seven unused-but-typed backend properties across existing Vue components. All fields already exist on `src/types/server.ts` — this work adds rendering logic only. One API signature change (`api.updateAlias` body type) is required before the SettingsView spam threshold task.

## Tasks

- [x] 1. Extend api.ts for spamScoreThreshold
  - [x] 1.1 Add `spamScoreThreshold?: number` to the `updateAlias` request body type in `src/api.ts`
    - The backend already accepts this field — the frontend type just omits it
    - _Requirements: 3.2_

- [x] 2. Per-Action Disable Toggle in Rule Editor
  - [x] 2.1 Add disable/enable toggle button and opacity styling to RuleEditorView.vue
    - In the actions `v-for`, add a toggle button that flips `action.disabled`
    - Apply `opacity-50` to the action row when `action.disabled === true`
    - Show "Disabled"/"Enabled" text on the toggle button
    - The existing `save()` already serialises full `RuleAction[]` including `disabled`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - [x] 2.2 Write unit tests for disable toggle rendering
    - Mount RuleEditorView with fixture containing `disabled: true` action → assert opacity class and "Disabled" text
    - Mount with `disabled: false`/undefined → assert normal opacity and "Enabled" text
    - Simulate toggle click → verify `disabled` flips
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 3. Template Function Error Indicator
  - [x] 3.1 Add error badge and execution error display to TemplatesView.vue
    - In template list: render a red dot when any function in `tpl.functions` has truthy `lastError`
    - In function editor: show `lastError` message below CodeEditor when present and no local validation error
    - Style with `bg-ctp-red` dot for list, `bg-ctp-peach/10` block for detail
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 3.2 Write unit tests for error indicator rendering
    - Mount with fixture where `lastError` is set → assert red dot in list and error block in editor
    - Mount with `lastError` absent → assert neither renders
    - Mount with both `lastError` and local `fnErrors` → assert only local error shown
    - _Requirements: 2.1, 2.2, 2.3_

- [x] 4. Per-Alias Spam Score Threshold in Settings
  - [x] 4.1 Add spam threshold input and reset button to SettingsView.vue emails tab
    - Add number input (0–10, step 0.1) per alias below filter-mode buttons
    - Show placeholder "account default" when `spamScoreThreshold` is undefined
    - Add Reset button (visible only when threshold is set) that sends `undefined`
    - Add `updateAliasThreshold` function that clamps value to [0, 10] and calls `api.updateAlias`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x] 4.2 Write unit tests for spam threshold input
    - Mount with alias having `spamScoreThreshold: 5` → assert input value is 5
    - Mount with alias having no threshold → assert placeholder shown
    - Simulate input change to "11" → verify clamped to 10 in API call
    - Simulate clear → verify `spamScoreThreshold: undefined` sent
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 5. Forwarding Address Verification Date
  - [x] 5.1 Add verification date badge to SettingsView.vue forwarding tab
    - Show "Verified on <date>" in `text-ctp-green` when `verifiedAt` is set
    - Show "Pending verification" in `text-ctp-yellow` when `verifiedAt` is absent
    - Format date with `toLocaleDateString(undefined, { dateStyle: 'medium' })`
    - _Requirements: 4.1, 4.2_
  - [x] 5.2 Write unit tests for verification date display
    - Mount with `verifiedAt` set → assert formatted date renders
    - Mount with status "pending" and no `verifiedAt` → assert "Pending verification" shown
    - _Requirements: 4.1, 4.2_

- [x] 6. Calendar Event External Link
  - [x] 6.1 Add "View in calendar" link to CalendarEventCard.vue
    - Conditionally render `<a>` when `signal.data.url` is truthy
    - Set `target="_blank"` and `rel="noopener noreferrer"`
    - Style with `text-ctp-blue hover:underline`
    - Do not render when `data.url` is absent
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 6.2 Write unit tests for calendar link rendering
    - Mount with `data.url` set → assert link renders with correct href and rel
    - Mount without `data.url` → assert no link rendered
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 7. System Alert Deep Links
  - [x] 7.1 Add RouterLink navigation to SystemAlertCard.vue
    - For `invalid_rule_function`: wrap `resourceName` in `<RouterLink :to="/rules/${resourceName}">`
    - For `invalid_template_function`: wrap `resourceName` in `<RouterLink to="/templates">`
    - Style links with `text-ctp-mauve hover:underline`
    - _Requirements: 6.1, 6.2_
  - [x] 7.2 Write unit tests for deep link routing
    - Mount with `invalid_rule_function` signal → assert RouterLink `to` prop is `/rules/<name>`
    - Mount with `invalid_template_function` signal → assert RouterLink `to` prop is `/templates`
    - _Requirements: 6.1, 6.2_

- [x] 8. Deleted Arc Timestamp Display
  - [x] 8.1 Add deletedAt timestamp to ArcDetailView.vue header
    - Show "Deleted on <date>" when `status === 'deleted'` and `deletedAt` is set
    - Format with `toLocaleDateString(undefined, { dateStyle: 'medium' })`
    - Render inline after the status span with a `·` separator
    - _Requirements: 7.1_
  - [x] 8.2 Write unit tests for deleted timestamp display
    - Mount with `status: 'deleted'` and `deletedAt` set → assert date shown
    - Mount with `status: 'deleted'` and no `deletedAt` → assert no date
    - Mount with `status: 'active'` and `deletedAt` set → assert no date shown
    - _Requirements: 7.1_

- [x] 9. Final checkpoint
  - Ensure `vue-tsc --noEmit` and `vitest run` both pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- All implementation tasks modify existing files only — no new files needed
- Task 1.1 (api.ts) must complete before Task 4.1 (spam threshold UI) since the UI calls the updated API function
- All other tasks are independent and can be parallelized
- After each task: run `vue-tsc --noEmit` and `vitest run` in `email-catcher/site/`
- Commit format: `🟣 <description>`
- Git repo is at `/home/warren/git/claude/email-catcher/site/`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "5.1", "6.1", "7.1", "8.1"] },
    { "id": 1, "tasks": ["2.2", "3.2", "4.1", "5.2", "6.2", "7.2", "8.2"] },
    { "id": 2, "tasks": ["4.2"] }
  ]
}
```
