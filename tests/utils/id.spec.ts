import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { deriveThreadIdFromSignalId, generateId, generateAccountId, validateAccountId, validateId } from "../../src/utils/id.js";

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

describe("deriveThreadIdFromSignalId", () => {
  it("produces a valid thr- id", () => {
    const signalId = generateId("sgn-");
    expect(validateId(deriveThreadIdFromSignalId(signalId), "thr-")).toBe(true);
  });

  it("is deterministic — same signal id always yields the same thread id", () => {
    const signalId = generateId("sgn-");
    expect(deriveThreadIdFromSignalId(signalId)).toBe(deriveThreadIdFromSignalId(signalId));
  });

  it("shares the encoded body with the originating signal id", () => {
    const signalId = generateId("sgn-");
    const threadId = deriveThreadIdFromSignalId(signalId);
    expect(threadId.slice("thr-".length)).toBe(signalId.slice("sgn-".length));
  });

  it("distinct signal ids yield distinct thread ids", () => {
    const first = deriveThreadIdFromSignalId(generateId("sgn-"));
    const second = deriveThreadIdFromSignalId(generateId("sgn-"));
    expect(first).not.toBe(second);
  });
});
