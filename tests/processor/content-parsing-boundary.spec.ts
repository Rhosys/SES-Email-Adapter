import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

const PROCESSOR_DIR = path.resolve(import.meta.dirname, "../../src/processor");

const BANNED_MODULES = new Set([
  "jsqr", "pngjs", "jpeg-js", "jszip",
  "mailparser", "dompurify", "happy-dom",
]);

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

function extractValueImportModules(filePath: string): Array<{ module: string; line: number }> {
  const source = fs.readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: Array<{ module: string; line: number }> = [];

  ts.forEachChild(sourceFile, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.importClause?.isTypeOnly) return;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      imports.push({ module: node.moduleSpecifier.text, line });
    }
  });

  return imports;
}

describe("content-parsing security boundary", () => {
  it("src/processor/ files do not import content-parsing libraries", () => {
    const files = collectTsFiles(PROCESSOR_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const filePath of files) {
      const imports = extractValueImportModules(filePath);
      for (const imp of imports) {
        if (imp.module.startsWith("type ")) continue;
        const bare = imp.module.replace(/^node:/, "");
        if (BANNED_MODULES.has(bare)) {
          const rel = path.relative(path.resolve(PROCESSOR_DIR, ".."), filePath);
          violations.push(`${rel}:${imp.line} imports "${imp.module}"`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        "Content-parsing libraries must not be imported in src/processor/ (ADR 011).\n" +
        "Move parsing logic to src/isolated/ and return results via the sanitizer response.\n\n" +
        "Violations:\n" + violations.map(v => `  - ${v}`).join("\n"),
      );
    }
  });

  it("type-only imports from banned modules are allowed", () => {
    const source = `import type { ParsedMime } from "./mime.js";\nimport { ok } from "../errors.js";\n`;
    const sourceFile = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports: string[] = [];

    ts.forEachChild(sourceFile, node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.importClause?.isTypeOnly) {
          imports.push(node.moduleSpecifier.text);
        }
      }
    });

    expect(imports).not.toContain("./mime.js");
    expect(imports).toContain("../errors.js");
  });
});
