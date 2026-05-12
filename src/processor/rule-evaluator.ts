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
      this.logger.warn("rule-evaluator.condition.failed", { ruleId: rule.id, condition: rule.condition });
      return false;
    }
  }
}
