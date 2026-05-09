import type { RuleEvaluator } from "./processor.js";
import type { Rule, Signal, Arc } from "../types/index.js";
import { evalCondition } from "./rule-engine.js";

export class JsonLogicRuleEvaluator implements RuleEvaluator {
  async evaluate(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): Promise<boolean> {
    try {
      return await evalCondition(rule.condition, context);
    } catch {
      console.error(`Rule ${rule.id} condition evaluation failed:`, rule.condition);
      return false;
    }
  }
}
