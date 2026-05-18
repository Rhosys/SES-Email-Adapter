import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generateId } from "../../src/utils/id.js";

const FLICKR_BASE58 = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const BASE58_SET = new Set(FLICKR_BASE58);

describe("generateId", () => {
  describe("format validation", () => {
    it.each([
      { prefix: "arc-", reason: "4-char prefix for arcs" },
      { prefix: "view-", reason: "5-char prefix for views" },
      { prefix: "rule-", reason: "5-char prefix for rules" },
      { prefix: "tpl-", reason: "4-char prefix for templates" },
      { prefix: "aud-", reason: "4-char prefix for audit events" },
      { prefix: "sgn-", reason: "4-char prefix for signals" },
    ])("$prefix — $reason", ({ prefix }) => {
      const id = generateId(prefix);

      expect(id.startsWith(prefix)).toBe(true);

      const body = id.slice(prefix.length);
      expect(body.length).toBe(22 + 3);

      const base58Body = body.slice(0, 22);
      for (const ch of base58Body) {
        expect(BASE58_SET.has(ch)).toBe(true);
      }

      const checkChars = body.slice(22);
      for (const ch of checkChars) {
        expect(BASE58_SET.has(ch)).toBe(true);
      }
    });
  });

  describe("uniqueness", () => {
    it("1000 IDs with the same prefix are all distinct", () => {
      const ids = Array.from({ length: 1000 }, () => generateId("arc-"));
      const unique = new Set(ids);
      expect(unique.size).toBe(1000);
    });
  });

  describe("time ordering", () => {
    it("base58 body of earlier ID is numerically less than later ID", async () => {
      const first = generateId("arc-");
      await new Promise(resolve => setTimeout(resolve, 10));
      const second = generateId("arc-");

      const firstBody = first.slice(4, 4 + 22);
      const secondBody = second.slice(4, 4 + 22);

      // Compare using base58 alphabet ordering (not ASCII)
      const FLICKR_BASE58_ALPHABET = "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
      function base58Compare(a: string, b: string): number {
        for (let i = 0; i < a.length; i++) {
          const ai = FLICKR_BASE58_ALPHABET.indexOf(a[i]!);
          const bi = FLICKR_BASE58_ALPHABET.indexOf(b[i]!);
          if (ai !== bi) return ai - bi;
        }
        return 0;
      }

      expect(base58Compare(firstBody, secondBody)).toBeLessThan(0);
    });
  });

  describe("check char correctness", () => {
    it("check chars match independent recomputation from base58 body", () => {
      const id = generateId("sgn-");
      const base58Body = id.slice(4, 4 + 22);
      const actualCheckChars = id.slice(4 + 22);

      const hash = createHash("sha256").update(base58Body).digest("hex");
      const expectedCheckChars = [...hash].filter(c => BASE58_SET.has(c)).slice(0, 3).join("");

      expect(actualCheckChars).toBe(expectedCheckChars);
    });
  });

  describe("check char sensitivity", () => {
    it("flipping one char in base58 body produces different check chars", () => {
      const id = generateId("rule-");
      const prefix = "rule-";
      const base58Body = id.slice(prefix.length, prefix.length + 22);
      const originalCheckChars = id.slice(prefix.length + 22);

      // Flip the first character to a different base58 character
      const flippedChar = base58Body[0] === "a" ? "b" : "a";
      const corruptedBody = flippedChar + base58Body.slice(1);

      const hash = createHash("sha256").update(corruptedBody).digest("hex");
      const corruptedCheckChars = [...hash].filter(c => BASE58_SET.has(c)).slice(0, 3).join("");

      expect(corruptedCheckChars).not.toBe(originalCheckChars);
    });
  });
});
