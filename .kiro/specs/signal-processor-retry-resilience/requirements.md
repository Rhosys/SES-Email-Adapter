# Requirements Document

## Introduction

Refactor the signal processor's retry and resilience model from a binary dedup-or-skip pattern to a resume-from-where-we-left-off pattern. The current `processRecord` method skips all processing on retry (receiveCount > 1) if the signal already exists in DynamoDB. This loses work when failures occur after the signal is saved but before Aurora upserts or side-effects complete. The new model reads prior state on retry, resumes from the first incomplete step, and guarantees Aurora writes succeed before firing side-effects.

## Glossary

- **Processor**: The `SignalProcessor` class in `processor.ts` that handles inbound SQS records containing email signals
- **Signal**: A DynamoDB record representing a processed inbound email, keyed by SES message ID
- **Arc**: A DynamoDB record representing a conversation thread or grouping of related signals
- **Aurora_Writer**: The `MultiClusterAuroraWriter` that upserts embedding vectors into Aurora Serverless clusters
- **Cluster_Registry**: The compile-time registry of active Aurora clusters (`CLUSTER_REGISTRY` in `cluster-registry.ts`)
- **Primary_Cluster**: The first active entry in `CLUSTER_REGISTRY` (returned by `getReadCluster()`)
- **Side_Effect**: Any action derived from matched rules that fires after Aurora succeeds: forward, notify, auto-reply, pong, auto-draft, calendar signal
- **DDB**: DynamoDB, the primary data store for signals and arcs
- **Outcome**: The `ProcessingOutcome` struct derived from `matchedRules` via `deriveOutcome()`
- **Receive_Count**: The `ApproximateReceiveCount` SQS attribute indicating how many times a message has been delivered
- **Batch_Item_Failure**: An entry in the `batchItemFailures` response array that tells SQS to redeliver a specific record
- **S3_Retention**: The fire-and-forget S3 tagging/copy operation that applies plan-based retention policies

## Requirements

### Requirement 1: Resume signal state on retry

**User Story:** As the system, I want to read existing signal and arc state from DDB on retry, so that processing resumes from where it left off instead of skipping entirely.

#### Acceptance Criteria

1. WHEN Receive_Count is greater than 1, THE Processor SHALL read the signal record from DDB by account ID and SES message ID
2. WHEN the signal record exists in DDB on retry, THE Processor SHALL read the arc record by the signal's `arcId` field and resume processing from the first incomplete step rather than re-executing already-persisted steps
3. WHEN the signal record does not exist in DDB on retry, THE Processor SHALL proceed with first-attempt processing (parse, classify, match, save)
4. THE Processor SHALL save the arc (leaf node) to DDB before saving the signal (dependent node), so that the arc is guaranteed to exist whenever the signal exists
5. IF the DDB read for the signal or arc record fails on retry, THEN THE Processor SHALL treat the message as failed and allow it to return to the queue without data loss

### Requirement 2: Aurora upsert before side-effects

**User Story:** As the system, I want Aurora embedding upserts to complete before any side-effects fire, so that a failed Aurora write triggers a retry that re-executes side-effects.

#### Acceptance Criteria

1. THE Processor SHALL execute all Aurora_Writer upserts (across all active clusters) before executing any Side_Effect
2. WHEN all Aurora_Writer upserts succeed, THE Processor SHALL proceed to execute side-effects
3. THE Processor SHALL save the arc to DDB before saving the signal (arc first, then signal). DDB is the source of truth for retry resumption.
4. IF the DDB save of the arc or signal fails, THEN THE Processor SHALL return the record as a Batch_Item_Failure without attempting Aurora upserts or side-effects

### Requirement 3: Aurora failure forces retry

**User Story:** As the system, I want Aurora upsert failures on any cluster to force a retry via batchItemFailure, so that embeddings are eventually consistent across all clusters.

#### Acceptance Criteria

1. WHEN an Aurora_Writer upsert throws an exception on the Primary_Cluster, THE Processor SHALL log at ERROR level including the cluster identifier and error message, and return the record as a Batch_Item_Failure
2. WHEN an Aurora_Writer upsert throws an exception on a non-primary cluster, THE Processor SHALL log at WARN level including the cluster identifier and error message, and return the record as a Batch_Item_Failure
3. WHEN an Aurora_Writer upsert fails on any cluster, THE Processor SHALL not execute any Side_Effect for that record
4. IF the Primary_Cluster upsert succeeds but a non-primary cluster upsert fails, THEN THE Processor SHALL preserve the primary write and return the record as a Batch_Item_Failure so that the retry achieves consistency on the remaining clusters

### Requirement 4: Side-effects re-derived from signal state

**User Story:** As the system, I want side-effects to be re-derived from the signal's `matchedRules` on retry, so that they fire exactly once after Aurora succeeds.

#### Acceptance Criteria

1. WHEN processing resumes on retry with an existing signal, THE Processor SHALL call `deriveOutcome()` with the signal's persisted `matchedRules` to reconstruct the Outcome
2. WHEN all Aurora_Writer upserts for the current signal succeed, THE Processor SHALL execute the side-effects (forward, notify, auto-reply, pong, auto-draft, calendar) indicated by the re-derived Outcome
3. IF any Aurora_Writer upsert fails during retry processing, THEN THE Processor SHALL skip all side-effect execution and leave the signal eligible for a subsequent retry

### Requirement 5: S3 retention errors are fire-and-forget

**User Story:** As the system, I want S3 retention failures to never cause a retry, so that transient S3 errors do not block signal processing.

#### Acceptance Criteria

1. IF an S3_Retention operation fails, THEN THE Processor SHALL log the error at warn level with the operation context and continue processing without returning a Batch_Item_Failure
2. THE Processor SHALL always attempt S3_Retention on every delivery (the operation is idempotent)
3. THE Processor SHALL isolate S3_Retention errors so that an S3_Retention failure does not propagate as a signal processing failure and does not alter the processing outcome of the message
