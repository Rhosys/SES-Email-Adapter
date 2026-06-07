# Requirements Document

## Introduction

The Signal Classifier is the single-pass LLM component that takes an inbound email and produces structured output: workflow assignment, typed workflowData extraction, spam score, summary, and label selection. It already exists and works. This spec defines the complete contract — what the classifier is responsible for, what it outputs, and the rules governing extraction — so that the prompt template, TypeScript interfaces, and downstream consumers stay aligned as the system evolves.

The classifier does NOT handle: calendar attachment detection (calendar proxy layer), phishing simulation blocking (pre-classifier gate), embedding generation (separate pipeline), or urgency assignment (derived downstream from trusted logic).

## Glossary

- **Classifier**: The `SignalClassifier` class — accepts email metadata + body, invokes an LLM, returns structured `ClassificationOutput`.
- **Workflow**: One of 15 categories describing the kind of email. The workflow drives UI display, automation rules, and urgency defaults.
- **WorkflowData**: A discriminated union of typed objects, one per workflow, containing extracted fields specific to that workflow.
- **Prompt Template**: The system prompt that instructs the LLM — dynamically assembled from TypeScript interfaces and per-invocation context. The prompt IS the contract.
- **Classification Input**: From, To, Subject, body (HTML stripped to plain text preferred, raw text body as fallback), received timestamp, relevant headers, allowed labels.
- **Classification Output**: `{ workflow, workflowData, spamScore, summary, labels }`.

## Requirements

### Requirement 1: The Prompt Template is the Primary Artifact

**User Story:** As the system designer, I need the classifier's behavior to be fully defined by its prompt template, so that changing what the classifier does means changing the prompt — not scattered logic across multiple files.

#### Acceptance Criteria

1. THE prompt template SHALL fully define: the list of workflows, what each workflow means, what fields to extract for each, the output JSON schema, spam scoring rules, and label selection instructions.
2. THE prompt SHALL be the single place that governs classifier behavior — no classification logic exists outside the prompt (aside from input formatting and output validation).
3. THE prompt SHALL be dynamically assembled from TypeScript interfaces and per-invocation context (allowed labels), not a static string constant.

### Requirement 2: Single-Pass Classification

**User Story:** As the signal processor, I need the classifier to produce all output (workflow, workflowData, spamScore, summary, labels) in a single LLM invocation, so that classification latency and cost are minimised.

#### Acceptance Criteria

1. THE Classifier SHALL produce workflow, workflowData, spamScore, summary, and labels in a single LLM call.
2. THE Classifier SHALL return valid JSON conforming to the `ClassificationOutput` interface.
3. WHEN the LLM returns invalid JSON or a workflow not in the allowed set, THE Classifier SHALL log ERROR with the full input and raw response, and return an error — no in-classifier retry.

### Requirement 3: Workflow Assignment

**User Story:** As the email processing system, I need exactly one workflow assigned per email, so that downstream processing is deterministic.

#### Acceptance Criteria

1. THE Classifier SHALL assign exactly one workflow from: auth, conversation, crm, package, travel, payments, alert, content, onboarding, status, healthcare, job, support, events, test.
2. THE Classifier SHALL assign workflow based on email content, sender identity, subject, and headers — never based on attachment presence (calendar or otherwise).
3. WHEN an email is spam or phishing, THE Classifier SHALL assign the workflow the email is impersonating (e.g. phishing bank login → "auth" with high spamScore).
4. WHEN an email matches multiple workflows, THE Classifier SHALL pick the most specific one based on primary intent.

### Requirement 4: WorkflowData Extraction

**User Story:** As the UI and automation layer, I need structured fields extracted per workflow, so that rich cards can be rendered and rules can act on typed data without parsing email bodies.

#### Acceptance Criteria

1. THE Classifier SHALL return a workflowData object whose shape matches the TypeScript interface for the assigned workflow.
2. THE Classifier SHALL extract fields that are explicitly present in the email with high confidence.
3. WHEN a field cannot be determined with high confidence, THE Classifier SHALL omit the optional field rather than guessing.
4. THE prompt template SHALL document every field for every workflow, including the allowed enum values for discriminator fields (e.g. `authType`, `packageType`).

### Requirement 5: Spam Scoring

**User Story:** As the filtering system, I need a spam score orthogonal to workflow, so that blocking/quarantine decisions are independent of what kind of email it claims to be.

#### Acceptance Criteria

1. THE Classifier SHALL return a spamScore between 0.0 and 1.0 for every email.
2. spamScore SHALL be orthogonal to workflow — a phishing email gets the real workflow + high score.
3. THE Classifier SHALL consider authentication headers (DKIM, SPF, DMARC pass/fail) as spam scoring inputs.
4. Score ranges: 0.0–0.2 clearly legitimate, 0.2–0.5 somewhat suspicious, 0.5–0.8 likely spam, 0.8–1.0 definite spam/phishing.

### Requirement 6: Summary Generation

**User Story:** As a user scanning my inbox, I need a one-sentence summary per email that tells me what it is and whether I need to act.

#### Acceptance Criteria

