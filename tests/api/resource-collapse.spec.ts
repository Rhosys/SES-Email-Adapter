import { describe, it, expect } from "vitest";
import type { Resource } from "../../src/types/index.js";
import { collapseResources } from "../../src/api/resource-collapse.js";

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    accountId: "acct-1",
    threadId: "thr-001",
    workflow: "events",
    resourceKey: "concert-a",
    status: "active",
    expectedResolutionDate: "2024-07-01T00:00:00Z",
    assets: [],
    createdAt: "2024-06-15T10:00:00Z",
    updatedAt: "2024-06-15T10:00:00Z",
    ...overrides,
  };
}

describe("collapseResources", () => {
  it("merges resources with matching titles on the same UTC day", () => {
    const a = makeResource({ resourceKey: "a", title: "Taylor Swift Concert", displayDate: "2024-07-01T19:00:00Z" });
    const b = makeResource({ resourceKey: "b", title: "Taylor Swift Concert Tour", displayDate: "2024-07-01T20:00:00Z", updatedAt: "2024-06-16T10:00:00Z" });

    const result = collapseResources([a, b]);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("Taylor Swift Concert Tour");
  });

  it("does not merge when dates fall on different days", () => {
    const a = makeResource({ resourceKey: "a", title: "Concert", displayDate: "2024-07-01T19:00:00Z" });
    const b = makeResource({ resourceKey: "b", title: "Concert", displayDate: "2024-07-02T19:00:00Z" });

    expect(collapseResources([a, b])).toHaveLength(2);
  });

  it("merges on title alone when one side has no date", () => {
    const a = makeResource({ resourceKey: "a", title: "Concert", displayDate: "2024-07-01T19:00:00Z" });
    const b = makeResource({ resourceKey: "b", title: "Concert" });

    expect(collapseResources([a, b])).toHaveLength(1);
  });

  it("merges on title alone when neither side has a date", () => {
    const a = makeResource({ resourceKey: "a", title: "Concert" });
    const b = makeResource({ resourceKey: "b", title: "Concert" });

    expect(collapseResources([a, b])).toHaveLength(1);
  });

  it("does not merge across different threads", () => {
    const a = makeResource({ resourceKey: "a", threadId: "thr-001", title: "Concert" });
    const b = makeResource({ resourceKey: "b", threadId: "thr-002", title: "Concert" });

    expect(collapseResources([a, b])).toHaveLength(2);
  });

  it("does not merge across different workflows", () => {
    const a = makeResource({ resourceKey: "a", workflow: "events", title: "Order" });
    const b = makeResource({ resourceKey: "b", workflow: "package", title: "Order" });

    expect(collapseResources([a, b])).toHaveLength(2);
  });

  it("does not merge resources with no title", () => {
    const a = makeResource({ resourceKey: "a" });
    const b = makeResource({ resourceKey: "b" });

    expect(collapseResources([a, b])).toHaveLength(2);
  });

  it("unions assets and dedupes identical ones", () => {
    const asset1 = { type: "qr_code" as const, label: "QR", rawValue: "abc", sourceSignalId: "sig-1", extractedAt: "2024-06-15T10:00:00Z" };
    const asset2 = { type: "barcode" as const, label: "Barcode", rawValue: "xyz", sourceSignalId: "sig-2", extractedAt: "2024-06-15T10:00:00Z" };
    const a = makeResource({ resourceKey: "a", title: "Concert", assets: [asset1] });
    const b = makeResource({ resourceKey: "b", title: "Concert", assets: [asset1, asset2] });

    const result = collapseResources([a, b]);

    expect(result).toHaveLength(1);
    expect(result[0]!.assets).toHaveLength(2);
  });
});
