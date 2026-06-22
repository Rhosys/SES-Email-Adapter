# Implementation Plan: Embed-Text Refactor

## Overview

Unify embedding generation so both live processor and reindex worker use classification-output-based embed text. Add `labels` to SignalBase, validate inbound sender addresses, validate user-submitted domains/senders, expose labels on the API, and delete the legacy MIME-based embedding path.

## Tasks

- [ ] 1. Add `labels: string[]` to SignalBase and default at read-time
  - [x] 1.1 Add `labels: string[]` to `SignalBase` in `src/types/index.ts`. Remove the `EmbedTextInput` interface from `src/types/index.ts`.
  - [x] 1.2 In `src/database/arc-database.ts`, update all signal read methods (getSignalById, getSignalByMessageId, listSignals, findSignalByEmailMessageId, and any query result mapping) to default `labels` to `[]` when the stored DDB item lacks the field. The exposed return type remains `Signal` with `labels: string[]` (non-optional).
  - [~] 1.3 In `src/processor/processor.ts`, update `buildSignal` to accept a `labels: string[]` parameter and set it on the returned signal at the SignalBase level. Update the call site to pass the merged label set: `[...new Set([...systemLabels, ...classificationOutput.labels, ...outcome.additionalLabels])]`.
    - _Requirements: R1.2, R1.3, R1.4_

- [ ] 2. Rewrite `buildEmbedText` with new format
  - [x] 2.1 In `src/embedding/embed-text.ts`, change the `buildEmbedText` signature to `buildEmbedText(senderDomain: string, classification: ClassificationOutput): string`. Update the body to produce lines in order: senderDomain, workflow, summary, labels comma-joined (empty string if empty array), then flattened workflowData key=value pairs (excluding `workflow` discriminator, skipping nulls). Remove spamScore from output.
  - [x] 2.2 Update the existing `buildEmbedText` unit tests to cover the new format: verify line order, verify labels line when populated, verify empty labels line, verify senderDomain appears first, verify workflowData flattening unchanged.
  - [~] 2.3 Update the call site in `src/processor/processor.ts` to pass `senderDomain` (extracted from `parsed.from.address.split("@").pop()!`) as the first argument.
    - _Requirements: R3.1, R3.2, R3.3, R3.4_

- [ ] 3. Create shared `generateEmbeddingFromClassification` function
  - [~] 3.1 Create `src/embedding/generate-embedding.ts` exporting `generateEmbeddingFromClassification(classification: ClassificationOutput, senderDomain: string, embeddingGenerator: EmbeddingGenerator, modelId: string): Promise<Result<EmbeddingResult, BedrockError>>`. Implementation: call `buildEmbedText(senderDomain, classification)` then `embeddingGenerator.generateForModel(embedText, modelId)`, return the result.
  - [~] 3.2 Update `src/processor/processor.ts` to import and call `generateEmbeddingFromClassification` for the primary embedding generation (replacing the inline `buildEmbedText` + `generateForModel` calls). Pass the same function for secondary cluster generation.
    - _Requirements: R2.1, R2.2, R2.3, R2.4_

- [ ] 4. Refactor reindex worker to use signal data
  - [~] 4.1 Rewrite the reindex handler (find it via the `/reindex` route or SQS message type `"reindex"`) to: read signal from DDB, validate required fields (workflow, workflowData, spamScore, summary, data.from.address) — if any missing, log error with static message and signal + missingFields in context, skip signal. Reconstruct `ClassificationOutput` from signal fields. Derive senderDomain from `signal.data.from.address.split("@").pop()!`.
  - [~] 4.2 Implement the cache-or-regenerate logic: if `signal.data.embeddings[targetModelId]` exists AND `force` is false → upsert cached vector to Aurora. Otherwise → call `generateEmbeddingFromClassification`, save new vector to `signal.data.embeddings[targetModelId]` in DDB, then upsert to Aurora.
  - [~] 4.3 Write tests: signal with cached vector + force=false → no Bedrock call, Aurora upsert uses cached. Signal with cached vector + force=true → Bedrock called, new vector saved. Signal missing workflow → error logged, signal skipped. Signal with no cached vector → Bedrock called, vector saved.
    - _Requirements: R4.1, R4.2, R4.3, R4.4, R4.5, R2.5_

- [ ] 5. Add `force` flag to `/reindex` endpoint
  - [-] 5.1 In `src/api/app.ts`, update the `/reindex` route's request body schema to include `force: z.boolean().optional().default(false)`. Pass the value through to the reindex handler.
  - [-] 5.2 Write a test: POST /reindex with `force: true` passes validation. POST /reindex with `force: "yes"` returns 400. POST /reindex without force defaults to false.
    - _Requirements: R5.1, R5.2, R5.3, R5.4_

- [ ] 6. Round-trip alignment test
  - [~] 6.1 Write a unit test that constructs a `ClassificationOutput`, passes it through `buildSignal`, then reconstructs a `ClassificationOutput` from the resulting signal's stored fields (`signal.data.workflow`, `signal.data.workflowData`, `signal.data.spamScore`, `signal.data.summary`, `signal.labels`). Assert the reconstructed object equals the original.
    - _Requirements: R6.1, R6.2, R6.3_

