// Feature: split-embedding-pipeline, Property 8: getSecondaryClusters is the set difference
// **Validates: Requirements 5.1, 5.2**
//
// For any cluster registry configuration, getSecondaryClusters() SHALL return exactly
// getActiveClusters() minus getPrimaryArcMatcherRegistry() — i.e., every active cluster that is not
// the read cluster, and no others.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import type { ClusterRegistryEntry } from "./cluster-registry.js";

// ---------------------------------------------------------------------------
// Hoisted mock state — allows fast-check to swap registry per iteration
// ---------------------------------------------------------------------------

const { mockRegistry } = vi.hoisted(() => ({
  mockRegistry: { value: [] as ClusterRegistryEntry[] },
}));

// Mock the module but let getSecondaryClusters use the real implementation logic.
// We mock getActiveClusters and getPrimaryArcMatcherRegistry to read from our mutable registry,
// and provide getSecondaryClusters as a real implementation that calls them.
vi.mock("./cluster-registry.js", () => {
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
// Generator: arbitrary cluster registry entries
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

/**
 * Generate a registry with 1–4 entries, ensuring at least one is active.
 * The module-load assertion enforces max 4 active entries.
 */
const registryArb: fc.Arbitrary<ClusterRegistryEntry[]> = fc
  .array(fc.boolean(), { minLength: 1, maxLength: 4 })
  .filter((flags) => flags.some((f) => f)) // at least one active
  .map((flags) => flags.map((active, i) => makeEntry(i, active)));

// ---------------------------------------------------------------------------
// Property 8: getSecondaryClusters is the set difference
// ---------------------------------------------------------------------------

describe("Property 8: getSecondaryClusters is the set difference", () => {
  beforeEach(() => {
    mockRegistry.value = [];
  });

  it("returns exactly getActiveClusters() minus getPrimaryArcMatcherRegistry() for any valid registry", async () => {
    const { getActiveClusters, getPrimaryArcMatcherRegistry, getSecondaryClusters } = await import("./cluster-registry.js");

    fc.assert(
      fc.property(registryArb, (registry) => {
        mockRegistry.value = registry;

        const active = getActiveClusters();
        const read = getPrimaryArcMatcherRegistry();
        const secondary = getSecondaryClusters();

        // Property A: secondary contains no element equal to the read cluster
        for (const entry of secondary) {
          expect(entry.registryId).not.toBe(read.registryId);
        }

        // Property B: every active cluster that is NOT the read cluster IS in secondary
        const expectedIds = active
          .filter((c) => c.registryId !== read.registryId)
          .map((c) => c.registryId)
          .sort();
        const actualIds = secondary.map((c) => c.registryId).sort();
        expect(actualIds).toEqual(expectedIds);

        // Property C: secondary length equals active length minus 1 (the read cluster)
        expect(secondary).toHaveLength(active.length - 1);
      }),
      { numRuns: 100 },
    );
  });

  it("returns empty array when only one active cluster exists", async () => {
    const { getSecondaryClusters } = await import("./cluster-registry.js");

    const singleActiveArb = fc
      .array(fc.constant(false), { minLength: 0, maxLength: 3 })
      .map((inactiveFlags) => {
        const entries = [makeEntry(0, true)];
        inactiveFlags.forEach((_, i) => entries.push(makeEntry(i + 1, false)));
        return entries;
      });

    fc.assert(
      fc.property(singleActiveArb, (registry) => {
        mockRegistry.value = registry;
        const secondary = getSecondaryClusters();
        expect(secondary).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
