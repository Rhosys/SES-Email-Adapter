# Requirements Document

## Introduction

Add user-authored JavaScript as a rule condition mechanism and as template helper functions. Rules gain a `conditionType` discriminator (`"json_logic" | "js"`) and a `code` field containing a JavaScript function. Templates gain a `functions` array of named JS expressions that produce string values available as `fn.*` in Handlebars rendering. Both execute in the existing `user_code_executor` Lambda (QuickJS/WASM sandbox). This spec also covers dynamic actions (rule code can return an `actions` array merged with static actions), runtime Zod validation of return values, best-effort error handling with system signals, and audit trail versioning for code changes.

## Glossary

- **Rule**: An account-scoped automation record containing a condition expression and a list of actions to execute when the condition matches an inbound signal.
- **Signal**: An immutable inbound email event stored in DynamoDB, enriched with classification metadata.
- **Arc**: A materialized aggregate of related Signals (conversation thread).
- **Condition_Type**: A discriminator field on Rule indicating how the condition is evaluated: `"json_logic"` (default — `condition` field is a JSONLogic JSON string) or `"js"` (new — `code` field is a JavaScript function body).
- **User_Code_Executor**: An isolated Lambda function that runs user-authored JavaScript inside a QuickJS WASM sandbox with timeout enforcement.
- **AST_Validator**: A server-side component that parses JavaScript source into an Abstract Syntax Tree and rejects code containing unsafe constructs or invalid structure.
- **Rule_Evaluator**: The processor component that evaluates a Rule's condition against a Signal/Arc context and returns a match result (object or null).
- **API_Server**: The Hono-based HTTP API that handles CRUD operations for Rules and Templates.
- **Template_Renderer**: The component that executes template functions and renders Handlebars templates for auto-draft emails.
- **Audit_Store**: The DynamoDB audit table that stores versioned change records for rules, templates, and other account resources.
- **System_Signal**: A notification mechanism that alerts the user when their code produced invalid output — includes the resource name, function name, and specific issue.
- **Template_Function**: A named JavaScript arrow expression `(signal, arc) => string` stored on an EmailTemplate, executed in the sandbox, whose return value is available as `fn.{name}` in Handlebars rendering.

## Requirements

### Requirement 1: Rule conditionType Discriminator

**User Story:** As a user, I want to choose between JSONLogic and JavaScript for my rule conditions, so that I can express complex logic that JSONLogic cannot handle.

#### Acceptance Criteria

1. THE API_Server SHALL accept a `conditionType` field on CreateRule and UpdateRule requests with allowed values `"json_logic"` or `"js"`.
2. WHEN `conditionType` is absent on a Rule record, THE Rule_Evaluator SHALL default to `"json_logic"` behavior.
3. WHEN `conditionType` is `"js"`, THE API_Server SHALL require the `code` field to be present and non-empty.
4. WHEN `conditionType` is `"json_logic"` or absent, THE API_Server SHALL validate that the `condition` field contains valid JSON.
5. THE API_Server SHALL persist `conditionType` on the Rule record in DynamoDB.

### Requirement 2: Rule Code Field

**User Story:** As a user, I want to write JavaScript functions as rule conditions, so that I can implement conditional logic beyond what JSONLogic supports.

#### Acceptance Criteria

1. THE API_Server SHALL accept a `code` field (string) on CreateRule and UpdateRule requests.
2. THE API_Server SHALL reject `code` values exceeding 10,240 bytes (10KB) with a 400 response.
3. WHEN `conditionType` is `"js"` and `code` is updated, THE API_Server SHALL clear the `lastError` field on the Rule record.
4. THE API_Server SHALL include the `code` field in GET responses for Rules where it is set.
5. WHEN `conditionType` is `"json_logic"`, THE API_Server SHALL ignore the `code` field if provided.

### Requirement 3: Server-Side AST Validation

**User Story:** As a platform operator, I want user-submitted JavaScript validated before storage, so that malformed or structurally unsafe code is rejected at write time.

#### Acceptance Criteria

