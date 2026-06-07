# Requirements Document

## Introduction

This document defines the requirements for an Aurora vector embedding strategy that supports model migration, disaster recovery, and zero-downtime re-indexing. The architecture has two components:

1. **Continuous embedding writes** — When a Signal is processed, embeddings are generated for every active cluster using each cluster's designated model, written to both the cluster and the DynamoDB Signal record.
2. **Re-index as a pure copy** — A re-index reads embeddings from DynamoDB and writes them to a new (or existing) Aurora cluster. No regeneration from S3 raw emails is required for a re-index, because the embeddings are already cached in DynamoDB.

The strategy supports running multiple Aurora clusters concurrently for blue/green model migration. Each cluster is paired with a specific Amazon Bedrock embedding model in source code (the Cluster_Registry). When the cluster set changes — adding a new model variant, retiring an old one — DynamoDB is backfilled to ensure every Signal has an embedding for every active cluster.

S3 raw email retention is configurable per account via object tags + tag-based S3 lifecycle rules, with discrete tiers driven by the account's billing plan.

## Glossary

- **Cluster_Registry**: A hardcoded array in source code mapping each active Aurora cluster to its Bedrock embedding model (e.g., `[{ cluster: 'aurora-prod', model: 'titan-embed-text-v2:0', dimensions: 1024 }]`). The single source of truth for which clusters are active and which model each one uses.
- **Embedding_Cache**: The map of model-keyed embeddings stored on each DynamoDB Signal record (e.g., `embeddings: { 'titan-embed-text-v2:0': [0.1, ...], 'titan-embed-text-v3:0': [0.2, ...] }`).
- **Aurora_Cluster**: A specific Aurora Serverless v2 PostgreSQL cluster hosting an `arc_embeddings` table with pgvector and HNSW index, paired with one model in the Cluster_Registry.
- **Reindex_Dispatcher**: The component that initiates a re-index by triggering a parallel DynamoDB scan and emitting one SQS message per scan segment.
- **Reindex_Worker**: The SQS consumer that processes one DynamoDB scan segment, reading Signals with cached embeddings and writing them to a target Aurora cluster idempotently.
- **Signal_Store**: The DynamoDB `signals` table storing Signal records, including the Embedding_Cache.
- **Email_Bucket**: The S3 bucket storing raw MIME emails under the `emails/` prefix, with per-account retention enforced via object tags and tag-based lifecycle rules.
- **Embedding_Generator**: The component that constructs sanitized Embed_Text from a Signal and calls Bedrock for a given model.
- **Embed_Text**: The sanitized text input to the Embedding_Generator: account ID, sender/recipient/headers metadata, subject, plus the first 3000 characters and last 1000 characters of the sanitized text body (no overlap), with CSS, HTML tags, image references, and image alt text removed; links are reduced to domain + first path segment.
- **Retention_Tier**: One of 6 billing plan tiers (Free, Beta, Paid, Lifetime, Premium, Internal) that determines S3 retention behaviour. Each tier maps to a `retentionDuration` (ISO 8601: `P1Y`, `P5Y`, `P1000Y`) stored on the DDB Signal record, an optional S3 object tag for lifecycle rule matching, and whether the object is copied to `saved/`. The `userDisplayedRetention` (what the user sees) is derived dynamically from `retentionDuration` at API response time and is never stored.
- **Backfill_Job**: A one-time job triggered when a new cluster + model entry is added to the Cluster_Registry, which scans the Signal_Store and generates the missing model's embedding for each Signal.

## Requirements

### Requirement 1: Cluster Registry — Source-Coded Model Mapping

**User Story:** As an engineer, I want the active Aurora clusters and their models defined in source code, so that cluster ↔ model pairing is type-checked, code-reviewed, and never drifts from runtime configuration.

#### Acceptance Criteria

