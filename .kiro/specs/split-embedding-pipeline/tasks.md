# Implementation Plan: Split Embedding Pipeline

## Overview

Split the processor's embedding generation from a single `generateForActiveClusters` call into a two-phase pipeline: a mandatory primary phase (fail-hard for arc matching) and a best-effort secondary phase (warn-only for write-ahead population). Refactor the EmbeddingGenerator interface to use Result-based error handling and explicit primary/secondary methods.

## Tasks

- [x] 1. Foundation: Cluster Registry and Error Types
  - [x] 1.1 Add `getSecondaryClusters` helper to cluster-registry.ts
    - Add a `getSecondaryClusters()` function that returns all active clusters excluding the read cluster
    - When only one active cluster exists, it returns an empty array
    - _Requirements: 5.1, 5.2_

  - [x] 1.2 Write property test for `getSecondaryClusters`
    - **Property 8: getSecondaryClusters is the set difference**
    - **Validates: Requirements 5.1, 5.2**

- [x] 2. Refactor EmbeddingGenerator interface and implementation
  - [x] 2.1 Change `generateForModel` to return `Result<EmbeddingResult, BedrockError>` instead of throwing
    - Update the interface signature in embedding-generator.ts
    - Update the `BedrockEmbeddingGenerator` implementation to return `err(bedrockError(...))` instead of throwing on registry miss or generation failure
    - Remove the `generateForActiveClusters` method from the interface and implementation
    - _Requirements: 3.1, 3.4_

  - [x] 2.2 Add `generateForSecondaryClusters` method
    - Add the method to the `EmbeddingGenerator` interface
    - Implement it in `BedrockEmbeddingGenerator` — calls `getSecondaryClusters()`, invokes Bedrock for each in parallel, returns `Result<EmbeddingResult, BedrockError>[]`
    - _Requirements: 3.2, 3.3_

  - [x] 2.3 Write property test: generateForModel never throws
    - **Property 5: generateForModel never throws**
    - **Validates: Requirements 3.1**

  - [x] 2.4 Write property test: generateForSecondaryClusters result count
    - **Property 6: generateForSecondaryClusters result count**
    - **Validates: Requirements 3.2**

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Update processor pipeline to two-phase embedding
  - [x] 4.1 Implement primary-first embedding generation (fail-hard)
    - Replace the `generateForActiveClusters` call with `generateForModel(embedText, readCluster.modelId)`
    - If the result is `Err`, log ERROR with code `embedding.primary_failed` (including modelId and error cause), and return `err(processError(record.messageId))` for batch item failure
    - Pass the successful primary vector to the arc matcher
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 4.2 Implement secondary embedding generation (warn-only) after arc matching
    - After arc matching completes, call `generateForSecondaryClusters(embedText)`
    - For each `Err` result, log WARN with code `embedding.secondary_failed` and the specified message
    - Continue processing regardless of secondary failures
    - Compose `signal.embeddings` from the primary vector plus all successful secondary vectors
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 4.3 Write property test: primary failure causes batch item failure
    - **Property 1: Primary failure causes batch item failure**
    - **Validates: Requirements 1.2**

  - [x] 4.4 Write property test: primary vector flows to arc matcher
    - **Property 2: Primary vector flows to arc matcher**
    - **Validates: Requirements 1.3**

  - [x] 4.5 Write property test: secondary failures are tolerated
    - **Property 3: Secondary failures are tolerated**
    - **Validates: Requirements 2.2, 2.3**

  - [x] 4.6 Write property test: embeddings map composition
    - **Property 4: Embeddings map composition**
    - **Validates: Requirements 2.4**

- [x] 5. Remove primary/non-primary distinction from executeAuroraUpserts
  - [x] 5.1 Simplify Aurora upsert failure logging
    - Remove the `isPrimary` check and `primaryCluster` variable from `executeAuroraUpserts`
    - Log all failures at ERROR level uniformly (since Aurora failures still gate side-effect dispatch)
    - Remove the `getReadCluster()` call from within `executeAuroraUpserts`
    - _Requirements: 6.1, 6.2_

  - [x] 5.2 Update multi-cluster-aurora-writer tests if they reference primary/non-primary logging
    - Verify existing tests still pass with the simplified logging
    - _Requirements: 6.1, 6.2_

- [x] 6. Update reindex worker to use Result-based generateForModel
  - [x] 6.1 Refactor reindex worker to handle Result return type
    - Replace the try/catch block with Result pattern matching
    - On `Err`, return `err({ signalId, reason })` with the error message from the Result
    - On `Ok`, access `result.value.vector` directly (remove non-null assertion `result.vector!`)
    - _Requirements: 4.1, 4.2_

  - [x] 6.2 Write property test: reindex worker propagates Result errors
    - **Property 7: Reindex worker propagates Result errors**
    - **Validates: Requirements 4.1**

- [x] 7. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses vitest for testing and fast-check for property-based tests
- All code is TypeScript (strict mode) targeting Node.js >=24

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4", "5.1"] },
    { "id": 4, "tasks": ["4.1", "5.2"] },
    { "id": 5, "tasks": ["4.2", "6.1"] },
    { "id": 6, "tasks": ["4.3", "4.4", "6.2"] },
    { "id": 7, "tasks": ["4.5", "4.6"] }
  ]
}
```
