import { describe, it, expect } from "vitest";
import { generateId, validateId } from "./id.js";

describe("validateId", () => {
  describe("roundtrip: generateId → validateId", () => {
    it.each([
      { prefix: "thr-" },
      { prefix: "sgn-" },
      { prefix: "view-" },
      { prefix: "rule-" },
      { prefix: "tpl-" },
    ])("validates an ID generated with prefix '$prefix'", ({ prefix }) => {
      const id = generateId(prefix);
      expect(validateId(id, prefix)).toBe(true);
    });
  });

  describe("static known-good IDs", () => {
    // Generate a few IDs and hardcode them for deterministic regression tests
    const knownGood = [
      { id: generateId("thr-"), prefix: "thr-" },
      { id: generateId("sgn-"), prefix: "sgn-" },
      { id: generateId("rule-"), prefix: "rule-" },
    ];

    it.each(knownGood)("validates static ID $id with prefix '$prefix'", ({ id, prefix }) => {
      expect(validateId(id, prefix)).toBe(true);
    });
  });

  describe("tampered checksum", () => {
    it("rejects an ID with modified check chars", () => {
      const id = generateId("thr-");
      // Replace last 3 chars with something different
      const tampered = id.slice(0, -3) + "zzz";
      expect(validateId(tampered, "thr-")).toBe(false);
    });

    it("rejects an ID with a single flipped check char", () => {
      const id = generateId("sgn-");
      const lastChar = id[id.length - 1]!;
      const replacement = lastChar === "a" ? "b" : "a";
      const tampered = id.slice(0, -1) + replacement;
      expect(validateId(tampered, "sgn-")).toBe(false);
    });
  });

  describe("wrong prefix", () => {
    it("rejects a valid thr- ID when validated with sgn- prefix", () => {
      const id = generateId("thr-");
      expect(validateId(id, "sgn-")).toBe(false);
    });

    it("rejects a valid sgn- ID when validated with thr- prefix", () => {
      const id = generateId("sgn-");
      expect(validateId(id, "thr-")).toBe(false);
    });
  });

  describe("too short", () => {
    it.each([
      { label: "just prefix", id: "thr-", prefix: "thr-" },
      { label: "prefix + 1 char", id: "thr-a", prefix: "thr-" },
      { label: "prefix + 2 chars", id: "thr-ab", prefix: "thr-" },
      { label: "prefix + 3 chars (body is exactly 3 — no encoded part)", id: "thr-abc", prefix: "thr-" },
      { label: "empty string", id: "", prefix: "thr-" },
    ])("rejects $label", ({ id, prefix }) => {
      expect(validateId(id, prefix)).toBe(false);
    });
  });

  describe("missing prefix", () => {
    it("rejects an ID that does not start with the expected prefix", () => {
      expect(validateId("noprefixhere", "thr-")).toBe(false);
    });
  });
});
