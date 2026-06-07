# Implementation Plan: Aurora Reindex Strategy

## Overview

This plan implements the Aurora multi-cluster embedding strategy in 7 sequenced steps drawn from the design's _Migration sequence_. Each step ships independently and is integrated into the previous step before the next begins:

1. Foundation modules — `src/embedding/` and `src/database/multi-cluster-aurora-writer.ts` (no callers).
2. Aurora schema migration — widen `arc_embeddings` primary key to `(arc_id, account_id, recipient_address)`.
3. Processor refactor — `processor.ts` consumes `EmbeddingGenerator` + `MultiClusterAuroraWriter` (single-entry registry → behavior unchanged).
4. Embedding cache writes — extend the DynamoDB `Signal` record with the model-keyed `embeddings` map.
5. S3 retention — `storage.tf` lifecycle rules, plan-driven tag-on-PUT, `userDisplayedRetention` on signals.
6. Reindex pipeline (pure-copy mode) — `ReindexDispatcher` + `ReindexWorker`, `api.tf` routes for `POST /reindex` and `GET /reindex/{jobId}`, `compute.tf` SQS queues and event source mappings.
7. Reindex regenerate-from-S3 mode — extend the worker to handle cache-miss signals via S3 + Bedrock, collapsing the historical "backfill" job into the same reindex worker.

Reindex and backfill are a single job: the worker dispatches per-signal between pure-copy (cache hit) and regenerate-from-S3 (cache miss). There is no separate retention API — retention is plan-driven and resolved at signal creation. The only operator-facing API surface is `POST /reindex` and `GET /reindex/{jobId}`.

Each implementation task references the property test(s) it must satisfy. Tests are written alongside implementation, not at the end. All 22 correctness properties from the design are covered, each as a `fast-check` property test.

## Tasks

- [x] 1. Step 1 — Foundation modules with no callers
  - [x] 1.1 Add `fast-check` and `aws-sdk-client-mock` as dev dependencies
    - Update `package.json`; pin both to current major versions
    - Add a shared `fc.assert(..., { numRuns: 100 })` helper in `src/testing/property-runner.ts`
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Implement `src/embedding/cluster-registry.ts`
    - Define `ClusterRegistryEntry` interface and the `CLUSTER_REGISTRY` `readonly` constant (single seeded entry: existing prod Aurora + `amazon.titan-embed-text-v2:0`)
    - Implement `getActiveClusters`, `getClusterById`, `getReadCluster`
    - Add module-load assertion that active entries ≤ 4
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

  - [x]* 1.3 Smoke test cluster registry shape
    - Assert registry is `readonly`, no env var paths, ≤ 4 active entries
    - _Requirements: 1.1, 1.2, 1.4_

  - [x] 1.4 Implement `src/embedding/embed-text.ts`
    - Pure `buildEmbedText` function: sanitize body (strip CSS, HTML tags, `<img>`, alt text), reduce links to `domain/firstPathSegment`, apply 3000+1000 split or pass-through ≤ 4000
    - Construct final text by joining header lines + body with `\n`
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 1.5 Property test for embed text determinism, bounding, and field coverage
    - **Property 1: Embed text is deterministic, bounded, and contains all input fields**
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.7**

  - [x] 1.6 Property test for HTML/CSS/image sanitization
    - **Property 2: Sanitization removes all structural HTML/CSS/image artifacts**
    - **Validates: Requirements 2.2**

  - [x] 1.7 Property test for link reduction to domain + first path segment
    - **Property 3: Links reduce to domain plus first path segment**
    - **Validates: Requirements 2.3**

  - [x] 1.8 Wire `MimeParser` into `EmbedTextInput` extraction
    - Reuse existing MIME parser; ensure from / reply-to / return-path / subject / text body extraction matches the embed-text contract
    - _Requirements: 2.1_

  - [x] 1.9 Property test for MIME parse round-trip of header fields
    - **Property 4: MIME parse round-trips header fields**
    - **Validates: Requirements 2.1**

  - [x] 1.10 Implement `src/embedding/embedding-generator.ts`
    - `BedrockEmbeddingGenerator` class with `generateForActiveClusters` (parallel Bedrock calls per active registry entry) and `generateForModel` (resolves dimensions from registry by `modelId`, sets `normalize=true`)
    - Per-model failures return `null`, do not throw; emit `embedding_generation_failed{modelId}` metric
    - _Requirements: 1.3, 3.1, 3.2, 3.5_

  - [x]* 1.11 Property test that active cluster set drives Bedrock fanout
    - **Property 5: Active cluster set drives embedding generation**
    - **Validates: Requirements 1.3, 1.5, 3.1, 3.2, 7.4**

  - [x]* 1.12 Property test for per-model failure isolation in the generator
    - **Property 7: Bedrock failure for one model preserves all other writes**
    - **Validates: Requirements 3.5**

  - [x] 1.13 Implement `src/database/multi-cluster-aurora-writer.ts`
    - Per-cluster `RDSDataClient` cache keyed by `clusterId` (resolved against `CLUSTER_REGISTRY`)
    - `upsertEmbedding` runs `BeginTransaction` → `SET LOCAL app.current_account_id = :accountId` → `INSERT ... ON CONFLICT (arc_id, account_id, recipient_address) DO UPDATE SET embedding=..., updated_at=NOW()` → `CommitTransaction`, all on the same `transactionId`
    - `findMatch` runs the cosine-similarity nearest-neighbor query under the same RLS-scoped transaction
    - Custom retry: 3 attempts, 1s/2s/4s exponential backoff for transient RDS Data API errors
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 1.14 Property test for upsert idempotence (single tuple, repeated writes)
    - **Property 9 (writer-scope subset): All embedding upserts are idempotent**
    - **Validates: Requirements 3.4, 6.1, 6.3**

  - [x] 1.15 Property test that upserts run inside an RLS-scoped transaction
    - **Property 15: Aurora upserts run inside an RLS-scoped transaction**
    - **Validates: Requirements 6.2**

  - [x] 1.16 Property test for retry-with-backoff schedule
    - **Property 16: Aurora retries with exponential backoff up to 3 attempts**
    - **Validates: Requirements 6.4**

