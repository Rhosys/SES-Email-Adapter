# Requirements Document

## Introduction

Refactor the embed-text generation pipeline and reindex worker to eliminate the legacy MIME-based path (S3 fetch → parse → embed) and unify both live processing and reindex on the same classification-output-based approach. The signal becomes the single source of truth for all classifier-produced fields, enabling the reindex worker to reconstruct embeddings without touching S3.

## Glossary

- **Signal**: A DynamoDB record representing an inbound email event, storing metadata, classification output, and cached embedding vectors.
- **SignalBase**: The base type for all signal records (shared fields: id, accountId, status, etc.).
- **EmailSignalData**: The `data` property of an email signal — contains from, subject, workflow, workflowData, spamScore, embeddings, s3Key, labels, etc.
- **ClassificationOutput**: The structured output of the email classifier — contains workflow, workflowData, spamScore, summary, and labels. All fields required.
- **Embed_Text**: A deterministic text representation of a ClassificationOutput used as input to the embedding model.
- **Reindex_Worker**: The SQS-triggered worker that scans DynamoDB signals and upserts embedding vectors to Aurora.
- **Embedding_Generator**: The service that calls Bedrock to produce a vector from embed text.
- **Processor**: The live inbound email processing Lambda that classifies and stores signals.
- **Arc**: A display-layer grouping of related signals — a facade over signal data, not a source of truth.

## Requirements

### Requirement 1: Signal stores all classifier fields

**User Story:** As the system, I want all classifier-produced fields persisted on the signal, so that downstream consumers (reindex, API) can reconstruct ClassificationOutput without fetching MIME from S3.

#### Acceptance Criteria

1. THE Signal SHALL store workflow, workflowData, spamScore, and summary fields in EmailSignalData with values identical to the corresponding fields of the ClassificationOutput produced during live processing.
2. THE SignalBase SHALL include a `labels` field of type `string[]` that stores the full resolved label set (system labels + classifier labels + rule-assigned labels), with a maximum of 50 labels per signal.
3. WHEN a signal is read from DynamoDB and the stored record lacks a `labels` field, THE database read layer SHALL default the value to an empty array (`[]`) without changing the exposed type contract.
4. WHEN the Processor stores a signal, THE Processor SHALL persist the `labels` field on SignalBase as a non-optional `string[]`, ensuring the stored value includes all system labels (from `assignSystemLabels`), classifier labels (from `ClassificationOutput.labels`), and rule-assigned labels (from matched rule actions) merged without duplicates.

### Requirement 2: Shared embedding generation function

**User Story:** As a developer, I want a single shared function for generating embeddings from classification data, so that both the live processor and reindex worker produce identical vectors for the same input.

#### Acceptance Criteria

1. THE Embedding module SHALL export a function `generateEmbeddingFromClassification` that accepts a ClassificationOutput, a senderDomain string, an Embedding_Generator instance, and a modelId string, and returns a `Result<EmbeddingResult, BedrockError>`.
2. WHEN `generateEmbeddingFromClassification` is called, THE function SHALL call `buildEmbedText` with the ClassificationOutput and senderDomain, then call the Embedding_Generator's `generateForModel` method with the resulting text and modelId, and return the Result.
3. IF the Embedding_Generator returns an error Result, THEN `generateEmbeddingFromClassification` SHALL propagate the error Result to the caller without modification.
4. THE Processor SHALL call `generateEmbeddingFromClassification` for live embedding generation.
5. THE Reindex_Worker SHALL call `generateEmbeddingFromClassification` for embedding regeneration.

### Requirement 3: Updated buildEmbedText format

**User Story:** As the system, I want the embed text format to include sender domain, workflow, summary, labels, and workflowData, so that the embedding captures the full semantic fingerprint of the classified email.

#### Acceptance Criteria

1. WHEN `buildEmbedText` is called with a ClassificationOutput and a `senderDomain` string, THE function SHALL produce a newline-delimited text string with lines in this order: senderDomain, workflow, summary, labels joined by comma with no spaces, followed by flattened workflowData key=value pairs (one per line, excluding the `workflow` discriminator key, skipping null values).
2. THE `buildEmbedText` function SHALL NOT include spamScore in the output text.
3. THE `buildEmbedText` function SHALL accept a `senderDomain` parameter (the full from-address domain, e.g. `marketing.stripe.com`) as its first argument in addition to the ClassificationOutput.
4. IF the labels array is empty, THEN THE `buildEmbedText` function SHALL emit an empty string for the labels line.

### Requirement 4: Reindex worker uses signal data

**User Story:** As the system, I want the reindex worker to generate embeddings from signal fields stored in DynamoDB, so that it no longer requires S3 access to raw MIME.

#### Acceptance Criteria

1. WHEN the Reindex_Worker processes a signal, THE Reindex_Worker SHALL read the signal from DynamoDB and reconstruct a ClassificationOutput from the signal's stored fields (workflow, workflowData, spamScore, summary, labels) and derive the senderDomain from `data.from.address`.
2. IF a signal lacks any field required to reconstruct a ClassificationOutput (workflow, workflowData, spamScore, summary) or lacks `data.from.address`, THEN THE Reindex_Worker SHALL skip that signal and log an error with a static message string (not templated), including the full signal object and the names of the missing fields in the log context.
3. WHEN the signal's `data.embeddings[targetModelId]` contains a cached vector AND the `force` flag is false, THE Reindex_Worker SHALL use the cached vector without regenerating and upsert it to the target Aurora cluster.
4. WHEN the signal's `data.embeddings[targetModelId]` is missing OR the `force` flag is true, THE Reindex_Worker SHALL call `generateEmbeddingFromClassification` with the reconstructed ClassificationOutput and derived senderDomain to produce a new vector, save it to `signal.data.embeddings[targetModelId]` in DynamoDB, and upsert it to the target Aurora cluster.
5. THE Reindex_Worker SHALL NOT fetch MIME from S3.

