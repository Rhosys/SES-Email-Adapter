# Requirements Document

## Introduction

Reconcile the frontend TypeScript types and UI components in the email-catcher site with the backend API contract. The frontend currently uses generic `id` fields and flat Signal structures that diverge from the wire format. This spec aligns types to the exact backend shape (never renaming backend properties), and updates UI/UX to support the richer data structures the backend provides — including discriminated Signal types, calendar RSVP, new entity fields, and corrected entity identifiers.

## Glossary

- **Frontend**: The Vue 3 / TypeScript application at `email-catcher/site`
- **Wire_Shape**: The exact JSON structure returned by the backend API endpoints
- **Signal**: A communication event (email, deliverability event, calendar event, etc.) processed by the system
- **Arc**: A conversation thread grouping related Signals
- **Discriminated_Union**: A TypeScript union type where each variant is identified by a literal `type` field
- **RSVP_Action**: A user response to a calendar invite Signal (accept, decline, tentative)
- **Entity_ID**: The primary key field for an entity as defined by the backend (`arcId`, `signalId`, `ruleId`, etc.)

## Requirements

### Requirement 1: Entity ID Field Alignment

**User Story:** As a developer, I want frontend types to use the exact ID field names from the backend wire shape, so that no mapping layer is needed between API responses and application state.

#### Acceptance Criteria

1. THE Frontend SHALL use `arcId` as the primary key field on the Arc type
2. THE Frontend SHALL use `signalId` as the primary key field on the Signal type
3. THE Frontend SHALL use `ruleId` as the primary key field on the Rule type
4. THE Frontend SHALL use `domainId` as the primary key field on the Domain type
5. THE Frontend SHALL use `viewId` as the primary key field on the SavedView type
6. THE Frontend SHALL use `templateId` as the primary key field on the EmailTemplate type
7. THE Frontend SHALL use `label` as the key field on the Label type and remove `id` and `accountId`
8. THE Frontend SHALL use `address` as the key field on the ForwardingAddress type and remove `id`
9. THE Frontend SHALL represent TeamMember as `{ userId: string; role: UserRole }` matching the backend shape
10. WHEN the Frontend references an entity by its key, THE Frontend SHALL use the Wire_Shape field name in all stores, components, and API call sites

### Requirement 2: Signal Discriminated Union Structure

**User Story:** As a developer, I want the Signal type to be a discriminated union keyed by `type` with content nested under a `data` field, so that the frontend type matches the backend response exactly.

#### Acceptance Criteria

1. THE Frontend SHALL define Signal as a discriminated union with a `type` field containing one of: `email`, `deliverability`, `invalid_rule_function`, `invalid_template_function`, `auto_send_blocked`, `calendar_event`, `calendar_response`, `calendar_invite_invalid`, `domain_misconfiguration`
2. THE Frontend SHALL nest signal-type-specific content under a `data` field on each Signal variant
3. THE Frontend SHALL retain shared fields (`signalId`, `arcId`, `accountId`, `status`, `source`, `receivedAt`, `createdAt`, `matchedRules`) at the top level of every Signal variant
4. THE Frontend SHALL define the `email` Signal variant's `data` field to contain `from`, `to`, `cc`, `subject`, `textBody`, `htmlBody`, `spamScore`, `attachments`, and `workflowData`
5. THE Frontend SHALL define distinct data shapes for each non-email Signal type matching the backend schema

### Requirement 3: Signal Type-Specific UI Rendering

**User Story:** As a user, I want different signal types rendered with distinct visual treatments, so that I can immediately distinguish email messages from system events, deliverability alerts, and calendar invitations.

#### Acceptance Criteria

1. WHEN the Frontend renders a Signal of type `email`, THE Frontend SHALL display it as a message with sender, subject, and body
2. WHEN the Frontend renders a Signal of type `deliverability`, THE Frontend SHALL display it as a status event with delivery outcome and diagnostic information
3. WHEN the Frontend renders a Signal of type `calendar_event`, THE Frontend SHALL display it as a calendar invitation with event title, time, location, and attendees
4. WHEN the Frontend renders a Signal of type `calendar_response`, THE Frontend SHALL display it as a calendar RSVP notification showing who responded and their response
5. WHEN the Frontend renders a Signal of type `domain_misconfiguration`, THE Frontend SHALL display it as a system warning with the affected domain and misconfiguration details
6. WHEN the Frontend renders a Signal of type `invalid_rule_function` or `invalid_template_function`, THE Frontend SHALL display it as an error notification identifying the broken rule or template
7. WHEN the Frontend renders a Signal of type `auto_send_blocked`, THE Frontend SHALL display it as a warning indicating which outbound message was blocked and the reason

### Requirement 4: Calendar RSVP Interaction

**User Story:** As a user, I want to respond to calendar invitations directly from the signal view, so that I can accept, decline, or tentatively accept meetings without leaving the application.

#### Acceptance Criteria

1. WHEN the Frontend displays a Signal of type `calendar_event`, THE Frontend SHALL render RSVP action buttons (accept, decline, tentative)
2. WHEN the user selects an RSVP_Action, THE Frontend SHALL send a POST request to `/signals/{signalId}/rsvp` with the selected response
3. IF the RSVP request fails, THEN THE Frontend SHALL display an error message and retain the RSVP buttons in their pre-action state
4. WHEN the RSVP request succeeds, THE Frontend SHALL update the Signal's displayed RSVP status to reflect the user's response

### Requirement 5: Arc Type Alignment

**User Story:** As a developer, I want the Arc type to include `retentionDuration` and `deletedAt` fields, so that the frontend can display retention policies and soft-delete state.

#### Acceptance Criteria

