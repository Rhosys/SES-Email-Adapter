import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RequestLogger, redactReplacer } from "../src/logger.js";

describe("logger edge cases", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("cognito identity object redaction (Requirement 5.3)", () => {
    it("redacts cognitoIdentityId regardless of value type", () => {
      expect(redactReplacer("cognitoIdentityId", "us-east-1:abc-123")).toBe("[REDACTED]");
      expect(redactReplacer("cognitoIdentityId", 12345)).toBe("[REDACTED]");
      expect(redactReplacer("cognitoIdentityId", null)).toBe("[REDACTED]");
      expect(redactReplacer("cognitoIdentityId", undefined)).toBe("[REDACTED]");
      expect(redactReplacer("cognitoIdentityId", { nested: true })).toBe("[REDACTED]");
    });

    it("redacts cognitoIdentityPoolId regardless of value type", () => {
      expect(redactReplacer("cognitoIdentityPoolId", "us-east-1:pool-id")).toBe("[REDACTED]");
      expect(redactReplacer("cognitoIdentityPoolId", 0)).toBe("[REDACTED]");
      expect(redactReplacer("cognitoIdentityPoolId", true)).toBe("[REDACTED]");
    });

    it("redacts cognitoAuthenticationProvider regardless of value type", () => {
      expect(redactReplacer("cognitoAuthenticationProvider", "cognito-idp.us-east-1.amazonaws.com/pool")).toBe("[REDACTED]");
      expect(redactReplacer("cognitoAuthenticationProvider", ["array"])).toBe("[REDACTED]");
    });

    it("redacts cognitoAuthenticationType regardless of value type", () => {
      expect(redactReplacer("cognitoAuthenticationType", "authenticated")).toBe("[REDACTED]");
      expect(redactReplacer("cognitoAuthenticationType", "")).toBe("[REDACTED]");
    });

    it("redacts cognito keys in full log context", () => {
      const logger = new RequestLogger("test1234");
      logger.startInvocation("test-invocation");
      logger.info("auth.context", {
        cognitoIdentityId: "us-east-1:abc-123",
        cognitoIdentityPoolId: "us-east-1:pool-xyz",
        cognitoAuthenticationProvider: "cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC",
        cognitoAuthenticationType: "authenticated",
      });

      const output = consoleSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(output.cognitoIdentityId).toBe("[REDACTED]");
      expect(output.cognitoIdentityPoolId).toBe("[REDACTED]");
      expect(output.cognitoAuthenticationProvider).toBe("[REDACTED]");
      expect(output.cognitoAuthenticationType).toBe("[REDACTED]");
    });
  });

  describe("circular reference handling", () => {
    it("handles circular refs gracefully with _circular marker instead of crashing", () => {
      const logger = new RequestLogger("test1234");
      logger.startInvocation("test-invocation");

      const circular: Record<string, unknown> = { name: "test" };
      circular.self = circular;

      logger.info("circular.test", circular);

      const output = consoleSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(output.level).toBe("INFO");
      expect(output.title).toBe("circular.test");
      expect(output.containerId).toBe("test1234");
      expect(output.name).toBe("test");
      // The circular ref is resolved: self.self becomes { _circular: true }
      const self = output.self as Record<string, unknown>;
      expect(self.name).toBe("test");
      expect((self.self as Record<string, unknown>)._circular).toBe(true);
    });
  });

  describe("BigInt and function values in context", () => {
    it("converts BigInt to string via redactReplacer", () => {
      expect(redactReplacer("count", BigInt(9007199254740991))).toBe("9007199254740991");
    });

    it("converts named function to [Function: name]", () => {
      function myHandler() {}
      expect(redactReplacer("callback", myHandler)).toBe("[Function: myHandler]");
    });

    it("converts anonymous function to [Function: anonymous]", () => {
      expect(redactReplacer("callback", () => {})).toBe("[Function: anonymous]");
    });

    it("handles BigInt in full log context", () => {
      const logger = new RequestLogger("test1234");
      logger.startInvocation("test-invocation");
      logger.info("big.number", { largeId: BigInt(123456789012345) });

      const output = consoleSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(output.largeId).toBe("123456789012345");
    });

    it("handles function in full log context", () => {
      const logger = new RequestLogger("test1234");
      logger.startInvocation("test-invocation");
      function processEmail() {}
      logger.info("fn.test", { handler: processEmail });

      const output = consoleSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(output.handler).toBe("[Function: processEmail]");
    });
  });

  describe("empty message identifier", () => {
    it("emits valid JSON with empty string message", () => {
      const logger = new RequestLogger("test1234");
      logger.startInvocation("test-invocation");
      logger.info("");

      const output = consoleSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(output.level).toBe("INFO");
      expect(output.title).toBe("");
      expect(output.timestamp).toBeDefined();
      expect(output.invocationId).toBeDefined();
      expect(output.containerId).toBe("test1234");
    });
  });

  describe("trackPoint() called without startInvocation()", () => {
    it("produces valid JSON with large positive elapsedMs", () => {
      const logger = new RequestLogger("test1234");
      // Do NOT call startInvocation — startTime remains 0
      logger.trackPoint("early.point");
      logger.track("timing.report");

      const output = consoleSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(output.level).toBe("TRACK");
      const trackPoints = output.trackPoints as Array<{ name: string; elapsedMs: number }>;
      expect(trackPoints).toHaveLength(1);
      expect(trackPoints[0]!.name).toBe("early.point");
      // elapsedMs = Date.now() - 0, which is a large positive number (current timestamp in ms)
      expect(trackPoints[0]!.elapsedMs).toBeGreaterThan(1_000_000_000);
    });
  });
});
