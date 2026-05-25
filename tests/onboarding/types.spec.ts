import { describe, it, expect } from "vitest";
import { isStepFunctionTaskEvent } from "../../src/onboarding/types.js";
import type { StepFunctionTaskEvent } from "../../src/onboarding/types.js";

describe("isStepFunctionTaskEvent", () => {
  const validEvent: StepFunctionTaskEvent = {
    context: {
      Execution: {
        Id: "arn:aws:states:eu-central-1:123456789012:execution:email-catcher-AccountCreation:acc-abc123xyz",
        Input: { accountId: "acc-abc123xyz", email: "user@example.com" },
        Name: "acc-abc123xyz",
      },
      StateMachine: {
        Id: "arn:aws:states:eu-central-1:123456789012:stateMachine:email-catcher-AccountCreation",
        Name: "email-catcher-AccountCreation",
      },
      State: {
        Name: "FirstFollowup",
        EnteredTime: "2025-06-01T10:00:00Z",
      },
    },
  };

  it("returns true for a valid Step Function task event", () => {
    expect(isStepFunctionTaskEvent(validEvent)).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "hello"],
    ["an empty object", {}],
    ["an object without context", { Records: [] }],
    ["an object with null context", { context: null }],
    ["an object with non-object context", { context: "string" }],
    ["a context missing StateMachine", { context: { Execution: {}, State: {} } }],
  ])("returns false for %s", (_label, input) => {
    expect(isStepFunctionTaskEvent(input)).toBe(false);
  });

  it("returns true when context has StateMachine even with minimal fields", () => {
    const minimal = { context: { StateMachine: { Id: "arn", Name: "sm" } } };
    expect(isStepFunctionTaskEvent(minimal)).toBe(true);
  });
});
