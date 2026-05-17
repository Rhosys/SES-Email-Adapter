import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../helpers/mock-logger.js";
import { isValidEmail, emailRegex } from "../../src/email/validate-email.js";

describe("isValidEmail", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("returns true when both zod and regex pass", () => {
    const result = isValidEmail("user@example.com", logger);

    expect(result).toBe(true);
    expect(logger.calls).toHaveLength(0);
  });

  it("returns false when both zod and regex fail", () => {
    const result = isValidEmail("not-an-email", logger);

    expect(result).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it("returns false and logs TRACK when zod passes but regex fails", () => {
    // Mock the regex to reject a normally-valid email for this specific test
    const originalTest = RegExp.prototype.test;
    vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, str: string) {
      if (this === emailRegex && str === "zod-only@example.com") return false;
      return originalTest.call(this, str);
    });

    const result = isValidEmail("zod-only@example.com", logger);

    expect(result).toBe(false);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toEqual({
      method: "track",
      message: "Email validation divergence between zod and RFC regex. Both must pass for the email to be considered valid.",
      context: {
        code: "email.validation_divergence",
        email: "zod-only@example.com",
        zodPassed: true,
        regexPassed: false,
      },
    });

    vi.restoreAllMocks();
  });

  it("returns false and logs TRACK when regex passes but zod fails", () => {
    // Quoted local parts are valid per RFC 5322 (regex accepts) but zod rejects them
    const result = isValidEmail('"quoted"@example.com', logger);

    expect(result).toBe(false);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toEqual({
      method: "track",
      message: "Email validation divergence between zod and RFC regex. Both must pass for the email to be considered valid.",
      context: {
        code: "email.validation_divergence",
        email: '"quoted"@example.com',
        zodPassed: false,
        regexPassed: true,
      },
    });
  });
});
