// ---------------------------------------------------------------------------
// Cluster Registry
// Single source of truth for active Aurora clusters and their models.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterRegistryEntry {
  registryId: string;          // 'aurora-prod-titan-v2'
  clusterArn: string;         // arn:aws:rds:eu-central-1:...:cluster:...
  secretArn: string;          // Secrets Manager ARN for this cluster's master credentials
  databaseName: string;
  modelId: string;            // 'amazon.titan-embed-text-v2:0'
  dimensions: number;         // 1024
  active: boolean;            // false = stop writing, retain reads + cache
  primary: boolean;           // true = the read cluster used for thread matching
}

// ---------------------------------------------------------------------------
// Cluster Registry
// ---------------------------------------------------------------------------

export const CLUSTER_REGISTRY: readonly ClusterRegistryEntry[] = Object.freeze([
  Object.freeze({
    registryId: 'aurora-prod-titan-v2',
    clusterArn: process.env['AURORA_CLUSTER_ARN'] ?? '',
    secretArn:  process.env['AURORA_SECRET_ARN'] ?? '',
    databaseName: process.env['AURORA_DB_NAME'] ?? 'signals',
    modelId: 'amazon.titan-embed-text-v2:0',
    dimensions: 1024,
    active: true,
    primary: true,
  }),
]);

export type RegistryId = typeof CLUSTER_REGISTRY[number]['registryId'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getActiveClusters(): readonly ClusterRegistryEntry[] {
  return CLUSTER_REGISTRY.filter((c) => c.active);
}

export function getRegistryById(registryId: string): ClusterRegistryEntry | null {
  return CLUSTER_REGISTRY.find((c) => c.registryId === registryId) ?? null;
}

export function getPrimaryThreadMatcherRegistry(): ClusterRegistryEntry {
  return CLUSTER_REGISTRY.find((c) => c.primary)!;
}

export function getSecondaryClusters(): readonly ClusterRegistryEntry[] {
  return getActiveClusters().filter((c) => !c.primary);
}
