import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

/**
 * This test uses the TypeScript compiler API to parse all project .ts files
 * and detect any usage of synchronous methods (functions ending in "Sync").
 * Synchronous I/O is never allowed in this codebase — all I/O must be async.
 * This test MUST NOT be modified to add exclusions.
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".spec.ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

interface SyncViolation {
  file: string;
  line: number;
  methodName: string;
  text: string;
}

function findSyncCalls(filePath: string, source: string): SyncViolation[] {
  const violations: SyncViolation[] = [];
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, true);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      let methodName: string | undefined;

      // Handle property access: fs.readFileSync(...)
      if (ts.isPropertyAccessExpression(node.expression)) {
        methodName = node.expression.name.text;
      }
      // Handle direct call: readFileSync(...)
      else if (ts.isIdentifier(node.expression)) {
        methodName = node.expression.text;
      }

      if (methodName && methodName.endsWith("Sync")) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        violations.push({
          file: path.relative(PROJECT_ROOT, filePath),
          line: line + 1,
          methodName,
          text: node.getText(sourceFile).slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return violations;
}

describe("No synchronous fs methods in source code", () => {
  it("zero calls to *Sync() methods anywhere in the project — async is mandatory, no exclusions ever", async () => {
    const files = await collectTsFiles(PROJECT_ROOT);
    const allViolations: SyncViolation[] = [];

    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      allViolations.push(...findSyncCalls(file, content));
    }

    if (allViolations.length > 0) {
      const details = allViolations
        .map((v) => `  ${v.file}:${v.line} — ${v.methodName}(): ${v.text}`)
        .join("\n");
      expect.fail(
        `Found ${allViolations.length} synchronous method call(s) in project:\n${details}\n\n` +
        "Synchronous I/O is NEVER allowed. Use async alternatives (fs/promises, async child_process).\n" +
        "This test cannot be modified to add exclusions.",
      );
    }
  });
});
