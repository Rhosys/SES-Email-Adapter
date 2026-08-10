import type { Logger } from "../logger.js";
import { CLASSIFIER_WORKFLOW_REGISTRY } from "../types/workflow-registry.js";

/**
 * Coerces raw LLM workflowData fields to their declared types.
 *
 * LLMs output JSON — but they don't reliably distinguish between:
 * - `0` and `"0"` (number vs string)
 * - `true` and `"true"` (boolean vs string)
 * - `2` and `"2"` or `"two"` (numeric string variations)
 *
 * This module applies deterministic coercion at the classifier output boundary.
 * If a value cannot be deterministically coerced, it is nullified and a TRACK
 * log is emitted for follow-up investigation.
 *
 * Rules:
 * - string fields: accept string, number, boolean → String(). Reject objects/arrays.
 * - number fields (amounts, counts): accept number or numeric string → String().
 *   These are stored as strings because the LLM cannot reliably output numbers.
 *   Non-numeric strings (e.g. "two", "CHF 5") → null + TRACK.
 * - boolean fields: accept true/false, "true"/"false", 1/0, "1"/"0", "yes"/"no" → boolean.
 *   Anything else → null + TRACK.
 * - array fields: accept arrays, pass through. Non-arrays → null + TRACK.
 * - enum fields: accept only declared enum values. Anything else → null + TRACK.
 */

interface FieldSpec {
  name: string;
  type: string;
  required: boolean;
  enumValues?: Array<{ value: string }>;
}

/** Build a lookup from workflow name → field specs for fast access. */
const WORKFLOW_FIELDS: Map<string, FieldSpec[]> = new Map(
  CLASSIFIER_WORKFLOW_REGISTRY.map(w => [w.name, w.fields]),
);

/**
 * Coerces a numeric-like value to a string representation suitable for storage.
 * Accepts: number, or string that parses to a finite number.
 * Returns null if the value cannot be deterministically converted.
 */
function coerceNumericToString(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Try parsing as a number — handles "0", "149.00", "1,234.56" (after comma removal)
    const normalized = trimmed.replace(/,/g, "");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return String(parsed);
    return null;
  }
  return null;
}

/**
 * Coerces a boolean-like value to an actual boolean.
 * Accepts: boolean, "true"/"false", "yes"/"no", 1/0, "1"/"0".
 * Returns null if the value cannot be deterministically converted.
 */
function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "1") return true;
    if (lower === "false" || lower === "no" || lower === "0") return false;
    return null;
  }
  return null;
}

/**
 * Coerces a value to string. Accepts primitives — rejects objects/arrays.
 */
function coerceString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

interface CoercionContext {
  signalId?: string | undefined;
  accountId?: string | undefined;
  workflow: string;
}

/**
 * Coerces raw workflowData fields based on the workflow registry type declarations.
 * Mutates the input record in place.
 */
export function coerceWorkflowData(
  workflowData: Record<string, unknown>,
  workflow: string,
  logger: Logger,
  ctx: CoercionContext,
): void {
  const fields = WORKFLOW_FIELDS.get(workflow);
  if (!fields) return;

  for (const field of fields) {
    if (!(field.name in workflowData)) continue;
    const raw = workflowData[field.name];
    if (raw === null || raw === undefined) {
      // Already null/undefined — leave as-is (will be omitted in output)
      continue;
    }

    switch (field.type) {
      case "string": {
        if (field.enumValues) {
          // Enum field — must match a declared value exactly (case-insensitive match → store canonical)
          const coerced = coerceEnumValue(raw, field.enumValues);
          if (coerced === null) {
            logger.track("Classifier returned invalid enum value — nullified.", {
              code: "classifier.coercion_failed",
              field: field.name,
              value: raw,
              expectedValues: field.enumValues.map(e => e.value),
              ...ctx,
            });
            workflowData[field.name] = null;
          } else {
            workflowData[field.name] = coerced;
          }
        } else {
          const coerced = coerceString(raw);
          if (coerced === null) {
            logger.track("Classifier returned non-coercible value for string field — nullified.", {
              code: "classifier.coercion_failed",
              field: field.name,
              value: raw,
              ...ctx,
            });
            workflowData[field.name] = null;
          } else {
            workflowData[field.name] = coerced;
          }
        }
        break;
      }

      case "enum": {
        const coerced = coerceEnumValue(raw, field.enumValues ?? []);
        if (coerced === null) {
          logger.track("Classifier returned invalid enum value — nullified.", {
            code: "classifier.coercion_failed",
            field: field.name,
            value: raw,
            expectedValues: (field.enumValues ?? []).map(e => e.value),
            ...ctx,
          });
          workflowData[field.name] = null;
        } else {
          workflowData[field.name] = coerced;
        }
        break;
      }

      case "number": {
        // Numbers from the LLM are stored as strings — see design doc.
        const coerced = coerceNumericToString(raw);
        if (coerced === null) {
          logger.track("Classifier returned non-numeric value for number field — nullified.", {
            code: "classifier.coercion_failed",
            field: field.name,
            value: raw,
            ...ctx,
          });
          workflowData[field.name] = null;
        } else {
          workflowData[field.name] = coerced;
        }
        break;
      }

      case "boolean": {
        const coerced = coerceBoolean(raw);
        if (coerced === null) {
          logger.track("Classifier returned non-boolean value for boolean field — nullified.", {
            code: "classifier.coercion_failed",
            field: field.name,
            value: raw,
            ...ctx,
          });
          workflowData[field.name] = null;
        } else {
          workflowData[field.name] = coerced;
        }
        break;
      }

      case "array": {
        if (!Array.isArray(raw)) {
          logger.track("Classifier returned non-array value for array field — nullified.", {
            code: "classifier.coercion_failed",
            field: field.name,
            value: raw,
            ...ctx,
          });
          workflowData[field.name] = null;
        }
        // Arrays pass through as-is — inner element coercion is out of scope
        // (items are typed loosely in the registry as notes)
        break;
      }

      default:
        // Unknown type in registry — pass through without coercion
        break;
    }
  }
}

function coerceEnumValue(raw: unknown, enumValues: Array<{ value: string }>): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  for (const ev of enumValues) {
    if (ev.value.toLowerCase() === trimmed) return ev.value;
  }
  return null;
}

// Exported for testing
export { coerceNumericToString, coerceBoolean, coerceString };
