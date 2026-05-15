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

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

export const CLUSTER_REGISTRY: readonly ClusterRegistryEntry[] = Object.freeze([
  Object.freeze({
    clusterId: 'aurora-prod-titan-v2',
    clusterArn: requireEnv('AURORA_CLUSTER_ARN'),
    secretArn:  requireEnv('AURORA_SECRET_ARN'),
    databaseName: process.env['AURORA_DB_NAME'] ?? 'signals',
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

export function getSecondaryClusters(): readonly ClusterRegistryEntry[] {
  const primary = getReadCluster();
  return getActiveClusters().filter((c) => c.clusterId !== primary.clusterId);
}
