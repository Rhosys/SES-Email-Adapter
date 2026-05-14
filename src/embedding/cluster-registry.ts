// ---------------------------------------------------------------------------
// Cluster Registry
// Single source of truth for active Aurora clusters and their models.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterRegistryEntry {
  clusterId: string;          // 'aurora-prod-titan-v2'
  clusterArn: string;         // arn:aws:rds:eu-central-1:...:cluster:...
  secretArn: string;          // Secrets Manager ARN for this cluster's master credentials
  databaseName: string;
  modelId: string;            // 'amazon.titan-embed-text-v2:0'
  dimensions: number;         // 1024
  active: boolean;            // false = stop writing, retain reads + cache
}

// ---------------------------------------------------------------------------
// Cluster Registry
// ---------------------------------------------------------------------------

export const CLUSTER_REGISTRY: readonly ClusterRegistryEntry[] = Object.freeze([
  Object.freeze({
    clusterId: 'aurora-prod-titan-v2',
    clusterArn: 'arn:aws:rds:eu-central-1:123456789012:cluster:aurora-prod-titan-v2',
    secretArn: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:aurora-prod-titan-v2-xxxxxx',
    databaseName: 'signals',
    modelId: 'amazon.titan-embed-text-v2:0',
    dimensions: 1024,
    active: true,
  }),
]);

// ---------------------------------------------------------------------------
// Module-load assertion
// Enforce ≤ 4 active entries at runtime
// ---------------------------------------------------------------------------

const activeCount = CLUSTER_REGISTRY.filter((c) => c.active).length;
if (activeCount > 4) {
  throw new Error(`CLUSTER_REGISTRY has ${activeCount} active entries; maximum is 4`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getActiveClusters(): readonly ClusterRegistryEntry[] {
  return CLUSTER_REGISTRY.filter((c) => c.active);
}

export function getClusterById(clusterId: string): ClusterRegistryEntry | null {
  return CLUSTER_REGISTRY.find((c) => c.clusterId === clusterId) ?? null;
}

export function getReadCluster(): ClusterRegistryEntry {
  const active = getActiveClusters();
  if (active.length === 0) {
    throw new Error('No active clusters in CLUSTER_REGISTRY');
  }
  return active[0]!;
}
