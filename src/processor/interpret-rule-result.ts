import { z } from "zod";
import { RULE_ACTION_TYPES } from "../types/index.js";
import type { RuleAction } from "../types/index.js";

// ---------------------------------------------------------------------------
// Zod schema for validating dynamic RuleAction objects returned by user code
// ---------------------------------------------------------------------------

export const RuleActionSchema = z.object({
  type: z.enum(RULE_ACTION_TYPES),
  value: z.string().optional(),
  disabled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Structured result from interpreting user code return values
// ---------------------------------------------------------------------------

export interface RuleEvalResult {
  matched: boolean;
  dynamicActions: RuleAction[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Interpret the raw return value from user code execution
// ---------------------------------------------------------------------------

export function interpretRuleResult(raw: unknown): RuleEvalResult {
  // Case 1: null/undefined → non-matching
  if (raw === null || raw === undefined) {
    return { matched: false, dynamicActions: [], warnings: [] };
  }

  // Case 3: Array → matching, validate each element
  if (Array.isArray(raw)) {
    const dynamicActions: RuleAction[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < raw.length; i++) {
      const result = RuleActionSchema.safeParse(raw[i]);
      if (result.success) {
        dynamicActions.push(result.data as RuleAction);
      } else {
        warnings.push(`Element [${i}] is not a valid RuleAction: ${result.error.issues.map(issue => issue.message).join(", ")}`);
      }
    }

    return { matched: true, dynamicActions, warnings };
  }

  // Case 2: Single object with a valid `type` → validate as RuleAction
  if (typeof raw === "object" && raw !== null && "type" in raw) {
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.type === "string" && (RULE_ACTION_TYPES as readonly string[]).includes(candidate.type)) {
      const result = RuleActionSchema.safeParse(raw);
      if (result.success) {
        return { matched: true, dynamicActions: [result.data as RuleAction], warnings: [] };
      }
      // Has a valid type but fails full validation — still matching, warn
      const warnings = [`RuleAction validation failed: ${result.error.issues.map(issue => issue.message).join(", ")}`];
      return { matched: true, dynamicActions: [], warnings };
    }
  }

  // Case 4: Any other truthy value → matching with no dynamic actions
  return { matched: true, dynamicActions: [], warnings: [] };
}
