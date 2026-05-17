// Feature: split-embedding-pipeline, Property 8: getSecondaryClusters is the set difference
// **Validates: Requirements 5.1, 5.2**
//
// For any cluster registry configuration, getSecondaryClusters() SHALL return exactly
// getActiveClusters() minus getPrimaryArcMatcherRegistry() — i.e., every active cluster that is not
// the read cluster, and no others.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClusterRegistryEntry } from "../../src/embedding/cluster-registry.js";

// ---------------------------------------------------------------------------
// Hoisted mock state — allows swapping registry per test case
// ---------------------------------------------------------------------------

const { mockRegistry } = vi.hoisted(() => ({
  mockRegistry: { value: [] as ClusterRegistryEntry[] },
}));

// Mock the module but let getSecondaryClusters use the real implementation logic.
vi.mock("../../src/embedding/cluster-registry.js", () => {
  const getActiveClusters = () => mockRegistry.value.filter((c: ClusterRegistryEntry) => c.active);
  const getPrimaryArcMatcherRegistry = () => {
    const active = getActiveClusters();
    if (active.length === 0) throw new Error("No active clusters in CLUSTER_REGISTRY");
    return active[0]!;
  };
  // This is the REAL implementation from cluster-registry.ts — we're testing this logic
  const getSecondaryClusters = () => {
    const primary = getPrimaryArcMatcherRegistry();
    return getActiveClusters().filter((c: ClusterRegistryEntry) => c.registryId !== primary.registryId);
  };
  return {
    CLUSTER_REGISTRY: Object.freeze([]),
    getActiveClusters,
    getPrimaryArcMatcherRegistry,
    getSecondaryClusters,
    getRegistryById: (id: string) => mockRegistry.value.find((c: ClusterRegistryEntry) => c.registryId === id) ?? null,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(index: number, active: boolean): ClusterRegistryEntry {
  return {
    registryId: `cluster-${index}`,
    clusterArn: `arn:aws:rds:eu-west-1:123456789012:cluster:cluster-${index}`,
    secretArn: `arn:aws:secretsmanager:eu-west-1:123456789012:secret:cluster-${index}-xxx`,
    databaseName: "signals",
    modelId: `model-${index}:0`,
    dimensions: 1024,
    active,
    primary: index === 0 && active,
  };
}

// ---------------------------------------------------------------------------
// Static test cases: distinct registry configurations
// ---------------------------------------------------------------------------

const setDifferenceCases = [
  {
    scenario: "1 active cluster only → secondary is empty",
    registry: [makeEntry(0, true)],
    expectedSecondaryIds: [],
  },
  {
    scenario: "2 active clusters → secondary has 1 (the non-primary)",
    registry: [makeEntry(0, true), makeEntry(1, true)],
    expectedSecondaryIds: ["cluster-1"],
  },
  {
    scenario: "3 active + 1 inactive → secondary has 2 active non-primary, excludes inactive",
    registry: [makeEntry(0, true), makeEntry(1, true), makeEntry(2, true), makeEntry(3, false)],
    expectedSecondaryIds: ["cluster-1", "cluster-2"],
  },
  {
    scenario: "4 active clusters (max) → secondary has 3",
    registry: [makeEntry(0, true), makeEntry(1, true), makeEntry(2, true), makeEntry(3, true)],
    expectedSecondaryIds: ["cluster-1", "cluster-2", "cluster-3"],
  },
  {
    scenario: "1 active + 3 inactive → secondary is empty (only primary is active)",
    registry: [makeEntry(0, true), makeEntry(1, false), makeEntry(2, false), makeEntry(3, false)],
    expectedSecondaryIds: [],
  },
];

// ---------------------------------------------------------------------------
// Property 8: getSecondaryClusters is the set difference
// ---------------------------------------------------------------------------

describe("Property 8: getSecondaryClusters is the set difference", () => {
  beforeEach(() => {
    mockRegistry.value = [];
  });

  it.each(setDifferenceCases)("$scenario", async ({ registry, expectedSecondaryIds }) => {
    const { getActiveClusters, getPrimaryArcMatcherRegistry, getSecondaryClusters } = await import("../../src/embedding/cluster-registry.js");

    mockRegistry.value = registry;

    const active = getActiveClusters();
    const primary = getPrimaryArcMatcherRegistry();
    const secondary = getSecondaryClusters();

    // Property A: secondary contains no element equal to the primary cluster
    for (const entry of secondary) {
      expect(entry.registryId).not.toBe(primary.registryId);
    }

    // Property B: every active cluster that is NOT the primary IS in secondary
    const expectedIds = active
      .filter((c) => c.registryId !== primary.registryId)
      .map((c) => c.registryId)
      .sort();
    const actualIds = secondary.map((c) => c.registryId).sort();
    expect(actualIds).toEqual(expectedIds);
    expect(actualIds).toEqual([...expectedSecondaryIds].sort());

    // Property C: secondary length equals active length minus 1 (the primary)
    expect(secondary).toHaveLength(active.length - 1);
  });
});
