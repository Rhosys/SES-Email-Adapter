# Requirements Document

## Introduction

The email-catcher backend processor currently generates embeddings for all active clusters in a single parallel call (`generateForActiveClusters`). When the primary cluster's Bedrock call fails, the processor proceeds without a valid embedding for arc matching, causing it to create duplicate arcs instead of attaching signals to existing ones. This corrupts the data model.

This feature splits embedding generation into a two-phase pipeline: a mandatory primary-first phase (required for arc matching) and a best-effort secondary phase (for Aurora write-ahead population). This ensures arc matching always has a valid embedding or the message is retried, while secondary failures are tolerated and logged for later revalidation.

## Glossary

- **Processor**: The SQS message handler (`processMessage`) that ingests inbound email signals, performs arc matching, applies rules, and persists the result.
- **Embedding_Generator**: The service that calls AWS Bedrock to produce vector embeddings from email text.
- **Primary_Cluster**: The single active cluster designated as the read cluster (first entry in `getActiveClusters()`), whose embedding is used for similarity-based arc matching.
- **Secondary_Cluster**: Any active cluster that is not the primary cluster; used for write-ahead population of Aurora indexes.
- **Arc_Matcher**: The component that performs similarity search against Aurora to find an existing arc for an inbound signal.
- **Cluster_Registry**: The static registry of Aurora cluster entries and their associated Bedrock model IDs.
- **Embed_Text**: The concatenated text representation of an email used as input to the embedding model.
- **BedrockError**: A typed error indicating a Bedrock InvokeModel call failed, carrying the `modelId` and underlying cause.
- **Batch_Item_Failure**: An SQS partial batch failure response that causes the message to be retried.

## Requirements

### Requirement 1: Primary Embedding Generation

**User Story:** As the processor pipeline, I want to generate the primary cluster embedding before arc matching, so that similarity search always operates on a valid vector.

#### Acceptance Criteria

1. WHEN an inbound signal is being processed, THE Processor SHALL generate an embedding for the Primary_Cluster before performing arc matching.
2. IF the Primary_Cluster embedding generation fails, THEN THE Processor SHALL log an ERROR with code `embedding.primary_failed` including the modelId and error cause, and return a Batch_Item_Failure for the message.
3. WHEN the Primary_Cluster embedding generation succeeds, THE Processor SHALL pass the resulting vector to the Arc_Matcher for similarity search.

### Requirement 2: Secondary Embedding Generation

**User Story:** As the processor pipeline, I want to generate secondary cluster embeddings after arc matching but before signal save, so that Aurora indexes are populated without blocking the critical path.

#### Acceptance Criteria

1. WHEN the Primary_Cluster embedding has succeeded and arc matching is complete, THE Processor SHALL generate embeddings for all Secondary_Clusters in parallel.
2. IF any Secondary_Cluster embedding generation fails, THEN THE Processor SHALL log a WARN with code `embedding.secondary_failed` and message: "Secondary embedding generation failed. We will run the full re-index anyway before switching over — revalidate all WARNINGS to check for failures in generating Aurora embeddings."
3. IF any Secondary_Cluster embedding generation fails, THEN THE Processor SHALL continue processing without returning a Batch_Item_Failure.
4. WHEN secondary embedding generation completes, THE Processor SHALL include all successful embedding vectors (primary and secondary) in `signal.embeddings` before persisting to DynamoDB.

### Requirement 3: Embedding Generator Interface Refactoring

**User Story:** As a developer, I want the Embedding_Generator interface to expose explicit single-model and secondary-cluster methods with Result-based error handling, so that callers can handle failures precisely.

#### Acceptance Criteria

1. THE Embedding_Generator SHALL change the existing `generateForModel` method signature from `Promise<EmbeddingResult>` (throws on error) to `Promise<Result<EmbeddingResult, BedrockError>>` (returns error in Result).
2. THE Embedding_Generator SHALL expose a `generateForSecondaryClusters` method that accepts Embed_Text and returns `Promise<Result<EmbeddingResult, BedrockError>[]>`.
3. THE EmbeddingResult type SHALL have required `vector` and `dimensions` fields (not optional).
4. THE Embedding_Generator SHALL remove the `generateForActiveClusters` method from the public interface.

### Requirement 4: Reindex Worker Compatibility

**User Story:** As the reindex worker, I want to use the Result-based `generateForModel` instead of wrapping it in try/catch, so that error handling is consistent with the rest of the codebase.

#### Acceptance Criteria

1. WHEN the reindex worker calls `generateForModel` and receives an error result, THE Reindex_Worker SHALL propagate the failure using the Result error path instead of try/catch.
2. THE Reindex_Worker SHALL remove the non-null assertion (`result.vector!`) and access the vector from the unwrapped Ok value.

### Requirement 5: Cluster Registry Secondary Cluster Helper

**User Story:** As the embedding generation phase, I want a helper to retrieve all active clusters excluding the primary, so that secondary generation targets the correct set.

#### Acceptance Criteria

1. THE Cluster_Registry SHALL expose a `getSecondaryClusters` function that returns all active clusters excluding the read cluster.
2. WHEN only one active cluster exists (the primary), THE `getSecondaryClusters` function SHALL return an empty array.

### Requirement 6: Remove Primary/Non-Primary Logging from Aurora Upserts

**User Story:** As a developer, I want to remove the primary/non-primary failure distinction logging from `executeAuroraUpserts`, so that embedding failure logging is consolidated in the generation phase.

#### Acceptance Criteria

1. THE Multi_Cluster_Aurora_Writer SHALL remove any primary/non-primary distinction in its error logging for embedding upsert failures.
2. WHEN an Aurora upsert fails, THE Multi_Cluster_Aurora_Writer SHALL log the failure without referencing whether the cluster is primary or non-primary.