1. THE Frontend SHALL include an optional `retentionDuration` field of type string on the Arc type
2. THE Frontend SHALL include an optional `deletedAt` field of type string on the Arc type
3. THE Frontend SHALL remove the generic `id` field from the Arc type and use `arcId` exclusively

### Requirement 6: Rule conditionType Field

**User Story:** As a user, I want the rule editor to expose the `conditionType` field, so that I can choose between JSON Logic conditions and JavaScript function conditions.

#### Acceptance Criteria

1. THE Frontend SHALL include a `conditionType` field on the Rule type with values `json_logic` or `js`
2. WHEN a Rule has `conditionType` of `json_logic`, THE Frontend SHALL render the existing visual condition builder
3. WHEN a Rule has `conditionType` of `js`, THE Frontend SHALL render a code editor for the JavaScript condition function
4. WHEN creating a new Rule, THE Frontend SHALL default `conditionType` to `json_logic`

### Requirement 7: Account New Fields

**User Story:** As a user, I want to configure what happens after sending a reply and set a default calendar forwarding address, so that I can control post-send behavior and calendar routing.

#### Acceptance Criteria

1. THE Frontend SHALL include an `afterSendAction` field on the Account type with values `archive` or `keep_active`
2. THE Frontend SHALL include an optional `defaultCalendarInviteForwardingAddress` field of type string on the Account type
3. WHEN the user configures account settings, THE Frontend SHALL provide a control to choose the `afterSendAction` preference
4. WHEN the user configures account settings, THE Frontend SHALL provide a field to set the `defaultCalendarInviteForwardingAddress`

### Requirement 8: DnsRecord Field Alignment

**User Story:** As a developer, I want DnsRecord to match the backend shape exactly, so that domain verification status displays correctly.

#### Acceptance Criteria

1. THE Frontend SHALL use `name` instead of `host` on the DnsRecord type
2. THE Frontend SHALL include an optional `currentValue` field of type string on the DnsRecord type
3. THE Frontend SHALL use DNS status values `verified`, `failing`, and `pending` (replacing `failed` with `failing`)
4. WHEN a DnsRecord has a `currentValue`, THE Frontend SHALL display both the expected value and the current detected value for comparison

### Requirement 9: ForwardingAddress Type Alignment

**User Story:** As a developer, I want ForwardingAddress to match the backend's `VerifiedForwardingAddress` shape, so that verification timestamps are surfaced in the UI.

#### Acceptance Criteria

1. THE Frontend SHALL define ForwardingAddress with fields: `address` (key), `status` (`pending` | `verified`), and `verifiedAt` (optional string)
2. THE Frontend SHALL remove the `id`, `accountId`, and `createdAt` fields from ForwardingAddress
3. WHEN a ForwardingAddress has `status` of `verified`, THE Frontend SHALL display the `verifiedAt` timestamp

### Requirement 10: Label Type Alignment

**User Story:** As a developer, I want the Label type to match the backend shape using `label` as the key field, so that label operations use the correct identifier in API calls.

#### Acceptance Criteria

1. THE Frontend SHALL define Label with fields: `label` (key), `name`, `color` (optional), `icon` (optional), and `createdAt`
2. THE Frontend SHALL remove the `id` and `accountId` fields from the Label type
3. WHEN the Frontend performs label CRUD operations, THE Frontend SHALL use the `label` field as the resource identifier in API paths

### Requirement 11: Remove Frontend-Invented Fields and Types

**User Story:** As a developer, I want the frontend types to contain only fields that exist in the backend API response, so that there is no confusion about what the backend actually provides.

#### Acceptance Criteria

1. THE Frontend SHALL NOT define any field on a type that is not present in the backend Wire_Shape for that entity
2. WHEN a frontend type currently contains a field that has no backend equivalent, THE Frontend SHALL remove that field and file a follow-up task documenting what the field was intended to do
3. WHEN a frontend type contains an enum value that does not exist in the backend schema, THE Frontend SHALL remove that value
4. THE Follow-up tasks SHALL be recorded in the project TODO.md under a "Frontend fields requiring backend support" section
5. IF a removed field was used in the UI, THEN THE Frontend SHALL remove or disable the UI element that depended on it and document it in the follow-up task

### Requirement 12: Property-by-Property Backend Coverage Audit

**User Story:** As a developer, I want every property returned by the backend API to be consumed and displayed somewhere in the UI, so that users have access to all available information.

#### Acceptance Criteria

1. FOR EACH entity returned by the backend API, THE Developer SHALL audit every property on the Wire_Shape against the frontend type and component usage
2. WHEN a backend property exists but is not present on the frontend type, THE Frontend SHALL add it to the type
3. WHEN a backend property exists on the frontend type but is not surfaced in any UI component, THE Developer SHALL create a follow-up task to display or utilise that property
4. THE Follow-up tasks SHALL be recorded in the project TODO.md under a "Unused backend properties requiring UI" section
5. THE Audit SHALL cover all entities: Account, Arc, Signal (all variants), Rule, Domain, DnsRecord, View, Label, Alias, AliasSender, EmailTemplate, TemplateFunction, ForwardingAddress, TeamMember, AuditEvent, and Attachment

### Requirement 13: Serial Execution with Verified Commits

**User Story:** As a developer, I want each task to be completed, verified, and committed before the next task begins, so that the codebase is never left in a broken intermediate state.

#### Acceptance Criteria

1. EACH task SHALL be executed in serial order — no task may begin until the previous task's commit is complete
2. AFTER completing each task, THE Developer SHALL run `vue-tsc --noEmit` and verify zero type errors
3. AFTER completing each task, THE Developer SHALL run `vitest run` and verify all tests pass
4. AFTER verification passes, THE Developer SHALL create a single atomic commit containing only the files changed by that task
5. IF `vue-tsc` or `vitest` fails after a task, THE Developer SHALL fix the errors within that same task before committing