### Requirement 5: Force flag on reindex endpoint

**User Story:** As an admin, I want a `force` boolean on the `/reindex` endpoint, so that I can regenerate all embeddings even when cached vectors exist.

#### Acceptance Criteria

1. THE `/reindex` API endpoint SHALL accept an optional `force` boolean field in the request body, defaulting to `false` when omitted.
2. IF the `/reindex` request body contains a `force` field that is not a boolean, THEN THE `/reindex` API endpoint SHALL reject the request with a 400 status code and an error message indicating invalid input.
3. WHEN `force` is true, THE Reindex_Worker SHALL ignore cached embeddings and regenerate vectors for every signal.
4. WHEN `force` is false or omitted, THE Reindex_Worker SHALL skip regeneration for signals that already have the target model's embedding cached, and upsert the existing cached vector to Aurora instead.

### Requirement 6: ClassificationOutput reconstruction alignment

**User Story:** As a developer, I want confidence that a signal built by the processor can reconstruct a valid ClassificationOutput, so that live and reindex paths stay aligned.

#### Acceptance Criteria

1. THE ClassificationOutput type SHALL have no optional properties — all fields (workflow, workflowData, spamScore, summary, labels) are required.
2. FOR ALL signals built by the Processor, reconstructing a ClassificationOutput from the signal's stored fields SHALL produce an object equivalent to the original ClassificationOutput (round-trip property).
3. THE codebase SHALL include a unit test that takes a signal produced by `buildSignal` and asserts that a ClassificationOutput reconstructed from its stored fields satisfies the ClassificationOutput type with all fields present and values matching the original input.

### Requirement 8: Signal labels exposed on API

**User Story:** As a frontend consumer, I want the signal's resolved labels returned in API responses, so that I can display per-signal labels without deriving them from matched rules.

#### Acceptance Criteria

1. WHEN `toApiSignal` transforms a signal for an API response, THE response object SHALL include a `labels` field containing the value of `signal.labels` (the `string[]` from SignalBase).
2. THE OpenAPI schema for Signal responses SHALL declare a `labels` field of type `array` with items of type `string`.

### Requirement 9: Inbound sender address validation

**User Story:** As the system, I want inbound emails with malformed sender addresses quarantined early in processing, so that downstream logic (sender domain extraction, embed text, arc matching) always operates on well-formed addresses.

#### Acceptance Criteria

1. WHEN the Processor parses an inbound email's `from` address, THE Processor SHALL validate it using `isValidEmail` immediately after MIME parsing and before classification.
2. IF `isValidEmail` returns false for the parsed `from` address, THEN THE Processor SHALL log a TRACK entry with a static message string and context containing the full parsed MIME headers, the invalid address, and the SES message ID, and SHALL set the signal status to `quarantine_hidden`.
3. IF `isValidEmail` returns false, THEN THE Processor SHALL skip classification, embedding generation, and arc matching for that signal — it is stored as a quarantined signal with workflow `"unspecified"` and empty workflowData.

### Requirement 10: Domain and sender input validation

**User Story:** As the system, I want user-submitted domain and sender values validated strictly at write time, so that only real, resolvable domains are stored.

#### Acceptance Criteria

1. THE codebase SHALL export an `isValidDomain(value: string): boolean` function that enforces: total length ≤ 253, at least two labels, each label 1–63 chars of lowercase alphanumeric + hyphen only, no label starts/ends with hyphen, no consecutive/leading/trailing dots, TLD is ≥ 2 alphabetic characters, no underscores, no protocol prefix, no path/port.
2. THE `CreateDomainRequest` zod schema SHALL validate the `domain` field using `isValidDomain` after lowercasing and trimming, rejecting invalid values with 400 and error code `INVALID_DOMAIN_FORMAT`.
3. WHEN a domain passes format validation, THE POST /domains handler SHALL perform a DNS NS lookup on the submitted domain. IF the domain has no NS records (NXDOMAIN or empty response), THE handler SHALL reject with 422 and error code `DOMAIN_NOT_RESOLVABLE`.
4. THE `CreateSenderRequest` zod schema SHALL validate the `domain` field using `isValidDomain`, rejecting invalid values with 400 and error code `INVALID_DOMAIN_FORMAT`.
5. WHEN creating a sender, THE POST /senders handler SHALL verify that the alias (identified by the `address` path parameter) exists for the account. IF the alias does not exist, THE handler SHALL reject with 404 and error code `ALIAS_NOT_FOUND`.
6. WHEN a sender domain passes format validation, THE POST /senders handler SHALL perform a DNS MX lookup on the submitted domain. IF the domain has no MX records, THE handler SHALL reject with 422 and error code `SENDER_DOMAIN_NO_MX`.
7. IF validation fails, THE error response SHALL include the submitted value in the response body so the user can see what was rejected.

### Requirement 7: Dead code deletion

**User Story:** As a developer, I want legacy MIME-based embedding code removed, so that the codebase has a single embedding path and no dead code.

#### Acceptance Criteria

1. THE codebase SHALL NOT contain the file `generate-embedding-from-s3.ts`.
2. THE codebase SHALL NOT contain the functions `buildMimeEmbedText` or `extractEmbedTextInput`.
3. THE codebase SHALL NOT contain the type `EmbedTextInput` in `embed-text.ts` or `types/index.ts`.
4. THE codebase SHALL NOT contain any import statement referencing `generate-embedding-from-s3`, `buildMimeEmbedText`, `extractEmbedTextInput`, or `EmbedTextInput` from the deleted sources.
5. THE codebase SHALL compile without errors after removal of the legacy artifacts (verified by `npm run check` passing).
