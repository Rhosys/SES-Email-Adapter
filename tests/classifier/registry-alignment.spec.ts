import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLASSIFIER_WORKFLOW_REGISTRY, EnumValue } from "../../src/types/workflow-registry.js";
import { WORKFLOWS } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Parse TypeScript source to extract interface field definitions
// ---------------------------------------------------------------------------

const TYPES_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../../src/types/index.ts"),
  "utf-8",
);

/** Map workflow name → expected interface name (e.g. "auth" → "AuthData") */
function workflowToInterfaceName(workflow: string): string {
  const capitalized = workflow.charAt(0).toUpperCase() + workflow.slice(1);
  return `${capitalized}Data`;
}

/** Extract the body of an interface block from the source */
function extractInterfaceBody(interfaceName: string): string {
  const pattern = new RegExp(
    `export interface ${interfaceName}\\s*\\{([\\s\\S]*?)^\\}`,
    "m",
  );
  const match = TYPES_SOURCE.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Interface ${interfaceName} not found in src/types/index.ts`);
  }
  return match[1];
}

interface ParsedField {
  name: string;
  required: boolean;
  type: "string" | "number" | "boolean" | "enum" | "array";
  enumValues?: string[];
}

/**
 * Collapse multi-line field definitions into single logical lines.
 * Handles cases like:
 *   alertType:
 *     | "suspicious_login" | "new_device"
 *     | "other";
 */
function collapseMultilineFields(body: string): string[] {
  const raw = body.split("\n");
  const collapsed: string[] = [];
  let buffer = "";

  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    // A new field starts with `word:` or `word?:`
    if (/^\w+\??:/.test(trimmed)) {
      if (buffer) collapsed.push(buffer);
      buffer = trimmed;
    } else if (buffer) {
      // Continuation line (e.g. `| "value"`)
      buffer += " " + trimmed;
    }
  }
  if (buffer) collapsed.push(buffer);

  return collapsed;
}

/** Parse fields from an interface body string */
function parseInterfaceFields(body: string): ParsedField[] {
  const fields: ParsedField[] = [];
  const lines = collapseMultilineFields(body);

  for (const line of lines) {
    // Skip the workflow discriminator field
    if (line.startsWith("workflow")) continue;

    // Match: fieldName?: type; or fieldName: type;
    const fieldMatch = line.match(/^(\w+)(\??):\s*(.+?);?\s*(?:\/\/.*)?$/);
    if (!fieldMatch) continue;

    const [, name, optional, rawType] = fieldMatch;
    if (!name || !rawType) continue;

    const required = optional !== "?";

    // Determine the field type category
    if (rawType === "boolean") {
      fields.push({ name, required, type: "boolean" });
    } else if (rawType === "number") {
      fields.push({ name, required, type: "number" });
    } else if (rawType === "string") {
      fields.push({ name, required, type: "string" });
    } else if (rawType.startsWith("Array<") || rawType.endsWith("[]")) {
      fields.push({ name, required, type: "array" });
    } else if (rawType.includes("|")) {
      // Enum-like union of string literals
      const enumValues = rawType
        .split("|")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter((v) => v.length > 0);
      fields.push({ name, required, type: "enum", enumValues });
    } else {
      // Default to string for unknown types
      fields.push({ name, required, type: "string" });
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Tests — EnumValue description coverage
// ---------------------------------------------------------------------------

describe("EnumValue description coverage", () => {
  for (const workflow of CLASSIFIER_WORKFLOW_REGISTRY) {
    for (const field of workflow.fields) {
      if (!field.enumValues) continue;

      it(`${workflow.name}.${field.name}: every enum value is an EnumValue instance`, () => {
        for (const ev of field.enumValues!) {
          expect(ev).toBeInstanceOf(EnumValue);
        }
      });

      it(`${workflow.name}.${field.name}: every EnumValue has a non-empty description`, () => {
        for (const ev of field.enumValues!) {
          const enumVal = ev as EnumValue;
          expect(enumVal.description.length, `${workflow.name}.${field.name}="${enumVal.value}" has empty description`).toBeGreaterThan(0);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Tests — registry ↔ TypeScript type alignment
// ---------------------------------------------------------------------------

describe("workflow registry ↔ TypeScript type alignment", () => {
  it("registry covers every workflow in WORKFLOWS (except system-only workflows)", () => {
    const registryNames = CLASSIFIER_WORKFLOW_REGISTRY.map((w) => w.name);
    const systemOnlyWorkflows = new Set(["unspecified"]);
    for (const workflow of WORKFLOWS) {
      if (systemOnlyWorkflows.has(workflow)) continue;
      expect(registryNames).toContain(workflow);
    }
  });

  it("registry contains no workflows absent from WORKFLOWS", () => {
    const workflowSet = new Set<string>(WORKFLOWS);
    for (const entry of CLASSIFIER_WORKFLOW_REGISTRY) {
      expect(workflowSet.has(entry.name)).toBe(true);
    }
  });

  // Per-workflow field alignment
  for (const entry of CLASSIFIER_WORKFLOW_REGISTRY) {
    describe(`${entry.name} (${workflowToInterfaceName(entry.name)})`, () => {
      const interfaceName = workflowToInterfaceName(entry.name);
      const body = extractInterfaceBody(interfaceName);
      const tsFields = parseInterfaceFields(body);
      const tsFieldMap = new Map(tsFields.map((f) => [f.name, f]));
      const registryFieldMap = new Map(entry.fields.map((f) => [f.name, f]));

      it("registry fields match TypeScript interface fields (no missing, no extra)", () => {
        const tsFieldNames = new Set(tsFields.map((f) => f.name));
        const registryFieldNames = new Set(entry.fields.map((f) => f.name));

        const missingInRegistry = [...tsFieldNames].filter((n) => !registryFieldNames.has(n));
        const extraInRegistry = [...registryFieldNames].filter((n) => !tsFieldNames.has(n));

        expect(missingInRegistry, `Fields in TypeScript but missing from registry`).toEqual([]);
        expect(extraInRegistry, `Fields in registry but missing from TypeScript`).toEqual([]);
      });

      it("field required/optional markers match", () => {
        for (const registryField of entry.fields) {
          const tsField = tsFieldMap.get(registryField.name);
          if (!tsField) continue; // Covered by the field-existence test above

          expect(
            registryField.required,
            `${entry.name}.${registryField.name} required mismatch`,
          ).toBe(tsField.required);
        }
      });

      it("field types match", () => {
        // Fields intentionally widened to string in TypeScript while keeping enum guidance in the registry prompt
        const FLEXIBLE_ENUM_FIELDS = new Set(["alertType"]);

        for (const registryField of entry.fields) {
          const tsField = tsFieldMap.get(registryField.name);
          if (!tsField) continue;

          if (FLEXIBLE_ENUM_FIELDS.has(registryField.name) && registryField.type === "enum" && tsField.type === "string") {
            continue; // Intentionally widened — registry enums are LLM guidance only
          }

          // Number fields in the registry are stored as string in TypeScript —
          // the LLM is asked for numbers to encourage numeric output, but coercion
          // converts them to strings at the classifier boundary before storage.
          if (registryField.type === "number" && tsField.type === "string") {
            continue;
          }

          expect(
            registryField.type,
            `${entry.name}.${registryField.name} type mismatch`,
          ).toBe(tsField.type);
        }
      });

      it("enum values match exactly", () => {
        // Fields intentionally widened to string in TypeScript while keeping enum guidance in the registry prompt
        const FLEXIBLE_ENUM_FIELDS = new Set(["alertType"]);

        for (const registryField of entry.fields) {
          if (registryField.type !== "enum") continue;
          if (FLEXIBLE_ENUM_FIELDS.has(registryField.name)) continue;

          const tsField = tsFieldMap.get(registryField.name);
          if (!tsField || tsField.type !== "enum") continue;

          const registryEnums = [...(registryField.enumValues ?? [])].map((v) => v instanceof EnumValue ? v.value : v).sort();
          const tsEnums = [...(tsField.enumValues ?? [])].sort();

          expect(
            registryEnums,
            `${entry.name}.${registryField.name} enum values diverge`,
          ).toEqual(tsEnums);
        }
      });
    });
  }
});