- [x] 2. Step 2 — Aurora schema migration (widen primary key)
  - [x] 2.1 Author one-shot SQL migration script `deploy/migrations/2025-XX-widen-arc-embeddings-pk.sql`
    - `ALTER TABLE arc_embeddings DROP CONSTRAINT arc_embeddings_pkey`
    - `ALTER TABLE arc_embeddings ADD PRIMARY KEY (arc_id, account_id, recipient_address)`
    - Confirm HNSW index and RLS policy survive the alter (rebuild if not)
    - Idempotent — script no-ops if the composite PK already exists
    - _Requirements: 6.1_

  - [x] 2.2 Add migration runner entry-point `src/database/run-migration.ts`
    - Reads the migration file, executes via RDS Data API against the existing single cluster, verifies the new PK shape via `information_schema`
    - _Requirements: 6.1_

  - [x] 2.3 Unit test for migration idempotence
    - Apply migration twice against a fixture; assert second apply is a no-op and PK shape matches `(arc_id, account_id, recipient_address)`
    - _Requirements: 6.1_

  - [x] 2.4 Update `deploy/search.tf` cluster bootstrap to use the composite PK in the table-create SQL
    - Bring the IaC table definition in line with the migrated state so freshly-provisioned clusters are born correct
    - _Requirements: 6.1_

- [x] 3. Step 3 — Refactor processor onto the new modules
  - [x] 3.1 Extend `Signal` type in `src/types/index.ts`
    - Add optional `embeddings?: Record<string, number[]>` and `userDisplayedRetention?: '6 months' | '5 years' | 'forever'` fields
    - _Requirements: 3.3, 8.5_

  - [x] 3.2 Refactor `src/processor/processor.ts` to depend on `EmbeddingGenerator` + `MultiClusterAuroraWriter`
    - Replace inline Bedrock invocation and Aurora upsert with calls to the new components
    - Behavior with the single-entry registry must match the pre-refactor processor exactly
    - _Requirements: 1.3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 7.4_

  - [x] 3.3 Drop `embed()` from `src/classifier/classifier.ts`
    - Remove the embedding code path now owned by `EmbeddingGenerator`; `SignalClassifier` retains classification only
    - _Requirements: 3.1_

  - [x]* 3.4 Property test for multi-cluster fanout writes
    - **Property 6: Multi-cluster fanout writes vectors to every active target**
    - **Validates: Requirements 3.3**

  - [x] 3.5 Property test that Aurora cluster failure preserves the DynamoDB cache entry
    - **Property 8: Aurora cluster failure preserves the DynamoDB cache entry**
    - **Validates: Requirements 3.6**

