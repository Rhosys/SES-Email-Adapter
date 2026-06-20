import { describe, it, expect } from "vitest";
import { validateRuleCondition } from "../../src/api/validate-rule-condition.js";

describe("validateRuleCondition", () => {
  describe("valid JSONLogic conditions", () => {
    const validCases = [
      { scenario: "simple equality", condition: '{"==":[{"var":"signal.workflow"},"payments"]}' },
      { scenario: "numeric comparison", condition: '{">":[{"var":"signal.workflow"},0.8]}' },
      { scenario: "nested AND with multiple fields", condition: '{"and":[{"==":[{"var":"signal.workflow"},"auth"]},{"<":[{"var":"signal.workflow"},0.3]}]}' },
      { scenario: "boolean true (always matches)", condition: "true" },
      { scenario: "in operator with array", condition: '{"in":[{"var":"signal.workflow"},["payments","travel","package"]]}' },
    ];

    it.each(validCases)("accepts: $scenario", ({ condition }) => {
      expect(validateRuleCondition(condition)).toBeNull();
    });
  });

  describe("invalid JSONLogic conditions", () => {
    const invalidCases = [
      {
        scenario: "not valid JSON (missing closing brace)",
        condition: '{"==":[{"var":"signal.workflow"},"payments"',
        expectedSubstring: "not valid JSON",
      },
      {
        scenario: "unrecognized operator",
        condition: '{"fakeOp":[1,2]}',
        expectedSubstring: "Invalid JSONLogic condition",
      },
      {
        scenario: "completely malformed string",
        condition: "this is not json at all",
        expectedSubstring: "not valid JSON",
      },
      {
        scenario: "null value",
        condition: "null",
        expectedSubstring: "must be a JSON object",
      },
    ];

    it.each(invalidCases)("rejects: $scenario", ({ condition, expectedSubstring }) => {
      const result = validateRuleCondition(condition);
      expect(result).not.toBeNull();
      expect(result).toContain(expectedSubstring);
    });
  });

  describe("JS conditions (js: prefix)", () => {
    it("accepts non-empty JS code", () => {
      expect(validateRuleCondition("js:return ctx.signal.workflow === 'content';")).toBeNull();
    });

    it("rejects empty JS code after prefix", () => {
      const result = validateRuleCondition("js:");
      expect(result).not.toBeNull();
      expect(result).toContain("must contain code");
    });

    it("rejects whitespace-only JS code after prefix", () => {
      const result = validateRuleCondition("js:   ");
      expect(result).not.toBeNull();
      expect(result).toContain("must contain code");
    });
  });
});
