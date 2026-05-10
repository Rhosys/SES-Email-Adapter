import { describe, it, expect } from "vitest";
import { CLUSTER_REGISTRY } from "./cluster-registry.js";

// ---------------------------------------------------------------------------
// Smoke test: cluster registry shape
// Validates: Requirements 1.1, 1.2, 1.4
// ---------------------------------------------------------------------------

describe("CLUSTER_REGISTRY smoke test", () => {
  it("CLUSTER_REGISTRY is readonly (type-level assertion)", () => {
    // Type-level: CLUSTER_REGISTRY is declared as readonly ClusterRegistryEntry[]
    // Runtime: Object.freeze ensures the array and its entries cannot be modified
    const registry = CLUSTER_REGISTRY;
    
    // Verify it's an array
    expect(Array.isArray(registry)).toBe(true);
    
    // Verify we cannot push to it (runtime readonly)
    expect(() => {
      // @ts-expect-error - testing readonly behavior
      registry.push({} as any);
    }).toThrow();
    
    // Verify entries are frozen
    for (const entry of registry) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("no registry entry uses environment variables for cluster ARN, secret ARN, or database name", () => {
    // All values must be hardcoded strings, not environment variable references
    const envVarPattern = /\$\{.*\}|\$\(.+\)|process\.env\./;
    
    for (const entry of CLUSTER_REGISTRY) {
      // Check clusterArn
      expect(entry.clusterArn).not.match(
        envVarPattern,
        `clusterArn for ${entry.clusterId} should not use environment variables`
      );
      
      // Check secretArn
      expect(entry.secretArn).not.match(
        envVarPattern,
        `secretArn for ${entry.clusterId} should not use environment variables`
      );
      
      // Check databaseName
      expect(entry.databaseName).not.match(
        envVarPattern,
        `databaseName for ${entry.clusterId} should not use environment variables`
      );
      
      // Verify values are non-empty strings
      expect(entry.clusterArn).toBeTypeOf("string");
      expect(entry.secretArn).toBeTypeOf("string");
      expect(entry.databaseName).toBeTypeOf("string");
      expect(entry.clusterArn).not.toBe("");
      expect(entry.secretArn).not.toBe("");
      expect(entry.databaseName).not.toBe("");
    }
  });

  it("number of active entries is ≤ 4", () => {
    const activeEntries = CLUSTER_REGISTRY.filter((entry) => entry.active === true);
    const activeCount = activeEntries.length;
    
    expect(activeCount).toBeLessThanOrEqual(4);
    expect(activeCount).toBeGreaterThanOrEqual(1); // At least 1 active cluster as per req 1.4
  });

  it("active entries have valid cluster configuration", () => {
    const activeEntries = CLUSTER_REGISTRY.filter((entry) => entry.active === true);
    
    for (const entry of activeEntries) {
      // Verify all required fields are present and valid
      expect(entry.clusterId).toBeTypeOf("string");
      expect(entry.modelId).toBeTypeOf("string");
      expect(entry.dimensions).toBeTypeOf("number");
      expect(entry.dimensions).toBeGreaterThan(0);
    }
  });
});