1. THE Cluster_Registry SHALL be defined as a constant array in source code, with each entry containing: cluster identifier, Aurora resource ARN, Bedrock model ID, embedding dimensions, and an `active` flag.
2. THE Cluster_Registry SHALL be the single source of truth — no environment variable, parameter store entry, or DynamoDB record SHALL override the source-coded values.
3. WHEN a query is executed against a specific Aurora_Cluster, THE Embedding_Generator SHALL use the model from that cluster's Cluster_Registry entry (never the model of a different cluster).
4. THE Cluster_Registry SHALL support at least 4 concurrent active clusters to enable blue/green migration without removing the previous active cluster.
5. WHEN a cluster's `active` flag is set to false, THE system SHALL stop writing new embeddings to that cluster but SHALL retain the cluster and its DynamoDB embedding cache entries until explicit removal.

### Requirement 2: Sanitize and Extract Embed Text at Signal Creation

**User Story:** As a system, I want a deterministic, low-noise embed text per Signal, so that semantic search produces meaningful matches and embeddings are stable across regenerations.

#### Acceptance Criteria

1. WHEN a Signal is processed, THE Embedding_Generator SHALL parse the raw MIME content to extract: from address, reply-to address, return-path header, subject, and text body.
2. THE Embedding_Generator SHALL sanitize the text body by removing CSS blocks, HTML tags, image references (`<img>`, image URLs), and image alt text.
3. THE Embedding_Generator SHALL reduce each link in the body to its domain and first path segment only (e.g., `https://amazon.com/products/foo/bar?ref=x` → `amazon.com/products`).
4. THE Embedding_Generator SHALL construct the body content for embedding by concatenating the first 3000 characters of the sanitized body and the last 1000 characters of the sanitized body, with no overlap if the body exceeds 4000 characters.
5. IF the sanitized body is 4000 characters or fewer, THEN THE Embedding_Generator SHALL use the entire sanitized body without splitting.
6. THE Embedding_Generator SHALL construct the final Embed_Text by combining account ID, from address, reply-to (if present), return-path (if present), recipient address, subject, and the body content described above, joined by newlines.
7. THE sanitization rules SHALL be deterministic — the same raw email SHALL always produce the same Embed_Text.

### Requirement 3: Generate Embeddings for Every Active Cluster

**User Story:** As a system, I want every Signal to have an embedding for every active cluster, so that any cluster can serve queries and re-index targets always have complete data.

#### Acceptance Criteria

1. WHEN a Signal is processed, THE Embedding_Generator SHALL generate one embedding per active entry in the Cluster_Registry, using each entry's specified Bedrock model.
2. THE Embedding_Generator SHALL call Bedrock with the model ID and dimensions from the Cluster_Registry entry, with normalization enabled.
3. WHEN all per-model embeddings are generated, THE system SHALL write them in parallel to: (a) the corresponding Aurora_Cluster's `arc_embeddings` table, and (b) the Embedding_Cache field on the DynamoDB Signal record, keyed by Bedrock model ID.
4. THE write to Aurora and the write to DynamoDB SHALL both be idempotent — repeated writes for the same Signal and same model SHALL produce the same final state.
5. IF the Bedrock call for a specific model fails after retries, THEN THE system SHALL still persist the Signal to DynamoDB without that model's embedding entry, and SHALL emit a metric `embedding_generation_failed` tagged with the model ID for backfill detection.
6. IF the Aurora write fails for a specific cluster after retries, THEN THE Embedding_Cache entry in DynamoDB SHALL still be persisted so that a subsequent re-index can recover the missing cluster row.

### Requirement 4: Re-Index via Parallel DynamoDB Scan + SQS Dispatch

**User Story:** As an operator, I want to re-index a target Aurora cluster from cached DynamoDB embeddings, so that I can populate a new cluster without re-running Bedrock or fetching from S3.

#### Acceptance Criteria

