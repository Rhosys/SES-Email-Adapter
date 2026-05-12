import type { RuleEvaluator } from "./processor.js";
import type { Rule, Signal, Arc } from "../types/index.js";
import type { Logger } from "../logger.js";
import { evalCondition } from "./rule-engine.js";

export class JsonLogicRuleEvaluator implements RuleEvaluator {
  constructor(private readonly logger: Logger) {}

  async evaluate(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): Promise<boolean> {
    try {
      return await evalCondition(rule.condition, context);
    } catch {
      this.logger.warn("Rule condition evaluation threw an exception. The json-logic engine failed to evaluate the condition expression. The rule will be treated as non-matching and processing continues. Check the rule condition syntax for this ruleId.", { code: "rule_evaluator.condition.failed", ruleId: rule.id, condition: rule.condition });
      return false;
    }
  }
}
