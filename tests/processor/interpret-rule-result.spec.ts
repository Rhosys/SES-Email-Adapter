import { describe, it, expect } from "vitest";
import { interpretRuleResult, RuleActionSchema } from "../../src/processor/interpret-rule-result.js";

// ---------------------------------------------------------------------------
// Property 3: Return value interpreter correctly classifies all result types
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
// ---------------------------------------------------------------------------

describe("interpretRuleResult", () => {
  describe("null/undefined → non-matching (Req 5.1)", () => {
    it.each([
      { label: "null", input: null },
      { label: "undefined", input: undefined },
    ])("$label → matched:false, no dynamic actions", ({ input }) => {
      const result = interpretRuleResult(input);
      expect(result).toEqual({ matched: false, dynamicActions: [], warnings: [] });
    });
  });

  describe("valid RuleAction object → matching with that action (Req 5.2)", () => {
    it.each([
      { label: "archive (no value)", input: { type: "archive" } },
      { label: "assign_label with value", input: { type: "assign_label", value: "important" } },
      { label: "forward with value and disabled", input: { type: "forward", value: "x@y.com", disabled: false } },
    ])("$label → matched:true, action appended", ({ input }) => {
      const result = interpretRuleResult(input);
      expect(result.matched).toBe(true);
      expect(result.dynamicActions).toEqual([input]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe("array → matching, validate each element (Req 5.3, 5.5)", () => {
    it("array of valid actions → all kept", () => {
      const actions = [
        { type: "archive" },
        { type: "assign_label", value: "urgent" },
      ];
      const result = interpretRuleResult(actions);
      expect(result.matched).toBe(true);
      expect(result.dynamicActions).toEqual(actions);
      expect(result.warnings).toEqual([]);
    });

    it("array with invalid element → valid kept, invalid discarded, warning generated", () => {
      const actions = [
        { type: "archive" },
        { type: "not_a_real_action" },
        { type: "delete" },
      ];
      const result = interpretRuleResult(actions);
      expect(result.matched).toBe(true);
      expect(result.dynamicActions).toEqual([{ type: "archive" }, { type: "delete" }]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Element [1]");
    });

    it("empty array → matching with no dynamic actions", () => {
      const result = interpretRuleResult([]);
      expect(result.matched).toBe(true);
      expect(result.dynamicActions).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it("array with all invalid elements → matching, all discarded, warnings for each", () => {
      const actions = [
        { type: "bogus" },
        { notType: "missing" },
      ];
      const result = interpretRuleResult(actions);
      expect(result.matched).toBe(true);
      expect(result.dynamicActions).toEqual([]);
      expect(result.warnings).toHaveLength(2);
    });
  });

  describe("other truthy values → matching with no dynamic actions (Req 5.4)", () => {
    it.each([
      { label: "true", input: true },
      { label: "string 'hello'", input: "hello" },
      { label: "number 42", input: 42 },
      { label: "object without type field", input: { random: "object" } },
      { label: "object with invalid type value", input: { type: "not_valid_action_type" } },
    ])("$label → matched:true, no dynamic actions", ({ input }) => {
      const result = interpretRuleResult(input);
      expect(result.matched).toBe(true);
      expect(result.dynamicActions).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe("RuleActionSchema validates correctly", () => {
    it("accepts a valid action", () => {
      const result = RuleActionSchema.safeParse({ type: "archive" });
      expect(result.success).toBe(true);
    });

    it("rejects an unknown type", () => {
      const result = RuleActionSchema.safeParse({ type: "unknown_type" });
      expect(result.success).toBe(false);
    });

    it("rejects missing type", () => {
      const result = RuleActionSchema.safeParse({ value: "something" });
      expect(result.success).toBe(false);
    });
  });
});