1. WHEN a re-index is initiated, THE Reindex_Dispatcher SHALL accept a target cluster identifier from the Cluster_Registry as input.
2. THE Reindex_Dispatcher SHALL emit one SQS message per DynamoDB parallel-scan segment, with a configurable segment count (default: 32 segments).
3. EACH SQS message SHALL contain: the segment number, the total segment count, the target cluster identifier, and the source-coded model ID for that cluster.
4. WHEN a Reindex_Worker receives an SQS message, THE Reindex_Worker SHALL execute a DynamoDB parallel scan for its assigned segment, retrieve each Signal's Embedding_Cache, extract the entry for the target cluster's model, and upsert it into the target Aurora_Cluster's `arc_embeddings` table.
5. THE Reindex_Worker SHALL be fully idempotent — re-processing the same segment SHALL produce the same final state in Aurora.
6. IF a Reindex_Worker fails partway through a segment, THEN SQS visibility timeout and redelivery SHALL retry the segment, and the worker SHALL resume safely (idempotent upserts ensure no duplicate or corrupt rows).
7. IF a Signal in the scanned segment has no Embedding_Cache entry for the target model, THEN THE Reindex_Worker SHALL log the Signal ID for backfill processing and continue to the next Signal (it SHALL NOT call Bedrock during re-index).

### Requirement 5: Combined Reindex (Cache Hit + Regeneration)

**User Story:** As an operator running a re-index against a target Aurora cluster, I want the worker to handle both signals that already have a cached embedding and signals that need regeneration in one pass, so that I do not need to run separate jobs for new clusters versus existing ones.

#### Acceptance Criteria

1. WHEN a Reindex_Worker processes a Signal whose `embeddings[targetModelId]` is present, THE Worker SHALL upsert the cached vector into the target Aurora_Cluster and increment the `copiedCount` counter.
2. WHEN a Reindex_Worker processes a Signal whose `embeddings[targetModelId]` is absent and whose `s3Key` returns a valid object from the Email_Bucket, THE Worker SHALL fetch the raw MIME, build the Embed_Text via the same sanitization rules as live signal processing, call Bedrock for the target model, write the resulting vector to the Signal's `embeddings[targetModelId]` cache via DynamoDB UpdateItem, upsert the vector into the target Aurora_Cluster, and increment the `regeneratedCount` counter.
3. WHEN a Reindex_Worker processes a Signal whose `embeddings[targetModelId]` is absent and whose `s3Key` returns `NoSuchKey`, THE Worker SHALL log the Signal ID, increment the `unrecoverableCount` counter, and continue.
4. THE Reindex_Worker SHALL NOT call Bedrock for any Signal whose `embeddings[targetModelId]` is already populated.
5. THE final job report SHALL include `copiedCount`, `regeneratedCount`, and `unrecoverableCount`, and the sum SHALL equal `signalsScanned`.

### Requirement 6: Idempotent Aurora Upserts with Row-Level Security

**User Story:** As a system, I want Aurora upserts to be idempotent and tenant-isolated, so that retried writes do not corrupt data and one tenant cannot read another's embeddings.

#### Acceptance Criteria

1. THE upsert into `arc_embeddings` SHALL use a conflict target of (`arc_id`, `account_id`, `recipient_address`), replacing the embedding vector and `updated_at` on conflict.
2. THE Reindex_Worker and live writers SHALL set `app.current_account_id` via `SET LOCAL` within the same transaction as the upsert, before executing the upsert SQL.
3. WHEN the same (`arc_id`, `account_id`, `recipient_address`) tuple is upserted multiple times with the same vector, THE final state SHALL be identical to a single upsert.
4. IF the Aurora Data API call fails with a transient error, THEN THE caller SHALL retry up to 3 times with exponential backoff (1s, 2s, 4s) before logging the failure with the Signal ID and arc ID.

### Requirement 7: Cluster Cutover After Re-Index