- [x] 4. Checkpoint — single-cluster behavior intact after refactor
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Step 4 — Embedding cache writes on DynamoDB Signal records
  - [x] 5.1 Add `addEmbeddingToCache` to `src/database/arc-database.ts`
    - `UpdateExpression: 'SET embeddings.#mid = :v'` keyed by signal pk/sk; idempotent (overwrites same value)
    - _Requirements: 3.3, 3.4, 3.6_

  - [x] 5.2 Wire processor to persist `embeddings` map alongside the live Signal save
    - `saveSignal` writes the full `embeddings` map composed from successful `EmbeddingResult`s
    - Aurora write failure for a cluster does NOT remove that model's vector from the cache
    - _Requirements: 3.3, 3.4, 3.6_

  - [x] 5.3 Property test for cross-layer idempotence (live writes + cache + Aurora)
    - **Property 9 (full scope): All embedding upserts and job operations are idempotent**
    - **Validates: Requirements 3.4, 4.5, 4.6, 5.6, 6.1, 6.3**

- [x] 6. Step 5 — S3 retention infrastructure and signal-time application
  - [x] 6.1 Implement `src/embedding/retention-tier.ts`
    - `resolveRetentionForPlan(plan)` returning `{ s3Tag, s3Prefix, userDisplayedRetention }` per the design table (free → `retention-tier=P6M`, paid → no tag, paid+indefinite → `saved/`)
    - `planHasIndefiniteRetention(plan)` helper
    - `tierIndex(tier)` and `isWithinPlanLimit(requestedTier, plan)` for the property-20 invariant
    - _Requirements: 8.7, 8.9_

  - [x] 6.2 Implement `src/embedding/s3-retention-service.ts`
    - `applyPlanRetention(s3Key, decision)`: free → `PutObjectTagging` on `inbox/{key}`; paid default → no-op; paid+indefinite → `CopyObject inbox/{key} → saved/{key}` and return new `s3Key`
    - _Requirements: 8.1, 8.3, 8.4, 8.6, 8.7, 8.8_

  - [x] 6.3 Wire `S3RetentionService` into the processor signal-creation path
    - After signal save, invoke retention application; persist resulting `s3Key` and `userDisplayedRetention` on the Signal record; never mutate retention on existing signals
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [x]* 6.4 Property test that retention tag and DynamoDB record always agree
    - **Property 18: Retention tier on S3 tag and DynamoDB record always agree**
    - **Validates: Requirements 8.4, 8.5**

  - [x]* 6.5 Property test that plan changes never retroactively retag
    - **Property 19: Plan changes never retroactively retag**
    - **Validates: Requirements 8.7**

  - [x]* 6.6 Property test for plan-limit gate on tier requests
    - **Property 20: Tier requests above plan max are rejected**
    - **Validates: Requirements 8.9**

  - [x] 6.7 Update `deploy/storage.tf` with the two lifecycle rules
    - Rule 1: `inbox/` + tag `retention-tier=P6M` → expire after 180 days
    - Rule 2: `inbox/` (no tag filter) → expire after 1825 days
    - `saved/` has no rule (indefinite retention)
    - SES receipt rule writes to `inbox/` prefix
    - _Requirements: 8.1, 8.2, 8.10_

  - [x]* 6.8 Infrastructure test `deploy/tests/lifecycle_rules.tftest.hcl`
    - Assert exactly 2 lifecycle rules with the specified prefixes, tag filters, and expirations; no rule covers `saved/`
    - _Requirements: 8.2, 8.10_