1. WHEN a Rule with `conditionType` `"js"` is created or updated, THE AST_Validator SHALL parse the `code` field into an AST.
2. THE AST_Validator SHALL require the code to be a valid arrow function expression or function expression.
3. IF the `code` field contains a syntax error, THEN THE API_Server SHALL return a 400 response with the parse error location.
4. IF the `code` field contains a disallowed AST node, THEN THE API_Server SHALL return a 400 response listing the rejected construct.
5. THE AST_Validator SHALL reject code containing: `eval` calls, `Function` constructor invocations, `import` expressions, `require` calls, dynamic property access on global objects (`globalThis`, `process`, `Deno`, `Bun`), and `while`/`for`/`do` loops without a bounded iteration guard.
6. THE AST_Validator SHALL allow: arrow functions, function expressions, conditional expressions, logical operators, property access on `signal` and `arc` parameters, string/array/object methods, template literals, destructuring, `const`/`let` declarations, and `if`/`else` statements.

### Requirement 4: Rule Code Execution Context

**User Story:** As a user writing JS rule conditions, I want access to the full signal and arc data in my code, so that I can write conditions based on any available field.

#### Acceptance Criteria

1. THE Rule_Evaluator SHALL provide a `signal` object to user code containing: `id`, `from` (object with `address` and optional `name`), `subject`, `summary`, `spamScore`, `workflow`, `recipientAddress`, and `workflowData`.
2. THE Rule_Evaluator SHALL provide an `arc` object to user code containing: `id`, `labels`, `urgency`, `summary`, `workflow`, and `status`.
3. THE Rule_Evaluator SHALL serialize `signal` and `arc` as plain JSON objects with no class instances and no circular references.
4. THE Rule_Evaluator SHALL strip sensitive fields (`s3Key`, `embeddings`, `headers`) from the signal before passing to user code.

### Requirement 5: Rule Code Return Contract and Dynamic Actions

**User Story:** As a user, I want my JS rule condition to optionally return actions alongside the match result, so that conditions can dynamically decide what actions to take.

#### Acceptance Criteria

1. WHEN the user code returns `null` or `undefined`, THE Rule_Evaluator SHALL treat the Rule as non-matching and SHALL NOT execute any static actions.
2. WHEN the user code returns a single RuleAction object (an object with a `type` property matching a valid RuleActionType), THE Rule_Evaluator SHALL treat the Rule as matching and SHALL append that action to the Rule's static `actions` array during outcome derivation.
3. WHEN the user code returns an array, THE Rule_Evaluator SHALL treat the Rule as matching and SHALL validate each element against the RuleAction schema using Zod, appending all valid entries to the Rule's static `actions` array.
4. WHEN the user code returns `true` or any other truthy value that is not a RuleAction object or array, THE Rule_Evaluator SHALL treat the Rule as matching and SHALL execute only the Rule's static actions (no dynamic actions appended).
5. WHEN a returned RuleAction (single or within an array) fails Zod validation, THE Rule_Evaluator SHALL discard that entry, use remaining valid entries, and log at WARN level.
6. WHEN any returned RuleAction fails validation, THE Rule_Evaluator SHALL create a System_Signal notifying the user with the rule name and the specific validation issue.

### Requirement 6: Rule Code Error Handling

**User Story:** As a user, I want to know when my JS rule condition fails at runtime, so that I can debug and fix my code.

#### Acceptance Criteria

1. IF the User_Code_Executor returns an error (timeout, runtime_error, sandbox_violation), THEN THE Rule_Evaluator SHALL treat the Rule as non-matching.
2. IF the User_Code_Executor returns an error, THEN THE Rule_Evaluator SHALL annotate the Rule's `lastError` field with the error type and message.
3. IF the User_Code_Executor returns an error, THEN THE Rule_Evaluator SHALL log at WARN level with the rule ID, account ID, error type, and error message.
4. WHEN a Rule's `lastError` is set, THE API_Server SHALL include the `lastError` field in GET responses for that Rule.

### Requirement 7: Template Functions Field

**User Story:** As a user, I want to define JavaScript helper functions on my email templates, so that I can compute dynamic values for use in template rendering.

#### Acceptance Criteria

1. THE API_Server SHALL accept a `functions` field on CreateTemplate and UpdateTemplate requests as an array of objects with `name` (string) and `code` (string) properties.
2. THE API_Server SHALL validate that each function `name` is a valid JavaScript identifier (matches `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`).
3. THE API_Server SHALL reject any individual function `code` exceeding 10,240 bytes (10KB) with a 400 response.
4. THE API_Server SHALL validate each function's `code` through the AST_Validator (same rules as rule code: must be a valid arrow expression or function expression).
5. THE API_Server SHALL persist the `functions` array on the EmailTemplate record in DynamoDB.
6. THE API_Server SHALL include the `functions` field in GET responses for Templates where it is set.

