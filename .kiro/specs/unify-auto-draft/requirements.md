# Requirements Document

## Introduction

Unify the `auto_reply` and `auto_draft` rule actions into a single `auto_draft` action. Currently, `auto_reply` sends immediately via SES (fire-and-forget, no durable artifact), while `auto_draft` creates a draft signal but never sends it. The unified action always creates a draft signal first, then optionally sends it through the existing draft-send-flow (SQS delayed message → SES). This gives every automated response a durable artifact (the draft) and graceful degradation (if send fails, the draft remains for user review).

Additionally, rename the `ReplySender` interface to decouple it from the test infrastructure (`testReplier.pong` naming).

## Glossary

- **auto_draft action**: The unified rule action that creates a draft signal from a template and optionally sends it
- **autoSend**: A boolean flag on the `auto_draft` RuleAction that controls whether the created draft is automatically sent (via the draft-send-flow) or left as a draft for user review
- **ReplySender**: The current interface name for outbound email sending — to be renamed to `EmailSender`
- **DraftSendDispatcher**: The existing class that schedules delayed SQS messages for the draft-send-flow

## Requirements

### Requirement 1: Remove auto_reply action type

**User Story:** As a developer, I want a single action type for automated responses, so that the rules engine has one concept instead of two overlapping ones.

#### Acceptance Criteria

1. THE `RULE_ACTION_TYPES` array SHALL remove `"auto_reply"` — only `"auto_draft"` remains for automated response actions
2. THE `RuleActionType` type SHALL no longer include `"auto_reply"` as a valid value
3. THE `ProcessingOutcome` interface SHALL remove the `autoReplyTemplateIds` field — all template-based responses flow through `autoDraftTemplateIds`
4. THE `deriveOutcome` function SHALL remove the `case "auto_reply"` branch
5. EXISTING rules in DynamoDB that have `type: "auto_reply"` SHALL be treated as `type: "auto_draft"` with `autoSend: true` during a migration or at read time (backward compatibility)

### Requirement 2: Add autoSend flag to RuleAction

**User Story:** As a user, I want to choose whether an automated draft is sent immediately or held for review, so that I can control which responses go out without my explicit approval.

#### Acceptance Criteria

1. THE `RuleAction` interface SHALL include an optional `autoSend?: boolean` field (default: `false` when absent)
2. WHEN `autoSend` is `true`, THE Backend SHALL send the created draft through the draft-send-flow after saving it (dispatch a `draft_send` SQS message with `DelaySeconds: 0`)
3. WHEN `autoSend` is `false` or absent, THE Backend SHALL save the draft signal with `status: "draft"` and take no further action — the user reviews and sends manually
4. THE `RuleActionSchema` in `src/api/requests.ts` SHALL accept `autoSend: z.boolean().optional()` on rule actions

### Requirement 3: Unified auto-draft side-effect with optional send

**User Story:** As the system, I want all automated responses to create a draft first and optionally send, so that every response has a durable artifact regardless of send outcome.

#### Acceptance Criteria

1. THE `processSideEffect` method SHALL have a single auto-draft code path that handles both "draft only" and "draft + send" cases
2. THE auto-draft side-effect SHALL remove the separate auto-reply code path entirely
3. WHEN `autoSend` is `true` on the matched rule action AND the draft is saved successfully AND no template function errors occurred (`preventAutoSend` is false), THE Backend SHALL dispatch a `draft_send` SQS message with `DelaySeconds: 0` (immediate send, no undo window for automated responses)
4. WHEN `autoSend` is `true` but a template function returned null/error (`preventAutoSend` is true), THE Backend SHALL leave the draft in `status: "draft"` and log at INFO level — graceful degradation
5. WHEN SES send fails permanently (handled by the existing DraftSendWorker), THE draft SHALL remain in `status: "draft"` with `sendFailureReason` set — the user can review and resend

### Requirement 4: Rename ReplySender interface to EmailSender

**User Story:** As a developer, I want the outbound email interface named generically, so that it's not coupled to the test infrastructure or any specific use case.

#### Acceptance Criteria

1. THE `ReplySender` interface in `src/processor/processor.ts` SHALL be renamed to `EmailSender`
2. THE `sendReply` method SHALL be renamed to `sendEmail`
3. ALL references to `ReplySender` and `sendReply` across the codebase SHALL be updated (processor, handler, external-email-signal-handler, tests)
4. THE `ExternalEmailSignalHandler` class SHALL implement `EmailSender` instead of `ReplySender`
5. THE `pong` side-effect SHALL call `this.emailSender.sendEmail(...)` instead of `this.replySender.sendReply(...)`

### Requirement 5: Backward compatibility for existing auto_reply rules

**User Story:** As a user with existing auto_reply rules, I want them to continue working after the migration without manual intervention.

#### Acceptance Criteria

1. WHEN reading a rule from DynamoDB that has an action with `type: "auto_reply"`, THE Backend SHALL treat it as `type: "auto_draft"` with `autoSend: true`
2. THE rule list and rule detail API responses SHALL return the migrated action type (`"auto_draft"` with `autoSend: true`) — the frontend never sees `"auto_reply"`
3. WHEN a rule is updated via PATCH, any `"auto_reply"` actions in the payload SHALL be rejected with 400 — the client must use `"auto_draft"` with `autoSend`
4. THE system rules (`SYSTEM_RULES` array) SHALL NOT use `auto_reply` — any that did must be updated to `auto_draft` with `autoSend: true`