- [x] 7. Step 6 — Reindex pipeline (pure-copy mode) and operator API
  - [x] 7.1 Update `deploy/search.tf` to provision Aurora resources via `for_each` over `CLUSTER_REGISTRY`
    - Aurora cluster, secret, security group, parameter group all keyed by `clusterId`
    - Per-cluster bootstrap SQL applies the composite-PK schema and HNSW index
    - _Requirements: 1.1, 1.4_

  - [x] 7.2 Add `deploy/compute.tf` SQS queue for reindex (no DLQ)
    - Queue `reindex-queue` (visibility 900s, message retention 4d)
    - No `redrive_policy` and no DLQ resource — failed messages return to the queue indefinitely; idempotent worker handles every retry safely
    - Lambda event source mapping to the existing handler Lambda
    - _Requirements: 4.2, 10.1, 10.2_

  - [x]* 7.3 Infrastructure test `deploy/tests/sqs_reindex.tftest.hcl`
    - Assert reindex queue exists, visibility ≥ 900s, `redrive_policy` is null, no `aws_sqs_queue` resource has `_dlq` in its name; assert event source mapping wired to handler
    - _Requirements: 4.2, 10.1, 10.4_

  - [x] 7.4 Add `deploy/api.tf` API Gateway routes
    - `POST /reindex` and `GET /reindex/{jobId}` routed to the existing handler Lambda
    - IAM policy permits `sqs:SendMessage` on `reindex-queue`
    - No `/backfill` route, no retention routes
    - _Requirements: 11.1, 11.2, 11.4_

  - [x] 7.5 Implement `src/jobs/reindex/reindex-dispatcher.ts`
    - `dispatch(targetClusterId, segmentCount=32)`: validate cluster against `CLUSTER_REGISTRY`, resolve `modelId`, generate `jobId`, emit N SQS messages with `{ jobId, segment, totalSegments, targetClusterId, modelId }`, write initial counters row to the `processing` DynamoDB table, return `ReindexJob`
    - `getReport(jobId)`: read counters from `processing` table, query target Aurora for row count + 10 random vector samples, compare to DynamoDB embedding-cache count, compute validation result
    - _Requirements: 4.1, 4.2, 4.3, 9.1, 9.2, 9.3, 9.4, 11.1, 11.2, 11.5_

  - [x]* 7.6 Property test for dispatcher segment fan-out
    - **Property 10: Reindex dispatcher emits exactly N well-formed segment messages**
    - **Validates: Requirements 4.2, 4.3**

  - [x]* 7.7 Property test for job report scan accounting
    - **Property 14: Job reports preserve scan accounting**
    - **Validates: Requirements 5.5, 9.1, 9.2**

  - [x]* 7.8 Property test for validation discrepancy threshold
    - **Property 17: Validation flags discrepancies above 1%**
    - **Validates: Requirements 9.3, 9.4**

  - [x]* 7.9 Property test that persistent failures surface via metrics, not DLQ
    - **Property 21: Persistent failures surface via SQS metrics, not DLQ**
    - **Validates: Requirements 10.4**

  - [x] 7.10 Implement `src/jobs/reindex/reindex-worker.ts` — pure-copy mode
    - SQS consumer; for the assigned segment, parallel-scan DynamoDB; per signal:
      - if `embeddings[modelId]` present → upsert to target Aurora via `MultiClusterAuroraWriter`, `ADD copiedCount 1` on the `processing` row
      - if absent → log signal id, fall through (regeneration mode added in Step 7)
      - if signal record is malformed → log per-signal and continue (do not retry the whole segment)
    - SQS visibility timeout drives retries; idempotent upserts ARE the checkpoint
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 10.3, 10.5, 11.5_

  - [x] 7.11 Property test that the worker uses cache exclusively in pure-copy mode
    - **Property 11: Reindex worker uses cache exclusively and never calls Bedrock**
    - **Validates: Requirements 4.4, 4.7**

  - [x]* 7.12 Property test for per-signal failure isolation within a segment
    - **Property 22: Worker isolates per-signal failures within a segment**
    - **Validates: Requirements 10.5**

  - [x] 7.13 Implement `src/api/job-dispatch-handler.ts`
    - Routes `POST /reindex` → `dispatcher.dispatch`, `GET /reindex/{jobId}` → `dispatcher.getReport`
    - Validates request body (`targetClusterId` required, `segmentCount` optional 1–256), maps errors to HTTP status codes
    - _Requirements: 11.1, 11.2, 11.4_

  - [x] 7.14 Wire SQS reindex source and API Gateway events in `src/handler.ts`
    - SQS `eventSourceARN` containing `-reindex` → `reindexWorker.process`
    - API Gateway HTTP events with `httpMethod`/`path` matching `POST /reindex` or `GET /reindex/{jobId}` → `jobDispatchHandler.handle`
    - No EventBridge entry point for reindex
    - _Requirements: 11.1, 11.2, 11.4_

