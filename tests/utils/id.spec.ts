import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generateId, generateAccountId, validateAccountId } from "../../src/utils/id.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_SET = new Set(BASE58_ALPHABET);

describe("generateId", () => {
  describe("format validation", () => {
    it.each([
      { prefix: "thr-", reason: "4-char prefix for arcs (threads)" },
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
      const ids = Array.from({ length: 1000 }, () => generateId("thr-"));
      const unique = new Set(ids);
      expect(unique.size).toBe(1000);
    });
  });

  describe("time ordering", () => {
    it("base58 body of earlier ID sorts before later ID under plain ASCII string comparison", async () => {
      // The alphabet is ordered digits < uppercase < lowercase, matching ASCII byte
      // order, so plain string comparison (the same comparison DynamoDB applies to
      // sort keys) must agree with generation order without any custom comparator.
      const first = generateId("thr-");
      await new Promise(resolve => setTimeout(resolve, 10));
      const second = generateId("thr-");

      const firstBody = first.slice(4, 4 + 22);
      const secondBody = second.slice(4, 4 + 22);

      expect(firstBody < secondBody).toBe(true);
    });

    it("plain string sort of many IDs matches generation order", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        ids.push(generateId("sgn-"));
        if (i % 5 === 0) await new Promise(resolve => setTimeout(resolve, 2));
      }
      const sorted = [...ids].sort();
      expect(sorted).toEqual(ids);
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

describe("validateAccountId", () => {
  describe("roundtrip: generateAccountId → validateAccountId", () => {
    it("validates a freshly generated account ID", () => {
      const id = generateAccountId();
      expect(validateAccountId(id)).toBe(true);
    });
  });

  describe("static known-good ID", () => {
    it("validates a hardcoded account ID", () => {
      expect(validateAccountId("acc-znwghtnifmqsx")).toBe(true);
    });
  });

  describe("tampered checksum", () => {
    it("rejects an account ID with modified check chars", () => {
      const id = generateAccountId();
      const tampered = id.slice(0, -3) + "zzz";
      expect(validateAccountId(tampered)).toBe(false);
    });
  });

  describe("wrong prefix", () => {
    it("rejects an ID that does not start with acc-", () => {
      const id = generateAccountId();
      const withoutPrefix = id.slice(4);
      expect(validateAccountId(`arc-${withoutPrefix}`)).toBe(false);
    });
  });

  describe("wrong length", () => {
    it.each([
      { label: "too short (prefix + 12 chars)", id: "acc-abcdefghij12" },
      { label: "too long (prefix + 14 chars)", id: "acc-abcdefghij1234" },
      { label: "just prefix", id: "acc-" },
      { label: "empty string", id: "" },
    ])("rejects $label", ({ id }) => {
      expect(validateAccountId(id)).toBe(false);
    });
  });

  describe("invalid chars", () => {
    it.each([
      { label: "uppercase letter", id: "acc-Abcdefghij123" },
      { label: "special character", id: "acc-abcdefghi!123" },
      { label: "space", id: "acc-abcdefghi 123" },
    ])("rejects ID with $label", ({ id }) => {
      expect(validateAccountId(id)).toBe(false);
    });
  });
});
