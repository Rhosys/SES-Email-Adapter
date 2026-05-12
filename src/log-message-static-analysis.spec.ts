import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Static analysis helpers
// ---------------------------------------------------------------------------

const SRC_DIR = path.resolve(import.meta.dirname, ".");

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path.join(dir, entry.name)));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".property.spec.ts") &&
      entry.name !== "logger.ts"
    ) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const sourceFiles = collectSourceFiles(SRC_DIR);

// ---------------------------------------------------------------------------
// Property 3: No terse-only messages at TRACK/WARN/ERROR/CRITICAL level
// Every call to .track(), .warn(), .error(), or .critical() SHALL have a
// message argument that contains at least one space character.
// **Validates: Requirements 6.1, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8**
// ---------------------------------------------------------------------------

describe("Property 3: No terse-only messages at TRACK/WARN/ERROR/CRITICAL level", () => {
  it("all TRACK/WARN/ERROR/CRITICAL messages contain at least one space", () => {
    // Placeholder for task 7.1
  });
});

// ---------------------------------------------------------------------------
// Property 4: All TRACK/WARN/ERROR/CRITICAL calls include a code field
// Every call to .track(), .warn(), .error(), or .critical() that passes a
// context object SHALL include a `code` field in that context object.
// **Validates: Requirements 6.2**
// ---------------------------------------------------------------------------

describe("Property 4: All TRACK/WARN/ERROR/CRITICAL calls include a code field", () => {
  it("every .track()/.warn()/.error()/.critical() call with a context object includes code field", () => {
    interface Violation {
      file: string;
      line: number;
      content: string;
    }

    const violations: Violation[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        // Match log calls: .track(, .warn(, .error(, .critical(
        // Also match optional chaining: ?.track(, ?.warn(, etc.
        const logCallMatch = line.match(/\.\??(?:track|warn|error|critical)\(/);
        if (!logCallMatch) continue;

        // Check if this call has a context object (second argument).
        // We look for a `{` after the first string argument on the same line or subsequent lines.
        // Strategy: extract from the log call opening to the closing, looking for a context object with `code`.

        // Find the content from this log call through the next few lines to capture multi-line calls
        const callStart = i;
        let callContent = "";
        let braceDepth = 0;
        let parenDepth = 0;
        let foundOpenParen = false;
        let callComplete = false;

        for (let j = callStart; j < Math.min(callStart + 15, lines.length); j++) {
          const scanLine = j === callStart ? lines[j]!.slice(lines[j]!.indexOf(logCallMatch[0]!)) : lines[j]!;
          callContent += scanLine + "\n";

          for (const ch of scanLine) {
            if (ch === "(") {
              parenDepth++;
              foundOpenParen = true;
            } else if (ch === ")") {
              parenDepth--;
              if (foundOpenParen && parenDepth === 0) {
                callComplete = true;
                break;
              }
            } else if (ch === "{") {
              braceDepth++;
            } else if (ch === "}") {
              braceDepth--;
            }
          }
          if (callComplete) break;
        }

        if (!callComplete) continue;

        // Check if there's a context object (second argument with `{`)
        // A context object is present if after the first string argument there's a `,` followed by `{`
        // The first argument is a string (quoted with " or ` or ')
        // We look for pattern: message-string, { ... }
        const hasContextObject = /\.\??(?:track|warn|error|critical)\([^)]*,\s*\{/.test(callContent.replace(/\n/g, " ")) ||
          /\.\??(?:track|warn|error|critical)\([\s\S]*?,\s*\{/.test(callContent);

        if (!hasContextObject) continue;

        // Now check if the context object contains a `code` field
        // Look for `code:` or `code :` within the braces of the context object
        const hasCodeField = /\bcode\s*:/.test(callContent);

        if (!hasCodeField) {
          violations.push({
            file: path.relative(SRC_DIR, file),
            line: i + 1,
            content: line.trim(),
          });
        }
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${v.file}:${v.line} → ${v.content}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} TRACK/WARN/ERROR/CRITICAL call(s) with context object but missing 'code' field:\n${details}`,
      );
    }

    expect(violations).toEqual([]);
  });
});
