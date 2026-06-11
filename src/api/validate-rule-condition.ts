import jsonLogic from "json-logic-js";

/**
 * Validates a rule condition string before persisting.
 *
 * Returns null if valid, or an error message string if invalid.
 *
 * Conditions are either:
 * - JSONLogic (default): must be valid JSON that parses to a JSONLogic expression
 * - JavaScript (prefixed with "js:"): must be non-empty after the prefix
 */
export function validateRuleCondition(condition: string): string | null {
  if (condition.startsWith("js:")) {
    const code = condition.slice(3).trim();
    if (code.length === 0) {
      return "JS condition must contain code after the 'js:' prefix";
    }
    // JS conditions are validated at execution time by the User Code Executor sandbox.
    // We only check that the code is non-empty here — full AST validation would require
    // spinning up QuickJS which is too expensive for a synchronous API call.
    return null;
  }

  // JSONLogic condition — must be valid JSON and evaluable by json-logic-js
  let parsed: unknown;
  try {
    parsed = JSON.parse(condition);
  } catch {
    return "Condition is not valid JSON";
  }

  if (parsed === null || (typeof parsed !== "object" && typeof parsed !== "boolean" && typeof parsed !== "number" && typeof parsed !== "string")) {
    return "Condition must be a JSON object, boolean, number, or string";
  }

  // Dry-run the condition against an empty context to catch invalid operators.
  // json-logic-js throws on unrecognized operations.
  try {
    jsonLogic.apply(parsed as object, {});
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return `Invalid JSONLogic condition: ${message}`;
  }

  return null;
}
