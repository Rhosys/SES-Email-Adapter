# Requirements Document

## Introduction

Replace the numeric spam score (0–1 float) with a descriptive **tags** system. The spam score is a single number produced by the LLM classifier that attempts to express how spammy an email is, but it's unclear what any given score means or how to interpret it. Tags capture the specific attributes that contribute to spamminess (e.g. "phishing", "bulk-unsolicited", "spoofed-sender") as a list of strings, making the classification transparent and actionable.

Tags are an internal tracking concept — they are NOT exposed to users, user-defined rules, or the API. They drive system-level label assignment and are persisted on the signal for internal observability only.

This is a cross-cutting removal and replacement touching the classifier, processor, filter, database, and API cleanup.

## Glossary

- **Classifier**: The LLM-based email classification engine (`SignalClassifier`) that analyzes emails and produces structured output including workflow, summary, and (currently) spam score.
- **Tag**: A string identifier representing a specific spam-related attribute detected in an email (e.g. "phishing", "bulk-unsolicited", "tracking-heavy"). Internal tracking concept — not user-facing.
- **Tag_Vocabulary**: The shared constant array of recognized tag values. Tags not in this vocabulary are discarded by the Classifier and logged for observability.
- **Signal**: An immutable inbound event representing a processed email, stored in DynamoDB.
- **Arc**: A materialized aggregate of related Signals.
- **System_Label**: A label automatically assigned by the processor based on classification output (e.g. `system:spam`).
- **Filter**: The module (`filter.ts`) that assigns system labels and determines signal disposition.
- **Rule_Evaluator**: The module that evaluates user-defined and system rules against signal/arc context.
- **Processing_Database**: The module that updates global sender reputation counters.
- **Prompt_Builder**: The module that constructs the LLM system prompt for classification.
- **Account_Filtering_Config**: Account-level filtering defaults including unknown sender policy.
- **Alias**: A per-recipient-address configuration.
- **Disposition**: The final outcome applied to a signal after rule evaluation (e.g. quarantine_hidden, block_hidden, violation_report, deliver).

## Requirements

### Requirement 1: Remove spamScore from Classifier Output

**User Story:** As a developer, I want the classifier to stop producing a numeric spam score, so that the system no longer relies on an ambiguous single number.

#### Acceptance Criteria

1. THE Classifier SHALL NOT include `spamScore` in the classification output schema.
2. THE Prompt_Builder SHALL NOT include `spamScore` in the JSON output schema example or in any instruction text sent to the LLM.
3. THE Prompt_Builder SHALL NOT include the "Spam Scoring" section or score range definitions in the system prompt.
4. IF the LLM response contains a `spamScore` field, THEN THE Classifier SHALL discard it and not propagate it to the classification output.

### Requirement 2: Classifier Produces Tags

**User Story:** As a developer, I want the classifier to produce a list of tags describing spam-related attributes, so that the system captures specific reasons an email is suspicious.

#### Acceptance Criteria

1. THE Classifier SHALL include a `tags` field in the classification output, typed as an array of strings containing at most 10 elements.
2. THE Prompt_Builder SHALL instruct the LLM to produce a `tags` array containing zero or more tag identifiers describing spam-related attributes detected in the email.
3. THE Prompt_Builder SHALL provide the LLM with the tag vocabulary sourced from the Tag_Vocabulary constant array.
4. WHEN the email has no spam-related attributes, THE Classifier SHALL return an empty `tags` array.
5. WHEN the LLM returns tag values not in the Tag_Vocabulary, THE Classifier SHALL filter them out, include only the remaining valid tags in the output, AND log a TRACK message identifying each unknown tag value for observability (potential new tag discovery).
6. THE Classifier SHALL constrain each tag value to a lowercase alphanumeric string with hyphens, between 2 and 40 characters in length.

### Requirement 3: Replace System Spam Labels with Tag-Driven Labels

**User Story:** As a developer, I want system labels to reflect detected tags instead of numeric thresholds, so that the quarantine logic is based on transparent attributes rather than opaque scores.

