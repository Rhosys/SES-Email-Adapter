import { describe, it, expect } from "vitest";
import { statusToCategory } from "./stats-writer.js";

describe("statusToCategory", () => {
  it.each([
    { status: "active", expected: "allowed" },
    { status: "block_hidden", expected: "blocked" },
    { status: "block_reject", expected: "blocked" },
    { status: "violate_report", expected: "violationReport" },
    { status: "quarantine_visible", expected: "quarantined" },
    { status: "quarantine_hidden", expected: "quarantined" },
  ] as const)("maps $status → $expected", ({ status, expected }) => {
    expect(statusToCategory(status)).toBe(expected);
  });

  it("returns null for draft", () => {
    expect(statusToCategory("draft")).toBeNull();
  });
});