### Requirement 8: Template Function Execution

**User Story:** As a user, I want my template functions executed during email rendering, so that their return values are available as `fn.*` variables in my Handlebars templates.

#### Acceptance Criteria

1. WHEN rendering a template with a `functions` array, THE Template_Renderer SHALL invoke the User_Code_Executor for each function with purpose `"template_function"` and the function's `code` field.
2. THE Template_Renderer SHALL provide each function with `signal` and `arc` objects using the same fields as rule code execution (Requirement 4).
3. WHEN a template function returns a string value, THE Template_Renderer SHALL make it available as `fn.{functionName}` in the Handlebars rendering context.
4. THE Template_Renderer SHALL pass the Handlebars context containing `sender` (object with `name` and `address`) and `fn` (object mapping function names to their string results).

### Requirement 9: Template Function Error Handling

**User Story:** As a user, I want to know when my template functions fail, and I want the system to protect me from sending emails with broken content.

#### Acceptance Criteria

1. IF any template function returns a non-string value or errors during execution, THEN THE Template_Renderer SHALL leave the email as a draft (prevent auto-send).
2. IF a template function errors, THEN THE Template_Renderer SHALL log at WARN level with the template name, function name, and error details.
3. IF a template function returns an invalid value, THEN THE Template_Renderer SHALL create a System_Signal notifying the user with the template name, function name, and the specific issue.
4. IF a template function errors, THEN THE Template_Renderer SHALL annotate the function's `lastError` field on the template record with the error message.
5. WHEN a template function errors, THE Template_Renderer SHALL substitute an empty string for that function's value in the Handlebars context (best-effort rendering for the draft).

### Requirement 10: Audit Trail for Code Changes

**User Story:** As a user, I want a version history of my rule and template code changes, so that I can review what changed and when.

#### Acceptance Criteria

1. WHEN a Rule with `conditionType` `"js"` is created or its `code` field is updated, THE API_Server SHALL write an audit event to the Audit_Store before persisting the Rule change.
2. WHEN a Template's `functions` array is created or updated, THE API_Server SHALL write an audit event to the Audit_Store before persisting the Template change.
3. THE Audit_Store SHALL record the audit event with: account ID, user ID, action (`"created"` or `"updated"`), resource type (`"rule"` or `"template"`), resource ID, and a `changes` object containing the previous and new code values.
4. THE API_Server SHALL write to the Audit_Store first, then write to the actual resource (no DynamoDB transactions between the two writes).
5. THE API_Server SHALL proceed with the resource write even if the audit write fails (audit is best-effort; log at WARN level on failure).

### Requirement 11: Sandboxed Execution Environment

**User Story:** As a platform operator, I want all user code executed in an isolated sandbox with resource limits, so that user code cannot affect system stability or access unauthorized data.

#### Acceptance Criteria

1. THE User_Code_Executor SHALL execute user code inside a QuickJS WASM context with no access to the host filesystem, network, or Node.js APIs.
2. THE User_Code_Executor SHALL enforce an execution timeout (configured at the Lambda level) per invocation.
3. THE User_Code_Executor SHALL accept a `purpose` field (`"rule_condition"` or `"template_function"`) to distinguish execution modes.
4. THE User_Code_Executor SHALL accept a `tenantId` field for tenant isolation and logging.
5. THE User_Code_Executor SHALL return a structured response: `{ success: true, result: unknown }` on success or `{ success: false, error: { type, message } }` on failure.

### Requirement 12: Backward Compatibility

**User Story:** As an existing user with JSONLogic rules, I want my rules to continue working without modification after this feature is deployed.

#### Acceptance Criteria

1. WHEN `conditionType` is `"json_logic"` or absent, THE Rule_Evaluator SHALL evaluate the `condition` field as a JSONLogic JSON string using the existing JSONLogic engine.
2. THE API_Server SHALL not require `conditionType` on CreateRule or UpdateRule requests (it remains optional, defaulting to `"json_logic"`).
3. THE API_Server SHALL continue to accept rules with only a `condition` field and no `conditionType` or `code`, treating them as JSONLogic rules.
4. THE API_Server SHALL not require the `functions` field on CreateTemplate or UpdateTemplate requests (it remains optional).