1. THE Classifier SHALL return a summary of one sentence, under 150 characters.
2. WHEN the email requires user action, the summary SHALL reflect the action (e.g. "Verify your email for Stripe" not "Email from Stripe").
3. THE summary SHALL be written in the same language as the email body.

### Requirement 7: Label Selection (Closed Set)

**User Story:** As the automation system, I need the classifier to select labels from the user's existing label set, so that only known labels are applied and no invented labels pollute the account.

#### Acceptance Criteria

1. THE Classification Input SHALL include the account's full list of allowed labels.
2. THE Classifier SHALL only return labels that appear in the provided allowed list — never invent new labels.
3. THE processor SHALL validate the classifier's returned labels against the allowed list and discard any that don't match (defence in depth against hallucination).
4. WHEN no labels from the allowed list apply, THE Classifier SHALL return an empty array.
5. THE prompt template SHALL instruct the model to select from the provided list only.

### Requirement 8: Input Formatting and Prompt Injection Defense

**User Story:** As the classifier implementation, I need consistent input formatting and defense against adversarial email content that attempts to manipulate the LLM.

#### Acceptance Criteria

1. THE Classifier SHALL receive a single body field: HTML body stripped to plain text if HTML is available, otherwise raw text body. The caller resolves this — the classifier does not receive both.
2. THE Classifier SHALL truncate body to 4000 characters maximum.
3. THE Classifier SHALL include relevant headers: authentication-results, received-spf, dmarc, list-unsubscribe, precedence, x-mailer, x-spam-status, x-spam-score.
4. THE Classifier SHALL format input as: From, To, Subject, Received timestamp, relevant headers, body.
5. THE Classifier SHALL wrap email content in structural delimiters (e.g. `<email_content>...</email_content>`) and the system prompt SHALL instruct the model to treat everything inside those delimiters as untrusted data to classify — never as instructions to follow.
6. THE Classifier SHALL validate output strictly against the expected schema (valid JSON, workflow in enum, spamScore in range, labels subset of allowed list). If injection causes malformed output, the retry + validation layer catches it.
7. THE Classifier SHALL use AWS Bedrock Guardrails in detect mode (action `NONE`) with content filters and prompt attack detection enabled. Detections are logged as TRACK for observability — they do not block classification or cause retries.
8. Content sanitization for HTML display safety (DOMPurify) happens upstream in the Content Sanitizer Lambda — the classifier receives already-sanitized content.

#### AWS Bedrock Guardrails Pricing Impact

Guardrails pricing is per 1,000 text units (1 text unit = 1,000 characters):
- Content filters: $0.15 per 1,000 text units
- Denied topics: $0.15 per 1,000 text units

For a typical email classification (4000-char body + ~500 chars metadata = ~5 text units input, ~1 text unit output = 6 text units per invocation):
- Per email: 6 text units × ($0.15 + $0.15) / 1000 = $0.0018
- At 10,000 emails/day: ~$0.54/day, ~$16/month
- At 100,000 emails/day: ~$5.40/day, ~$162/month

### Requirement 9: Prompt–Type Alignment

**User Story:** As a developer maintaining the classifier, I need the prompt to be generated from the TypeScript interfaces, so that the two can never drift apart.

#### Acceptance Criteria

1. THE prompt template SHALL be assembled dynamically at build time or runtime from the TypeScript workflow interfaces — not maintained as a separate hardcoded string.
2. THE TypeScript interfaces (WorkflowData union, field names, enum values) are the single source of truth. The prompt is derived from them.
3. WHEN a new field is added to a TypeScript interface, the prompt automatically includes it without manual prompt editing.
4. Per-invocation context (account's allowed labels) SHALL be injected into the prompt at call time.

### Requirement 10: Model Independence

**User Story:** As the platform operator, I need the classifier to work with different LLM backends, so that the model can be swapped without changing the prompt or output contract.

#### Acceptance Criteria

1. THE Classifier SHALL use the same prompt template regardless of which model is invoked.
2. THE model ID SHALL be a compile-time constant (not an environment variable).
3. THE Classifier SHALL support any model that accepts a system prompt + user message and returns text (Anthropic Messages API format or compatible).

### Requirement 11: Classifier Does NOT Assign Urgency

**User Story:** As the system designer, I need urgency to be derived downstream from trusted logic (workflow defaults + account rules), not from the classifier, because the email content is adversarial and cannot be trusted to self-report importance.

#### Acceptance Criteria

1. THE Classifier SHALL NOT return an urgency field.
2. Urgency SHALL be derived downstream by the processor based on workflow, workflowData fields, and account-level rules — never from LLM output.

### Requirement 12: Classification Output as Embedding Input

**User Story:** As the arc matching system, I need embeddings generated from the classifier's structured output rather than raw email content, so that semantic similarity is based on distilled meaning — not noisy HTML and formatting differences.

#### Acceptance Criteria

1. THE embedding generator SHALL receive the classification output (summary + serialized workflowData) as its input — not the raw email body.
2. Classification SHALL complete before embedding generation begins (sequential, not parallel).
3. WHEN classification fails, embedding generation SHALL not proceed — the message retries via SQS.
4. THE embed text format SHALL be: `{workflow}\n{summary}\n{serialized workflowData fields}` — compact, deterministic, and free of attacker-controlled content.

</text>
</invoke>