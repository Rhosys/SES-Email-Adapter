import { describe, it, expect } from "vitest";
import { validateCodeAst } from "../../src/api/ast-validator.js";

describe("validateCodeAst", () => {
  describe("allowed constructs — accepted when wrapped in a valid function", () => {
    const acceptedCases = [
      { scenario: "arrow function with expression body", code: "(signal, arc) => signal.spamScore > 0.5" },
      { scenario: "arrow function with block body", code: "(signal, arc) => { return signal.spamScore > 0.5; }" },
      { scenario: "function expression", code: "function(signal, arc) { return signal.spamScore > 0.5; }" },
      { scenario: "conditional expression (ternary)", code: "(signal) => signal.spamScore > 0.5 ? true : null" },
      { scenario: "logical operators (&&, ||, ??)", code: "(signal) => signal.workflow === 'payments' && signal.spamScore < 0.3 || null" },
      { scenario: "property access on signal", code: "(signal) => signal.from.address" },
      { scenario: "property access on arc", code: "(signal, arc) => arc.labels.includes('important')" },
      { scenario: "string method call", code: "(signal) => signal.subject.toLowerCase().includes('invoice')" },
      { scenario: "array method call", code: "(signal, arc) => arc.labels.filter(l => l !== 'spam')" },
      { scenario: "template literal", code: "(signal) => `Score: ${signal.spamScore}`" },
      { scenario: "object expression", code: "(signal) => ({ type: 'archive', value: signal.id })" },
      { scenario: "array expression", code: "(signal) => [signal.id, signal.subject]" },
      { scenario: "const declaration", code: "(signal) => { const score = signal.spamScore; return score > 0.5; }" },
      { scenario: "let declaration", code: "(signal) => { let result = null; if (signal.spamScore > 0.5) { result = true; } return result; }" },
      { scenario: "if/else statement", code: "(signal) => { if (signal.workflow === 'payments') { return true; } else { return null; } }" },
      { scenario: "destructuring (object pattern)", code: "({ from, subject }) => from.address.endsWith('@bank.com')" },
      { scenario: "destructuring with default (AssignmentPattern)", code: "({ spamScore = 0 }) => spamScore > 0.5" },
      { scenario: "unary expression (negation, typeof)", code: "(signal) => !signal.spamScore || typeof signal.workflow === 'string'" },
      { scenario: "binary expression (arithmetic)", code: "(signal) => signal.spamScore * 100 > 50" },
      { scenario: "spread element in array", code: "(signal, arc) => [...arc.labels, 'new']" },
      { scenario: "spread element in object", code: "(signal) => ({ ...signal.from, extra: true })" },
      { scenario: "optional chaining", code: "(signal) => signal.workflowData?.category" },
      { scenario: "nullish coalescing", code: "(signal) => signal.workflowData ?? {}" },
      { scenario: "bounded for loop (numeric literal in test)", code: "(signal, arc) => { const items = arc.labels; let count = 0; for (let i = 0; i < 10; i++) { count++; } return count; }" },
      { scenario: "while loop with break", code: "(signal) => { let i = 0; while (true) { if (i > 5) break; i++; } return i; }" },
      { scenario: "for-of loop (finite iteration)", code: "(signal, arc) => { let found = false; for (const label of arc.labels) { if (label === 'urgent') found = true; } return found; }" },
    ];

    it.each(acceptedCases)("accepts: $scenario", ({ code }) => {
      const result = validateCodeAst(code);
      expect(result).toEqual({ valid: true });
    });
  });

  describe("rejected constructs — disallowed AST nodes", () => {
    const rejectedCases = [
      { scenario: "eval() call", code: "(signal) => eval('signal.spamScore')", expectedSubstring: "eval()" },
      { scenario: "Function constructor (call)", code: "(signal) => Function('return signal')()", expectedSubstring: "Function constructor" },
      { scenario: "Function constructor (new)", code: "(signal) => new Function('return signal')()", expectedSubstring: "Function constructor" },
      { scenario: "import() expression", code: "(signal) => import('fs')", expectedSubstring: "import()" },
      { scenario: "require() call", code: "(signal) => require('fs')", expectedSubstring: "require()" },
      { scenario: "globalThis access", code: "(signal) => globalThis.setTimeout(() => {}, 0)", expectedSubstring: "globalThis" },
      { scenario: "process access", code: "(signal) => process.env.SECRET", expectedSubstring: "process" },
      { scenario: "Deno access", code: "(signal) => Deno.readFile('/etc/passwd')", expectedSubstring: "Deno" },
      { scenario: "Bun access", code: "(signal) => Bun.file('/etc/passwd')", expectedSubstring: "Bun" },
      { scenario: "unbounded while loop (no numeric limit, no break)", code: "(signal) => { let x = 0; while (x < signal.spamScore) { x++; } return x; }", expectedSubstring: "Unbounded WhileStatement" },
      { scenario: "unbounded for loop (no numeric limit)", code: "(signal) => { for (let i = 0; i < signal.count; i++) {} return true; }", expectedSubstring: "Unbounded ForStatement" },
      { scenario: "unbounded do-while loop", code: "(signal) => { let x = 0; do { x++; } while (x < signal.count); return x; }", expectedSubstring: "Unbounded DoWhileStatement" },
      { scenario: "var declaration", code: "(signal) => { var x = 1; return x; }", expectedSubstring: "'var' declarations are not allowed" },
    ];

    it.each(rejectedCases)("rejects: $scenario", ({ code, expectedSubstring }) => {
      const result = validateCodeAst(code);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain(expectedSubstring);
      }
    });
  });

  describe("structural rejections — invalid top-level forms", () => {
    const structuralCases = [
      { scenario: "class declaration", code: "class Foo { bar() {} }", expectedSubstring: "Class" },
      { scenario: "bare statement (variable declaration)", code: "const x = 5;", expectedSubstring: "VariableDeclaration is not allowed" },
      { scenario: "assignment expression", code: "x = (signal) => signal.spamScore", expectedSubstring: "AssignmentExpression is not allowed" },
      { scenario: "numeric literal", code: "42", expectedSubstring: "Literal is not allowed" },
      { scenario: "string literal", code: "'hello'", expectedSubstring: "Literal is not allowed" },
      { scenario: "multiple statements", code: "const a = 1; const b = 2;", expectedSubstring: "must be a single function expression" },
      { scenario: "call expression (not a function def)", code: "console.log('hi')", expectedSubstring: "CallExpression is not allowed" },
    ];

    it.each(structuralCases)("rejects: $scenario", ({ code, expectedSubstring }) => {
      const result = validateCodeAst(code);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain(expectedSubstring);
      }
    });
  });

  describe("syntax errors — malformed code returns error with location", () => {
    it("reports parse error with line and column for missing closing paren", () => {
      const result = validateCodeAst("(signal => { return signal.spamScore");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.location).toBeDefined();
        expect(result.location!.line).toBeGreaterThanOrEqual(1);
        expect(result.location!.column).toBeGreaterThanOrEqual(0);
      }
    });

    it("reports parse error for completely invalid syntax", () => {
      const result = validateCodeAst("}{][");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.location).toBeDefined();
      }
    });

    it("reports parse error for unterminated string", () => {
      const result = validateCodeAst("(signal) => signal.subject.includes('unterminated");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.location).toBeDefined();
      }
    });
  });
});
