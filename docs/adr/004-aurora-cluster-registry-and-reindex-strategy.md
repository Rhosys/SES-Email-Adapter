# ADR-004: Aurora Cluster Registry and Reindex Strategy

**Date:** 2026-05-11  
**Status:** Accepted  
**Deciders:** Warren  

## Context

The email-catcher backend uses Aurora Serverless v2 with pgvector for arc threading (see ADR-001). The system needs to support embedding model migrations — switching from one Bedrock model to another — without downtime or data loss. The previous implementation passed `clusterId` through the entire stack (API endpoints, SQS messages, DynamoDB job records, the processor pipeline), creating unnecessary coupling between infrastructure routing details and application logic.

## Decision

### Single active cluster for reads and writes

There is exactly one **primary** cluster at any time. The normal processor flow writes to it. All similarity reads query it. No multi-cluster fan-out during normal operation.

### Cluster registry is the single source of truth

The cluster registry is a hardcoded array in source code (`src/embedding/cluster-registry.ts`). Each entry contains:

```ts
interface ClusterRegistryEntry {
  clusterId: string;       // internal identifier, never leaves this module
  clusterArn: string;      // Aurora cluster ARN
  secretArn: string;       // Secrets Manager ARN for credentials
  databaseName: string;
  modelId: string;         // Bedrock embedding model ID
  primary: boolean;        // exactly one entry is true
}
```

- `clusterId` is an internal identifier used only within the registry module and as input to the reindex flow. It is never stored in DynamoDB, never in SQS messages to the processor, never on signal records.
- Multiple clusters can share the same `modelId` (e.g. during hardware migration).
- Multiple clusters can have different `modelId` values (e.g. during model migration).
- Exactly one cluster is `primary: true` at any time.

### Signal records cache embeddings by modelId

The signal record in DynamoDB stores a `modelId → vector` map:

```ts
signal.embeddings: Record<string, number[]>
// e.g. { "amazon.titan-embed-text-v2:0": [0.1, 0.2, ...] }
```

This is model-specific, not cluster-specific. The same vector can be written to any cluster that uses that model.

### Reindex is internal-only (no HTTP endpoint)

The reindex flow is triggered via CLI or direct SQS — not through an HTTP API. The input is a `clusterId` which identifies the target cluster in the registry. The reindex worker:

1. Resolves `clusterId` → gets the `modelId` for that cluster
2. Scans signals, reads `signal.embeddings[modelId]` if cached
3. Cache hit: writes the vector to the target cluster
4. Cache miss: fetches raw MIME from S3, generates embedding via Bedrock, caches on the signal record, writes to the target cluster

### Migration workflow

1. Add new cluster entry to the registry (non-primary)
2. Deploy (no behaviour change — processor still writes to the primary)
3. Run reindex targeting the new cluster's `clusterId`
4. Verify reindex completed successfully (validation report)
5. Flip `primary: true` to the new cluster in code
6. Deploy (reads and writes now go to the new cluster)
7. Remove old cluster entry from the registry
8. Deploy (cleanup)

## Rationale

### clusterId is an infrastructure detail

Application code (processor, API routes, signal records) should not know or care which Aurora instance serves their requests. They care about the embedding model (which determines vector compatibility) and whether the cluster is the active one. The registry encapsulates the routing.

### One active cluster simplifies everything

Writing to multiple clusters simultaneously creates consistency problems (partial failures, divergent state), complicates the processor pipeline, and has no user-facing benefit. The reindex flow exists precisely to populate a new cluster before cutover — there is no need for real-time dual-writes.

### modelId on signals enables zero-recompute migrations

When migrating between clusters that use the same model, the reindex is a pure copy — read the cached vector, write it to the new cluster. No Bedrock calls, no S3 fetches. This makes same-model migrations fast and cheap.

When migrating to a new model, the reindex regenerates embeddings from S3 source material. The new vectors are cached on the signal record under the new `modelId` key, so subsequent reindexes to other clusters with the same model are again pure copies.

### No HTTP endpoint reduces attack surface

The reindex operation is an administrative action that scans the entire signals table. Exposing it as an HTTP endpoint (even authenticated) creates risk of accidental or malicious triggering. CLI or direct SQS invocation requires infrastructure access.

## Consequences

- The `MultiClusterAuroraWriter` becomes a single-cluster writer in normal flow — it writes to the primary cluster only.
- The processor no longer iterates `getActiveClusters()` — it calls `getPrimaryCluster()` and writes once.
- The reindex dispatcher/worker remain as internal tooling, accepting `clusterId` as input to identify the target.
- The HTTP reindex endpoint (`POST /reindex`, `GET /reindex/:jobId`) is removed.
- `job-dispatch-handler.ts` and its tests are deleted.
- The `clusterId` field is removed from all interfaces except the registry module and reindex input.

## References

- ADR-001: Self-managed Aurora pgvector over Bedrock Knowledge Bases
