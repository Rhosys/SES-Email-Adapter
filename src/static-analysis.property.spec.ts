import { describe, it, expect } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import path from "node:path";
import { propertyRunner } from "./testing/property-runner.js";

// ---------------------------------------------------------------------------
// Static analysis helpers
// ---------------------------------------------------------------------------

const SRC_DIR = path.resolve(import.meta.dirname, ".");

const EXCLUDED_FILES = new Set([
  "authorization-middleware.ts",
  "authorization-guard.ts",
  "validate.ts",
]);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path.join(dir, entry.name)));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !EXCLUDED_FILES.has(entry.name)
    ) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

interface Violation {
  file: string;
  line: number;
  content: string;
}

function findPatternViolations(files: string[], pattern: RegExp): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        violations.push({
          file: path.relative(SRC_DIR, file),
          line: i + 1,
          content: lines[i]!.trim(),
        });
      }
    }
  }
  return violations;
}

const sourceFiles = collectSourceFiles(SRC_DIR);

// ---------------------------------------------------------------------------
// Console-free source file collection (excludes logger.ts and testing/)
// ---------------------------------------------------------------------------

const CONSOLE_EXCLUDED_DIRS = new Set(["testing"]);
const CONSOLE_EXCLUDED_FILES = new Set(["logger.ts", "run-migration.ts"]);

function collectConsoleCheckFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (CONSOLE_EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...collectConsoleCheckFiles(path.join(dir, entry.name)));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !CONSOLE_EXCLUDED_FILES.has(entry.name)
    ) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const consoleCheckFiles = collectConsoleCheckFiles(SRC_DIR);

// ---------------------------------------------------------------------------
// Property 3: No `.catch()` in codebase (static analysis property)
// The codebase contains zero occurrences of `.catch(` outside of test files
// and Hono middleware.
// **Validates: Requirements 5.4**
// ---------------------------------------------------------------------------

describe("Property 3: No .catch() in codebase", () => {
  it("zero occurrences of .catch( in source files", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const violations = findPatternViolations(sourceFiles, /\.catch\(/);
        expect(violations).toEqual([]);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: No .andThen() / .mapErr() in codebase, and no Result .map()
// The codebase contains zero occurrences of `.andThen(`, `.mapErr(` on
// Result/ResultAsync values. For `.map(`, only flag it if it appears to be
// on a Result/ResultAsync value (not Array.map).
// **Validates: Requirements 9.1, 9.2, 9.3**
// ---------------------------------------------------------------------------

describe("Property 4: No .andThen() / .mapErr() in codebase", () => {
  it("zero occurrences of .andThen( in source files", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const violations = findPatternViolations(sourceFiles, /\.andThen\(/);
        expect(violations).toEqual([]);
      }),
    );
  });

  it("zero occurrences of .mapErr( in source files", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const violations = findPatternViolations(sourceFiles, /\.mapErr\(/);
        expect(violations).toEqual([]);
      }),
    );
  });

  it("zero occurrences of Result .map( in source files (excluding Array.map)", async () => {
    // Flag .map( only when preceded by a Result-like variable pattern:
    // e.g. `result.map(`, `xResult.map(`, or chained after ResultAsync methods
    // We look for `Result` or `result` identifiers followed by .map(
    const resultMapPattern = /[Rr]esult\w*\.map\(/;

    await propertyRunner.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const violations = findPatternViolations(sourceFiles, resultMapPattern);
        expect(violations).toEqual([]);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// No console.log/error/warn in source files (excluding logger.ts and tests)
// After the structured logging migration, all logging must go through the
// RequestLogger class. Direct console calls are forbidden in production code.
// **Validates: Requirements 8.1, 8.2**
// ---------------------------------------------------------------------------

describe("No direct console calls in source files", () => {
  const consolePattern = /\bconsole\.(log|error|warn)\b/;

  it("zero occurrences of console.log|error|warn outside logger.ts and test files", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const violations = findPatternViolations(consoleCheckFiles, consolePattern);

        if (violations.length > 0) {
          const details = violations
            .map((v) => `  ${v.file}:${v.line} → ${v.content}`)
            .join("\n");
          expect.fail(
            `Found ${violations.length} direct console call(s):\n${details}`,
          );
        }
      }),
    );
  });
});
