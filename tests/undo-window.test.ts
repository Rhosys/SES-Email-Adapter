import { describe, it, expect } from "vitest";
import { computeUndoWindowSeconds } from "../src/api/undo-window.js";

describe("computeUndoWindowSeconds", () => {
  describe("word count logic", () => {
    it("treats undefined textBody as 0 words", () => {
      expect(computeUndoWindowSeconds(undefined)).toBe(10);
    });

    it("treats empty string as 0 words", () => {
      expect(computeUndoWindowSeconds("")).toBe(10);
    });

    it("treats whitespace-only string as 0 words", () => {
      expect(computeUndoWindowSeconds("   \t\n  ")).toBe(10);
    });

    it("splits on multiple whitespace characters", () => {
      // 2 words — well under 50
      expect(computeUndoWindowSeconds("hello   world")).toBe(10);
    });
  });

  describe("bracket boundaries", () => {
    it.each([
      { words: 0, expected: 10, label: "0 words → 10s (bottom of <50 bracket)" },
      { words: 49, expected: 10, label: "49 words → 10s (top of <50 bracket)" },
      { words: 50, expected: 60, label: "50 words → 60s (bottom of 50–199 bracket)" },
      { words: 199, expected: 60, label: "199 words → 60s (top of 50–199 bracket)" },
      { words: 200, expected: 180, label: "200 words → 180s (bottom of 200–499 bracket)" },
      { words: 499, expected: 180, label: "499 words → 180s (top of 200–499 bracket)" },
      { words: 500, expected: 300, label: "500 words → 300s (bottom of 500+ bracket)" },
      { words: 1000, expected: 300, label: "1000 words → 300s (well into 500+ bracket)" },
    ])("$label", ({ words, expected }) => {
      const textBody = Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
      expect(computeUndoWindowSeconds(textBody)).toBe(expected);
    });
  });
});
