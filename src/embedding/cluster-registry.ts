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
  primary: boolean;           // true = the read cluster used for arc matching
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
    primary: true,
  }),
]);

// ---------------------------------------------------------------------------
// Module-load assertion
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
  return CLUSTER_REGISTRY.find((c) => c.primary)!;
}

export function getSecondaryClusters(): readonly ClusterRegistryEntry[] {
  return getActiveClusters().filter((c) => !c.primary);
}
