import { describe, it, expect } from "vitest";
import jsonLogic from "json-logic-js";
import { WORKFLOWS } from "../../src/types/index.js";
import { SYSTEM_RULES } from "../../src/processor/system-rules.js";

// =============================================================================
// Task 7.3: Healthcheck workflow type unit tests
// Validates: Requirements 7.4
// =============================================================================

describe("healthcheck workflow type", () => {
  it('"healthcheck" is a valid workflow value in WORKFLOWS array', () => {
    expect(WORKFLOWS).toContain("healthcheck");
  });

  it("SR-15 (pong) condition does not match workflow healthcheck", () => {
    const sr15 = SYSTEM_RULES.find(r => r.id === "SR-15");
    expect(sr15).toBeDefined();
    expect(sr15!.actions[0]!.type).toBe("pong");

    const condition = JSON.parse(sr15!.condition);
    const context = { signal: { workflow: "healthcheck" } };
    const result = jsonLogic.apply(condition, context);
    expect(result).toBe(false);
  });

  it("SR-15 (pong) condition matches workflow test", () => {
    const sr15 = SYSTEM_RULES.find(r => r.id === "SR-15");
    const condition = JSON.parse(sr15!.condition);
    const context = { signal: { workflow: "test" } };
    const result = jsonLogic.apply(condition, context);
    expect(result).toBe(true);
  });
});