#### Acceptance Criteria

1. THE Filter SHALL NOT assign `system:spam:high` or `system:spam:medium` labels.
2. WHEN one or more tags are present in the classification output after vocabulary filtering, THE Filter SHALL assign a `system:spam` label.
3. IF no recognized tags are present after vocabulary filtering, THEN THE Filter SHALL NOT assign any spam-related system label.
4. THE `SystemLabelContext` interface SHALL replace the `spamScore` and `spamScoreThreshold` fields with a `tags` field of type `string[]`.
5. THE `SystemLabel` union type SHALL include `system:spam` and SHALL NOT include `system:spam:high` or `system:spam:medium`.

### Requirement 4: Update System Rules for Tag-Based Quarantine

**User Story:** As a developer, I want system rules to quarantine emails based on the new spam label, so that quarantine behavior is driven by detected attributes.

#### Acceptance Criteria

1. THE System_Rules SHALL NOT reference `system:spam:high` or `system:spam:medium` labels in any rule condition.
2. IF a signal bears the `system:spam` label, THEN THE System_Rules SHALL apply the `quarantine_hidden` action to that signal.
3. THE System_Rules SHALL replace SR-04 and SR-06 with a single rule that quarantines (hidden) signals bearing the `system:spam` label, retaining the priority order of SR-04 (400).

### Requirement 5: Remove spamScoreThreshold from Alias and Account Configuration

**User Story:** As a developer, I want to remove the spam score threshold setting from aliases and accounts, so that the configuration surface no longer references an obsolete concept.

#### Acceptance Criteria

1. THE Alias interface SHALL NOT include a `spamScoreThreshold` field.
2. THE AccountFilteringConfig interface SHALL NOT include a `spamScoreThreshold` field.
3. THE Filter SHALL NOT read or compare against a `spamScoreThreshold` value, and the `SystemLabelContext` interface SHALL NOT include a `spamScoreThreshold` field.
4. THE Filter SHALL NOT export a `DEFAULT_SPAM_SCORE_THRESHOLD` constant.
5. THE API request schemas SHALL NOT accept a `spamScoreThreshold` field for alias upsert or account filtering config update endpoints.
6. THE API response transformation SHALL NOT include a `spamScoreThreshold` field when serialising alias or account data.

### Requirement 6: Store Tags on Signal Data

**User Story:** As a developer, I want tags to be persisted on the signal, so that internal systems can observe what spam attributes were detected.

#### Acceptance Criteria

1. THE Signal `EmailSignalData` interface SHALL include a `tags` field typed as a non-optional array of strings with a maximum of 50 elements.
2. THE Signal `EmailSignalData` interface SHALL NOT include a `spamScore` field.
3. WHEN a signal is saved, THE Processor SHALL persist the `tags` array from `ClassificationOutput.tags` onto `signal.data.tags` without modification.
4. WHEN a signal is read from DynamoDB and the stored record lacks a `tags` field in its data, THE database read layer SHALL default the value to an empty array (`[]`) without changing the exposed type contract.
5. IF `ClassificationOutput.tags` contains more than 50 elements, THEN THE Processor SHALL truncate the array to the first 50 elements before persisting.

### Requirement 7: Remove spamScore from Rule Evaluator Context

**User Story:** As a developer, I want to remove spamScore from the context exposed to user-defined rules, so that user rules cannot depend on an obsolete field.

#### Acceptance Criteria

1. WHEN the Rule_Evaluator builds the stripped signal context for user code and JSONLogic evaluation, THE Rule_Evaluator SHALL NOT include the `spamScore` property.
2. THE Rule_Evaluator SHALL NOT expose `tags` in the stripped signal context — tags are internal-only and not available to user-defined rules.
3. IF a signal has no `spamScore` field at evaluation time, THE Rule_Evaluator SHALL not error — the field is simply absent from the stripped context.

### Requirement 8: Update Reputation Tracking to Disposition-Based spamCount

