import jsonLogic from "json-logic-js";
import type { RuleEvaluator } from "./processor.js";
import type { Rule, Signal, Arc } from "../types/index.js";

export class JsonLogicRuleEvaluator implements RuleEvaluator {
  evaluate(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): boolean {
    try {
      const condition = JSON.parse(rule.condition) as object;
      return Boolean(jsonLogic.apply(condition, context));
    } catch {
      console.error(`Rule ${rule.id} has invalid JSONLogic condition:`, rule.condition);
      return false;
    }
  }
}