**User Story:** As an operator, after a re-index of a new cluster completes, I want to atomically cut traffic over to the new cluster, so that read queries return data from the freshly populated cluster.

#### Acceptance Criteria

1. THE active query target SHALL be derived from the Cluster_Registry — flipping a single source-coded entry from a stale cluster to the freshly indexed one is the cutover mechanism.
2. WHEN a re-index of a target cluster completes, THE operator SHALL update the Cluster_Registry in source code, deploy, and verify that read queries route to the new cluster.
3. THE previous cluster SHALL remain in the Cluster_Registry as `active = true` for at least one continuous-write cycle after cutover, so that rollback by reverting the source code is always possible without backfilling missed signals.
4. WHEN the operator decides to retire the previous cluster, THE operator SHALL set its `active` flag to false in the Cluster_Registry; new Signals SHALL stop being written to it on the next deploy.

### Requirement 8: S3 Retention via Plan-Driven Prefix Routing

**User Story:** As a product owner, I want each account's S3 raw email retention to match its billing plan automatically, so that retention is a hidden aspect of the plan, not a user-facing toggle.

#### Acceptance Criteria

1. SES `s3_action` SHALL be configured to write all inbound emails to the `inbox/` prefix in the Email_Bucket.
2. THE Email_Bucket SHALL have exactly 2 lifecycle rules: (a) `inbox/` prefix with tag `retention-tier=P1Y`, expiring after 365 days — applied only to free-tier accounts; (b) `inbox/` prefix with no tag filter, expiring after 1825 days (5 years) — the default for all other tiers. The `saved/` prefix SHALL have no lifecycle rule, providing indefinite retention.
3. WHEN the processing Lambda processes an inbox object owned by a free-tier account, THE Lambda SHALL call `PutObjectTagging` with `retention-tier=P1Y`. For paid/beta/lifetime accounts, the Lambda SHALL NOT tag the object (the default 5-year lifecycle rule applies via no-tag). For premium/internal accounts, the Lambda SHALL copy the object to `saved/{key}`.
4. WHEN the processing Lambda processes an inbox object owned by a premium or internal account, THE Lambda SHALL copy the object from `inbox/{key}` to `saved/{key}` and update the Signal record's `s3Key` field to reference the new path.
5. WHEN the processing Lambda writes the Signal record to DynamoDB, THE Lambda SHALL persist a `retentionDuration` field as an ISO 8601 duration code (`'P1Y'`, `'P5Y'`, `'P1000Y'`), representing the actual S3 retention for that object. This is the single source of truth for retention logic.
6. THE system SHALL derive `userDisplayedRetention` dynamically at API response time from the stored `retentionDuration` (P1Y → P6M, P5Y → P5Y, P1000Y → P1000Y). `userDisplayedRetention` SHALL NOT be stored in DynamoDB.
7. THE API layer SHALL filter out Signals and Arcs where `createdAt + userDisplayedRetention` (derived from `retentionDuration`) is in the past. These records are hidden from the user but may still exist in DynamoDB for internal use (reindex, regeneration).
8. THE system SHALL set a DynamoDB TTL on Arc records equal to `createdAt + retentionDuration`. DynamoDB auto-deletes the Arc after the S3 object is gone.
9. WHEN an account's plan changes, THE system SHALL NOT retroactively re-tag existing inbox objects, move objects between prefixes, or update `retentionDuration` on existing Signal records. Plan changes SHALL apply only to new objects written after the change.
10. THE plan-to-retention mapping SHALL be defined in source code with 6 tiers: Free (P1Y tag, P1Y retention), Beta (no tag, P5Y), Paid (no tag, P5Y), Lifetime (no tag, P5Y), Premium (copy to saved/, P1000Y), Internal (copy to saved/, P1000Y).
11. WHEN reading a Signal's S3 object, THE system SHALL use the `s3Key` field from the DynamoDB record as the source of truth.
12. THERE SHALL NOT be a user-facing API to change retention on individual signals or accounts. Retention is account-level only and driven entirely by the billing plan.
13. THE 2 lifecycle rules and the `inbox/` prefix configuration on SES SHALL be defined in OpenTofu.