**User Story:** As a developer, I want sender reputation to track spam based on signal disposition rather than a numeric score, so that reputation reflects actual enforcement outcomes.

#### Acceptance Criteria

1. WHEN the Processing_Database updates global sender reputation, THE Processing_Database SHALL increment the `spamCount` field when the signal's final disposition is `quarantine_hidden`, `quarantine`, `block_hidden`, `block`, or `violation_report`.
2. IF the signal's final disposition is NOT one of the dispositions listed in 8.1, THEN THE Processing_Database SHALL NOT increment the `spamCount` field.
3. THE `GlobalSenderReputation` interface SHALL retain the `spamCount` field of type `number`.
4. WHEN the `updateGlobalReputation` method is called, THE Processing_Database SHALL accept a `wasSpam: boolean` parameter that indicates whether the signal's final disposition qualifies as spam (per 8.1).
5. THE Processor SHALL compute `wasSpam` by checking whether the signal's applied actions include any of: `quarantine_hidden`, `quarantine`, `block_hidden`, `block`, or `violation_report`.

### Requirement 9: Remove spamScore from API Schemas and Responses

**User Story:** As a developer, I want the API to stop exposing spam score and threshold, so that API consumers no longer see obsolete fields.

#### Acceptance Criteria

1. THE API schemas SHALL NOT include `spamScore` on the `InboundEmailSignalData` response object.
2. THE API schemas SHALL NOT include `spamScoreThreshold` on the `Alias` response object or the `AccountFilteringConfig` request/response object.
3. WHEN the API transforms an inbound email signal for response, THE API response transform SHALL omit the `spamScore` field from the `InboundEmailSignalData` output.
4. WHEN the API transforms an alias for response, THE API response transform SHALL omit the `spamScoreThreshold` field from the `Alias` output.
5. THE API schemas SHALL NOT expose `tags` on any response object — tags are internal-only.

### Requirement 10: Remove spamScore from Frontend

**User Story:** As a developer, I want the frontend to stop displaying spam score and threshold controls, so that the UI reflects the removal of the obsolete concept.

#### Acceptance Criteria

1. THE Frontend type definitions SHALL NOT include `spamScore` on signal data interfaces.
2. THE Frontend type definitions SHALL NOT include `spamScoreThreshold` on alias or account filtering config types.
3. THE Frontend settings components SHALL NOT render a spam score threshold control at account level or alias level.
4. THE Frontend rule condition field definitions SHALL NOT include `signal.spamScore` as a selectable field.
5. THE Frontend API request types SHALL NOT include `spamScoreThreshold` in alias update or account update request bodies.
6. THE Frontend SHALL NOT expose `tags` on any signal display — tags are internal-only.

### Requirement 11: Update SystemLabel Union Type

**User Story:** As a developer, I want the SystemLabel type to reflect the new tag-driven label, so that the compile-time gate remains accurate.

#### Acceptance Criteria

1. THE `SystemLabel` union type SHALL NOT include `"system:spam:high"` or `"system:spam:medium"`.
2. THE `SystemLabel` union type SHALL include `"system:spam"`.
3. THE codebase SHALL compile without errors after the union type change (verified by `npm run check` passing), confirming that all references to removed members have been updated.

### Requirement 12: Update WORKFLOWS Comment

**User Story:** As a developer, I want the code comment explaining that spam is not a workflow to reference tags instead of spam score, so that future developers understand the current model.

#### Acceptance Criteria

1. THE WORKFLOWS constant comment SHALL NOT reference `Signal.spamScore` or the numeric range `(0–1)`.
2. THE WORKFLOWS constant comment SHALL explain that spam attributes are expressed via `Signal.data.tags`.
3. THE WORKFLOWS constant comment SHALL retain the example illustrating that a phishing email receives a real workflow (e.g. `workflow:"auth"`) combined with spam tags rather than a dedicated spam workflow.
4. THE WORKFLOWS constant comment SHALL retain the rationale sentence explaining that the workflow captures the kind of email (or what it pretends to be), which is more actionable than a generic "spam" label.