- [x] 8. Checkpoint — pure-copy reindex against the existing single cluster (smoke run)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Step 7 — Reindex regenerate-from-S3 mode (collapses backfill into reindex)
  - [x] 9.1 Extend `src/jobs/reindex/reindex-worker.ts` with regenerate-from-S3 fallback
    - For signals where `embeddings[modelId]` is absent:
      - `GetObject {s3Key}` from the email bucket (try `inbox/` and `saved/` prefixes per the Signal record's `s3Key`)
      - On success → parse MIME, `buildEmbedText`, call Bedrock for `modelId`, `addEmbeddingToCache(... modelId, vector)`, upsert to target Aurora, `ADD regeneratedCount 1`
      - On `NoSuchKey` → `ADD unrecoverableCount 1`, log signal id, continue
    - Skip Bedrock entirely when the cache entry already exists (re-affirm the cache-hit guard)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 9.2 Property test for regenerate-mode targeting (cache-miss + S3-retrievable signals only)
    - **Property 12: Backfill targets exactly the signals missing the new model**
    - **Validates: Requirements 5.1, 5.3**

  - [x] 9.4 Update dispatcher report shape to expose the three counters
    - `ReindexReport.copiedCount`, `regeneratedCount`, `unrecoverableCount`; preserve `signalsScanned === copiedCount + regeneratedCount + unrecoverableCount` invariant
    - _Requirements: 5.5, 11.2_

  - [x] 9.5 Remove final-snapshot configuration from `deploy/search.tf`
    - Set `skip_final_snapshot = true` on every Aurora cluster (single cluster today, all entries in the `for_each` registry going forward)
    - Remove the `final_snapshot_identifier` argument
    - Reduce `backup_retention_period` to the AWS minimum (1 day) — automated backups are no longer the recovery mechanism; rebuild from the DynamoDB embedding cache + S3 raw emails is
    - Update the `aurora_protection.tftest.hcl` test to assert `skip_final_snapshot == true` (replacing the previous assertion that required snapshots)
    - The `prevent_destroy` lifecycle block on the cluster stays — operationally, accidental deletion is still prevented, but the recovery model has changed
    - _Requirements: 6.1_

- [x] 10. Final checkpoint — full reindex against a freshly provisioned blue/green cluster
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP, but every property test marked optional corresponds to a specific correctness property in the design — skipping them lowers the verification floor.
- The 22 correctness properties are each owned by exactly one task. Properties 9 (idempotence) is split across two tasks because the invariant spans both the writer (1.14) and the full pipeline (5.3).
- Reindex and backfill are intentionally one job. There is no `src/jobs/backfill/` directory and no `POST /backfill` route. Step 7's regeneration code path inside the existing worker is the historical-backfill mechanism.
- There is no retention API. Retention is decided once at signal creation by `resolveRetentionForPlan` and applied via S3 tag or `inbox→saved` copy. Plan changes never retroactively retag — Property 19 enforces this.
- Schema migration (Step 2) ships before the processor refactor (Step 3) so the existing single cluster reaches the composite-PK shape before any new code touches it.
- API Gateway routes (`api.tf`), SQS queues (`compute.tf`), Aurora `for_each` (`search.tf`), and lifecycle rules (`storage.tf`) each ship as discrete tasks tied to their consumer steps, so each infra change is co-deployed with the code that uses it.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.4", "1.8", "2.1", "2.4", "3.1", "6.1", "6.7", "7.2"] },
    { "id": 1, "tasks": ["1.3", "1.5", "1.6", "1.7", "1.9", "1.10", "1.13", "2.2", "5.1", "6.2", "6.8", "7.1", "7.3", "7.4"] },
    { "id": 2, "tasks": ["1.11", "1.12", "1.14", "1.15", "1.16", "2.3", "3.2", "7.5", "7.10"] },
    { "id": 3, "tasks": ["3.3", "3.4", "3.5", "5.2", "6.3", "7.6", "7.7", "7.8", "7.9", "7.11", "7.12", "7.13"] },
    { "id": 4, "tasks": ["5.3", "6.4", "6.5", "6.6", "7.14"] },
    { "id": 5, "tasks": ["9.1"] },
    { "id": 6, "tasks": ["9.2", "9.3", "9.4", "9.5"] }
  ]
}
```
