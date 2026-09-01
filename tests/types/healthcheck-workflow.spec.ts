import { describe, it, expect } from "vitest";
import { WORKFLOWS } from "../../src/types/index.js";

// =============================================================================
// Task 7.3: Healthcheck workflow type unit tests
// Validates: Requirements 7.4
// =============================================================================

describe("healthcheck workflow type", () => {
  it('"healthcheck" is a valid workflow value in WORKFLOWS array', () => {
    expect(WORKFLOWS).toContain("healthcheck");
  });
});