- [ ] 7. Expose `labels` on API signal responses
  - [~] 7.1 In `src/api/transform.ts`, update `toApiSignal` to include `labels: signal.labels` in the `base` object.
  - [~] 7.2 In `src/api/schemas.ts`, update the Signal response schema to include `labels: z.array(z.string())`.
    - _Requirements: R8.1, R8.2_

- [ ] 8. Inbound sender address validation
  - [-] 8.1 In `src/processor/processor.ts` `processMessage`, immediately after MIME parsing, call `isValidEmail(parsed.from.address, this.logger)`. If false: log TRACK with static message "Inbound email has malformed sender address — quarantining." and context `{ code: "processor.invalid_sender_address", signal: { sesMessageId, destination: message.destination }, fromAddress: parsed.from.address, headers: parsed.headers }`. Then store a quarantined signal with `status: "quarantine_hidden"`, `workflow: "unspecified"`, `workflowData: { workflow: "unspecified" }`, `spamScore: 0`, `summary: ""`, `labels: []`. Return ok (do not retry).
  - [-] 8.2 Write tests: valid from address proceeds normally. Invalid from address (multiple @, no domain, empty) → signal stored as quarantine_hidden, no classification called, no embedding generated.
    - _Requirements: R9.1, R9.2, R9.3_

- [ ] 9. Domain and sender input validation
  - [x] 9.1 Create `src/email/validate-domain.ts` exporting `isValidDomain(value: string): boolean`. Rules: length ≤ 253, at least two labels, each label 1–63 chars, lowercase alphanumeric + hyphen only, no label starts/ends with hyphen, no consecutive/leading/trailing dots, TLD ≥ 2 alphabetic chars, no underscores, no protocol prefix, no path/port.
  - [-] 9.2 Write unit tests for `isValidDomain`: valid domains (example.com, sub.example.co.uk), invalid cases (too long, single label, starts with hyphen, numeric TLD, contains underscore, has protocol, has port, empty, dots only, trailing dot).
  - [~] 9.3 Update `CreateDomainRequest` in `src/api/requests.ts` to validate `domain` with `isValidDomain` via `.refine()`, rejecting with a message that includes the submitted value. Update `CreateSenderRequest` similarly.
  - [~] 9.4 In the POST /domains handler (`src/api/app.ts`), after format validation passes, perform a DNS NS lookup using `node:dns/promises` `resolveNs(domain)`. If it throws ENOTFOUND or returns empty, return 422 with error code `DOMAIN_NOT_RESOLVABLE` and the domain in the body.
  - [~] 9.5 In the POST /senders handler (`src/api/app.ts`), add alias existence check: call `accountDb.getAlias(accountId, address)`, if null return 404 with `ALIAS_NOT_FOUND`. After format validation, perform `resolveMx(domain)`. If it throws ENOTFOUND or returns empty, return 422 with `SENDER_DOMAIN_NO_MX` and the domain in the body.
  - [~] 9.6 Write integration-style tests: POST /domains with invalid format → 400. POST /domains with non-resolvable domain → 422. POST /senders with non-existent alias → 404. POST /senders with no-MX domain → 422.
    - _Requirements: R10.1, R10.2, R10.3, R10.4, R10.5, R10.6, R10.7_

- [ ] 10. Delete dead code
  - [~] 10.1 Delete `src/embedding/generate-embedding-from-s3.ts`. Remove `buildMimeEmbedText`, `extractEmbedTextInput`, `EmbedTextInput` interface, `sanitizeBody`, `buildBodyContent`, `reduceLinks`, `stripCss`, `stripScripts`, `stripImages`, `stripHtmlTags`, `extractReturnPathAddress` from `src/embedding/embed-text.ts`. Keep `reduceLink` only if still imported elsewhere (grep first). Remove all imports referencing deleted symbols.
  - [~] 10.2 Remove `EmbedTextInput` from `src/types/index.ts` (already done in 1.1).
  - [~] 10.3 Run `npm run test` to verify compilation and all tests pass after deletions.
    - _Requirements: R7.1, R7.2, R7.3, R7.4, R7.5_

## Notes

- Tasks 1, 2, 8, 9 are independent and can be done in parallel.
- Task 3 depends on task 2 (new `buildEmbedText` signature).
- Task 4 depends on tasks 1 and 3 (labels on signal + shared function).
- Task 5 is independent (schema-only).
- Task 6 depends on tasks 1 and 2.
- Task 7 depends on task 1.
- Task 10 depends on all others being complete.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "2.2", "5.1", "5.2", "8.1", "8.2", "9.1", "9.2"] },
    { "id": 1, "tasks": ["1.3", "2.3", "3.1", "9.3", "9.4", "9.5", "9.6"] },
    { "id": 2, "tasks": ["3.2", "4.1", "4.2", "4.3", "6.1", "7.1", "7.2"] },
    { "id": 3, "tasks": ["10.1", "10.2", "10.3"] }
  ]
}
```
