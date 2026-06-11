import { describe, it, expect } from "vitest";
import { handler } from "../../src/isolated/user-code-executor.js";

const validPayload = {
  tenantId: "acc_123",
  purpose: "rule_condition" as const,
  functionCode: "return signal.subject === 'hello';",
  executionContext: {
    signal: { subject: "hello", from: { address: "a@b.com" } },
    arc: { id: "arc_1", workflow: "conversation" },
  },
};

describe("user-code-executor", () => {
  describe("valid execution", () => {
    it("returns truthy result for rule_condition", async () => {
      const result = await handler(validPayload);
      expect(result).toEqual({
        success: true,
        purpose: "rule_condition",
        result: true,
      });
    });

    it("returns falsy result for rule_condition", async () => {
      const result = await handler({
        ...validPayload,
        functionCode: "return signal.subject === 'goodbye';",
      });
      expect(result).toEqual({
        success: true,
        purpose: "rule_condition",
        result: false,
      });
    });

    it("returns string result for template_function", async () => {
      const result = await handler({
        ...validPayload,
        purpose: "template_function",
        functionCode: "return 'Hello ' + signal.from.address;",
      });
      expect(result).toEqual({
        success: true,
        purpose: "template_function",
        result: "Hello a@b.com",
      });
    });

    it("returns null for template_function when code returns null", async () => {
      const result = await handler({
        ...validPayload,
        purpose: "template_function",
        functionCode: "return null;",
      });
      expect(result).toEqual({
        success: true,
        purpose: "template_function",
        result: null,
      });
    });

    it("returns null for non-string template_function result", async () => {
      const result = await handler({
        ...validPayload,
        purpose: "template_function",
        functionCode: "return 42;",
      });
      expect(result).toEqual({
        success: true,
        purpose: "template_function",
        result: null,
      });
    });
  });

  describe("timeout", () => {
    it("returns timeout error for infinite loop", async () => {
      const result = await handler({
        ...validPayload,
        functionCode: "while(true) {}",
      });
      expect(result).toEqual({
        success: false,
        error: {
          message: expect.stringContaining("timed out"),
          type: "timeout",
        },
      });
    }, 5000);
  });

  describe("runtime error", () => {
    it("returns runtime_error for thrown exception", async () => {
      const result = await handler({
        ...validPayload,
        functionCode: "throw new Error('oops');",
      });
      expect(result).toEqual({
        success: false,
        error: {
          message: expect.stringContaining("oops"),
          type: "runtime_error",
        },
      });
    });

    it("returns runtime_error for reference to undefined variable", async () => {
      const result = await handler({
        ...validPayload,
        functionCode: "return nonExistentVar.foo;",
      });
      expect(result).toEqual({
        success: false,
        error: {
          message: expect.any(String),
          type: "runtime_error",
        },
      });
    });
  });

  describe("sandbox violation", () => {
    it("cannot access process", async () => {
      const result = await handler({
        ...validPayload,
        functionCode: "return process.env.SECRET;",
      });
      // QuickJS sandbox has no process global — runtime error
      expect(result).toEqual({
        success: false,
        error: {
          message: expect.any(String),
          type: "runtime_error",
        },
      });
    });

    it("cannot access require", async () => {
      const result = await handler({
        ...validPayload,
        functionCode: "return require('fs');",
      });
      expect(result).toEqual({
        success: false,
        error: {
          message: expect.any(String),
          type: "runtime_error",
        },
      });
    });

    it("cannot access fetch", async () => {
      const result = await handler({
        ...validPayload,
        functionCode: "return fetch('http://evil.com');",
      });
      expect(result).toEqual({
        success: false,
        error: {
          message: expect.any(String),
          type: "runtime_error",
        },
      });
    });
  });

  describe("invalid input", () => {
    it("rejects null payload", async () => {
      const result = await handler(null);
      expect(result).toEqual({
        success: false,
        error: { message: expect.stringContaining("non-null object"), type: "invalid_input" },
      });
    });

    it("rejects missing tenantId", async () => {
      const { tenantId: _, ...rest } = validPayload;
      const result = await handler(rest);
      expect(result).toEqual({
        success: false,
        error: { message: expect.stringContaining("tenantId"), type: "invalid_input" },
      });
    });

    it("rejects invalid purpose", async () => {
      const result = await handler({ ...validPayload, purpose: "hack" });
      expect(result).toEqual({
        success: false,
        error: { message: expect.stringContaining("purpose"), type: "invalid_input" },
      });
    });

    it("rejects functionCode exceeding 10,000 chars", async () => {
      const result = await handler({
        ...validPayload,
        functionCode: "x".repeat(10_001),
      });
      expect(result).toEqual({
        success: false,
        error: { message: expect.stringContaining("10000"), type: "invalid_input" },
      });
    });

    it("rejects missing executionContext", async () => {
      const { executionContext: _, ...rest } = validPayload;
      const result = await handler(rest);
      expect(result).toEqual({
        success: false,
        error: { message: expect.stringContaining("executionContext"), type: "invalid_input" },
      });
    });

    it("rejects executionContext without signal", async () => {
      const result = await handler({
        ...validPayload,
        executionContext: { arc: {} },
      });
      expect(result).toEqual({
        success: false,
        error: { message: expect.stringContaining("signal and arc"), type: "invalid_input" },
      });
    });
  });

  describe("non-serializable return", () => {
    it("returns null for rule_condition when function returns undefined", async () => {
      // undefined is not JSON-serializable (JSON.stringify returns undefined)
      const result = await handler({
        ...validPayload,
        functionCode: "return undefined;",
      });
      expect(result).toEqual({
        success: true,
        purpose: "rule_condition",
        result: null,
      });
    });

    it("returns null for template_function when function returns undefined", async () => {
      const result = await handler({
        ...validPayload,
        purpose: "template_function",
        functionCode: "return undefined;",
      });
      expect(result).toEqual({
        success: true,
        purpose: "template_function",
        result: null,
      });
    });
  });

  describe("validate_ast purpose", () => {
    it("returns valid: true for a valid arrow function", async () => {
      const result = await handler({
        tenantId: "acc_123",
        purpose: "validate_ast",
        functionCode: "(signal) => signal.subject === 'hello'",
      });
      expect(result).toEqual({
        success: true,
        purpose: "validate_ast",
        result: { valid: true },
      });
    });

    it("returns valid: false with error for eval() call", async () => {
      const result = await handler({
        tenantId: "acc_123",
        purpose: "validate_ast",
        functionCode: "(signal) => eval('1+1')",
      });
      expect(result).toEqual({
        success: true,
        purpose: "validate_ast",
        result: {
          valid: false,
          error: "eval() calls are not allowed",
          location: { line: 1, column: 12 },
        },
      });
    });

    it("returns valid: false for syntax errors", async () => {
      const result = await handler({
        tenantId: "acc_123",
        purpose: "validate_ast",
        functionCode: "}{][",
      });
      expect(result).toEqual({
        success: true,
        purpose: "validate_ast",
        result: {
          valid: false,
          error: expect.stringContaining("Unexpected token"),
          location: { line: 1, column: 0 },
        },
      });
    });

    it("does not require executionContext", async () => {
      const result = await handler({
        tenantId: "acc_123",
        purpose: "validate_ast",
        functionCode: "(signal) => true",
      });
      expect(result.success).toBe(true);
    });

    it("returns valid: false for non-function expression", async () => {
      const result = await handler({
        tenantId: "acc_123",
        purpose: "validate_ast",
        functionCode: "const x = 1;",
      });
      expect(result).toEqual({
        success: true,
        purpose: "validate_ast",
        result: {
          valid: false,
          error: expect.stringContaining("not allowed"),
        },
      });
    });
  });

  describe("validate_ast_batch purpose", () => {
    it("returns all valid for multiple valid functions", async () => {
      const result = await handler({
        tenantId: "acc_123",
        purpose: "validate_ast_batch",
        functions: [
          { name: "greeting", code: "(signal) => signal.from.name" },
          { name: "summary", code: "(signal, arc) => arc.summary" },
        ],
      });
      expect(result).toEqual({
        success: true,
        purpose: "validate_ast_batch",
        results: [
          { name: "greeting", valid: true },
          { name: "summary", valid: true },
        ],
      });
    });

    it("returns failure for the invalid function in a batch", async () => {
      const result = await handler({
        tenantId: "acc_123",
        purpose: "validate_ast_batch",
        functions: [
          { name: "good", code: "(signal) => signal.subject" },
          { name: "bad", code: "(signal) => eval('x')" },
        ],
      });
      expect(result).toEqual({
        success: true,
        purpose: "validate_ast_batch",
        results: [
          { name: "good", valid: true },
          { name: "bad", valid: false, error: "eval() calls are not allowed", location: { line: 1, column: 12 } },
        ],
      });
    });

    it("rejects missing functions array", async () => {
      const result = await handler({
        tenantId: "acc_123",
        purpose: "validate_ast_batch",
        functionCode: "(signal) => true",
      });
      expect(result).toEqual({
        success: false,
        error: { message: expect.stringContaining("functions is required"), type: "invalid_input" },
      });
    });

    it("rejects function with code exceeding max length", async () => {
      const result = await handler({
        tenantId: "acc_123",
        purpose: "validate_ast_batch",
        functions: [
          { name: "big", code: "x".repeat(10_001) },
        ],
      });
      expect(result).toEqual({
        success: false,
        error: { message: expect.stringContaining("exceeds maximum length"), type: "invalid_input" },
      });
    });
  });
});
