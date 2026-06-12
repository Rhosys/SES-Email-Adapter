import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Static analysis helpers
// ---------------------------------------------------------------------------

const SRC_DIR = path.resolve(import.meta.dirname, "../src");

const EXCLUDED_FILES = new Set<string>([]);

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
const CONSOLE_EXCLUDED_FILES = new Set(["logger.ts"]);

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
// No .catch() in codebase
// ---------------------------------------------------------------------------

describe("No .catch() in codebase", () => {
  it("zero occurrences of .catch( in source files", () => {
    const violations = findPatternViolations(sourceFiles, /\.catch\(/);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No .andThen() / .mapErr() / Result .map() in codebase
// ---------------------------------------------------------------------------

describe("No .andThen() / .mapErr() in codebase", () => {
  it("zero occurrences of .andThen( in source files", () => {
    const violations = findPatternViolations(sourceFiles, /\.andThen\(/);
    expect(violations).toEqual([]);
  });

  it("zero occurrences of .mapErr( in source files", () => {
    const violations = findPatternViolations(sourceFiles, /\.mapErr\(/);
    expect(violations).toEqual([]);
  });

  it("zero occurrences of Result .map( in source files (excluding Array.map)", () => {
    const resultMapPattern = /[Rr]esult\w*\.map\(/;
    const violations = findPatternViolations(sourceFiles, resultMapPattern);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No direct console calls in source files
// ---------------------------------------------------------------------------

describe("No direct console calls in source files", () => {
  it("zero occurrences of console.log|error|warn outside logger.ts and test files", () => {
    const consolePattern = /\bconsole\.(log|error|warn)\b/;
    const violations = findPatternViolations(consoleCheckFiles, consolePattern);

    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${v.file}:${v.line} → ${v.content}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} direct console call(s):\n${details}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Vector columns must use toVector() — RDS Data API cannot implicitly cast
// ---------------------------------------------------------------------------

describe("Vector column writes use explicit toVector() cast", () => {
  it("arc-matcher.ts never assigns raw values to embedding column in DB operations", () => {
    const arcMatcherPath = path.resolve(SRC_DIR, "database/arc-matcher.ts");
    const content = fs.readFileSync(arcMatcherPath, "utf-8");
    const lines = content.split("\n");

    // Find all .values({ and .set({ blocks — these are Drizzle DB write sites
    const violations: Violation[] = [];
    let inDbWriteBlock = false;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Detect start of a Drizzle write block
      if (/\.(values|set)\(\{/.test(line)) {
        inDbWriteBlock = true;
        braceDepth = 0;
      }

      if (inDbWriteBlock) {
        for (const ch of line) {
          if (ch === "{") braceDepth++;
          if (ch === "}") braceDepth--;
        }

        // Check embedding assignments inside DB write blocks
        if (/\bembedding\s*:/.test(line) && !/toVector\(/.test(line) && !/sql`/.test(line) && !/EXCLUDED/.test(line)) {
          violations.push({
            file: "database/arc-matcher.ts",
            line: i + 1,
            content: line.trim(),
          });
        }

        if (braceDepth <= 0) inDbWriteBlock = false;
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${v.file}:${v.line} → ${v.content}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} raw embedding assignment(s) without toVector() in DB write operations:\n${details}\n\nAll embedding writes must use toVector() to ensure explicit ::vector cast for RDS Data API compatibility.`,
      );
    }
  });
});
