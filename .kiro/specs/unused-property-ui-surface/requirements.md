# Requirements Document

## Introduction

Surface all useful-but-unrendered backend properties in the email-catcher site UI. These fields already exist on frontend TypeScript types (mirrored from the API contract) but are not yet displayed in any component. This spec covers only pure UI rendering work — no backend changes required.

## Glossary

- **Rule_Editor**: The view at `/rules/:id` (RuleEditorView.vue) where users create/edit automation rules and their actions.
- **Template_Editor**: The view at `/templates` (TemplatesView.vue) where users manage email templates and their associated functions.
- **Settings_View**: The view at `/settings` (SettingsView.vue) with tabs for account, email addresses, domains, forwarding, team, and notifications.
- **CalendarEventCard**: The component rendering `calendar_event` signals, showing event title, time, location, organizer, attendees, and RSVP buttons.
- **CalendarResponseCard**: The component rendering `calendar_response` signals, showing RSVP status and response time.
- **DeliverabilityCard**: The component rendering `deliverability` signals, showing bounce information.
- **SystemAlertCard**: The component rendering system alert signals (invalid_rule_function, invalid_template_function, domain_misconfiguration, calendar_invite_invalid, auto_send_blocked).
- **ArcDetailView**: The view at `/arcs/:id` showing a conversation thread with all signals and arc metadata.
- **Signal_Card**: Any of the above signal-rendering components.
- **Linked_Signal_Link**: A clickable inline element that navigates the user to the arc containing a referenced signal, using the signal's `arcId` for routing.

## Requirements

### Requirement 1: Per-Action Disable Toggle in Rule Editor

**User Story:** As a user, I want to temporarily disable individual rule actions without removing them, so that I can debug or pause specific behaviors while keeping the rule structure intact.

#### Acceptance Criteria

1. WHEN the Rule_Editor renders a RuleAction, THE Rule_Editor SHALL display a disable/enable toggle for each action in the actions list.
2. WHEN the user toggles an action to disabled, THE Rule_Editor SHALL set `disabled: true` on that RuleAction and render the action row with reduced opacity and a "Disabled" text indicator.
3. WHEN the user toggles a disabled action back to enabled, THE Rule_Editor SHALL remove the `disabled` property from that RuleAction and restore normal opacity rendering.
4. WHEN an existing rule is loaded with actions that have `disabled: true`, THE Rule_Editor SHALL render those actions with the same reduced opacity and "Disabled" indicator as user-disabled actions.
5. WHEN the user saves a rule containing disabled actions, THE Rule_Editor SHALL persist the `disabled` state of each action via the update rule API.

### Requirement 2: Template Function Error Indicator

**User Story:** As a user, I want to see which template functions have encountered execution errors, so that I can quickly identify and fix broken functions.

#### Acceptance Criteria

1. WHEN the Template_Editor renders the template list and a TemplateFunction has a non-empty `lastError` value, THE Template_Editor SHALL display an error badge on that template's list entry.
2. WHEN the Template_Editor renders the function list inside the editor and a TemplateFunction has a non-empty `lastError` value, THE Template_Editor SHALL display an error indicator next to the function name with the error message.
3. WHEN the user opens a template whose function has a `lastError`, THE Template_Editor SHALL display the last backend execution error distinctly from local validation errors.

### Requirement 3: Per-Alias Spam Score Threshold

**User Story:** As a user, I want to configure a spam sensitivity threshold per email address, so that I can apply stricter or looser filtering on specific aliases.

#### Acceptance Criteria

1. WHEN the Settings_View renders an alias in the email addresses tab, THE Settings_View SHALL display the current `spamScoreThreshold` value if set, or indicate "account default" if unset.
2. WHEN the user adjusts the spam threshold input for an alias, THE Settings_View SHALL call the update alias API with the new `spamScoreThreshold` value.
3. THE Settings_View SHALL constrain the spam threshold input to a numeric range of 0 through 10.
4. WHEN the user clears the spam threshold value, THE Settings_View SHALL send `spamScoreThreshold: undefined` to revert to the account default.

### Requirement 4: Forwarding Address Verification Date

**User Story:** As a user, I want to see when a forwarding address was verified, so that I can confirm it is active and know its verification history.

#### Acceptance Criteria

1. WHEN a ForwardingAddress has a `verifiedAt` timestamp, THE Settings_View SHALL display a "Verified on <formatted date>" badge in the forwarding tab next to that address.
2. WHEN a ForwardingAddress has status "pending" and no `verifiedAt`, THE Settings_View SHALL display only the "pending" status without a verification date.

### Requirement 5: Calendar Event External Link

**User Story:** As a user, I want to open a calendar event in my external calendar application, so that I can view full event details or add it to my calendar.

#### Acceptance Criteria

1. WHEN a CalendarEventSignal has a non-empty `data.url` value, THE CalendarEventCard SHALL render a "View in calendar" link that opens the URL in a new browser tab.
2. WHEN a CalendarEventSignal has no `data.url` value, THE CalendarEventCard SHALL not render the calendar link.
3. THE CalendarEventCard SHALL set `rel="noopener noreferrer"` on the external link.

### Requirement 6: System Alert Deep Links

**User Story:** As a user, I want system alert signals for broken rules or templates to link directly to the affected resource, so that I can fix the issue without manually navigating.

#### Acceptance Criteria

1. WHEN an InvalidRuleFunctionSignal is rendered, THE SystemAlertCard SHALL render `data.resourceName` as a RouterLink to `/rules/:resourceName` for direct navigation to the broken rule.
2. WHEN an InvalidTemplateFunctionSignal is rendered, THE SystemAlertCard SHALL render `data.resourceName` as a RouterLink to `/templates` for direct navigation to the template editor.

### Requirement 7: Deleted Arc Timestamp Display

**User Story:** As a user, I want to see when an arc was deleted, so that I know how long ago it happened.

#### Acceptance Criteria

1. WHEN an Arc has a `deletedAt` timestamp and `status` is `deleted`, THE ArcDetailView SHALL display "Deleted on <formatted date>" alongside the status.