### Requirement 9: Re-Index Validation and Reporting

**User Story:** As an operator, I want a summary report after a re-index completes, so that I can verify the target cluster matches the source data before cutover.

#### Acceptance Criteria

1. WHEN all Reindex_Workers complete, THE Reindex_Dispatcher SHALL query the target Aurora_Cluster for the count of rows in `arc_embeddings` and compare it to the count of Signals with the target model's Embedding_Cache entry in DynamoDB.
2. THE Reindex_Dispatcher SHALL report: total Signals scanned, embeddings written to Aurora, Signals skipped (missing target model embedding), and total processing time.
3. THE Reindex_Dispatcher SHALL sample 10 random embeddings from the target cluster and verify they produce valid cosine similarity results (non-NaN, within [-1, 1] range) using a test query.
4. IF the row count discrepancy between the target Aurora_Cluster and the DynamoDB embedding cache count exceeds 1%, THEN THE Reindex_Dispatcher SHALL flag the re-index as failed and recommend re-running before cutover.

### Requirement 10: Re-Index Resumability and Failure Isolation

**User Story:** As an operator, I want a re-index to recover gracefully from any partial failure, so that I never have to start over from scratch.

#### Acceptance Criteria

1. SQS message visibility timeout for Reindex_Worker messages SHALL be configurable (default: 15 minutes) and longer than the expected segment processing time.
2. IF a Reindex_Worker fails to process a segment, THEN SQS SHALL automatically redeliver the message after the visibility timeout for retry. The worker SHALL be retried indefinitely — there is no `maxReceiveCount` cap and no dead-letter queue.
3. THE Reindex_Worker SHALL track per-segment progress via Aurora upserts themselves — there is no separate checkpoint store; the idempotent upserts ARE the checkpoint.
4. Persistent failures (broken segment, malformed records, sustained Aurora outage) SHALL surface via SQS metrics (`ApproximateAgeOfOldestMessage`, message count) and CloudWatch alarms; the operator investigates via logs and metrics rather than via a DLQ.
5. THE re-index SHALL succeed even if individual Signal records are malformed or unreadable — failures SHALL be logged per-Signal, not per-segment.

### Requirement 11: API-Driven Job Dispatch and Reporting

**User Story:** As an operator, I want to start, monitor, and validate reindex jobs via HTTP API endpoints, so that I do not depend on EventBridge or Step Functions for orchestration.

#### Acceptance Criteria

1. THE system SHALL expose `POST /reindex` accepting `{ targetClusterId, segmentCount? }` as JSON. WHEN called, the dispatcher Lambda SHALL validate the cluster ID against the Cluster_Registry, fan out segment messages to the reindex SQS queue, and return `{ jobId, segmentCount, startedAt }`.
2. THE system SHALL expose `GET /reindex/{jobId}` that returns the current state of the job: scanned, copied (cache hit), regenerated (cache miss + S3 retrieved + Bedrock called), unrecoverable (cache miss + S3 expired), validation result (cosine similarity sample + count discrepancy), and total elapsed time.
3. THE reindex worker SHALL handle both pure-copy and regeneration modes per-signal: cache hit → copy to Aurora; cache miss + S3 retrievable → fetch, regenerate via Bedrock, store back to cache, copy to Aurora; cache miss + S3 expired → record as unrecoverable. There SHALL NOT be a separate backfill API or queue.
4. THE dispatcher SHALL NOT be triggered via EventBridge — API Gateway is the only entry point for operator-initiated jobs.
5. Per-job counters SHALL be stored in the existing `processing` DynamoDB table, keyed by `jobId`. Workers SHALL increment counters atomically via `UpdateExpression` with `ADD`.
