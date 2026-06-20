import type { RuleEvaluator } from "./processor.js";
import type { Rule, Signal, Arc } from "../types/index.js";
import type { Logger } from "../logger.js";
import type { UserCodeExecutorClient } from "./user-code-client.js";
import type { DbError } from "../errors.js";
import type { Result } from "../errors.js";
import { evalCondition } from "./rule-engine.js";
import { interpretRuleResult } from "./interpret-rule-result.js";
import type { RuleEvalResult } from "./interpret-rule-result.js";

// ---------------------------------------------------------------------------
// Strip sensitive fields before passing to user code (allowlist approach)
// ---------------------------------------------------------------------------

type StrippedSignal = Pick<Signal["data"], "from" | "subject" | "summary" | "workflow" | "recipientAddress" | "workflowData"> & Pick<Signal, "id">;
type StrippedArc = Pick<Arc, "id" | "labels" | "urgency" | "summary" | "workflow" | "status">;

function stripSignalForUserCode(signal: Signal): StrippedSignal {
  return {
    id: signal.id,
    from: signal.data.from,
    subject: signal.data.subject,
    summary: signal.data.summary,
    workflow: signal.data.workflow,
    recipientAddress: signal.data.recipientAddress,
    workflowData: signal.data.workflowData,
  };
}

function stripArcForUserCode(arc: Arc): StrippedArc {
  return {
    id: arc.id,
    labels: arc.labels,
    ...(arc.urgency !== undefined ? { urgency: arc.urgency } : {}),
    summary: arc.summary,
    workflow: arc.workflow,
    status: arc.status,
  };
}

// ---------------------------------------------------------------------------
// Store interface for rule error annotation
// ---------------------------------------------------------------------------

export interface RuleAnnotationStore {
  annotateRuleError(accountId: string, ruleId: string, errorMessage: string): Promise<Result<void, DbError>>;
}

// ---------------------------------------------------------------------------
// Rule Evaluator
// ---------------------------------------------------------------------------

export class JsonLogicRuleEvaluator implements RuleEvaluator {
  private readonly logger: Logger;
  private readonly userCodeExecutor: UserCodeExecutorClient;
  private readonly accountDb: RuleAnnotationStore;

  constructor(logger: Logger, userCodeExecutor: UserCodeExecutorClient, accountDb: RuleAnnotationStore) {
    this.logger = logger;
    this.userCodeExecutor = userCodeExecutor;
    this.accountDb = accountDb;
  }

  async evaluate(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): Promise<RuleEvalResult> {
    if (rule.conditionType === "js") {
      return this.evaluateJsCondition(rule, context);
    }

    try {
      const matched = await evalCondition(rule.condition, context);
      return { matched, dynamicActions: [], warnings: [] };
    } catch {
      this.logger.track("Rule condition evaluation threw an exception. The json-logic engine failed to evaluate the condition expression. The rule will be treated as non-matching and processing continues.", { code: "rule_evaluator.condition.failed", ruleId: rule.id, condition: rule.condition });
      return { matched: false, dynamicActions: [], warnings: [] };
    }
  }

  private async evaluateJsCondition(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): Promise<RuleEvalResult> {
    try {
      const response = await this.userCodeExecutor.invoke({
        tenantId: context.signal.accountId,
        purpose: "rule_condition",
        functionCode: rule.condition,
        executionContext: { signal: stripSignalForUserCode(context.signal), arc: stripArcForUserCode(context.arc) },
      });

      if (response.isErr()) {
        await this.annotateRuleError(rule, response.error);
        this.logger.track("User code execution failed for JS rule condition. The rule will be treated as non-matching.", {
          code: "rule_evaluator.js_condition.failed",
          ruleId: rule.id,
          accountId: context.signal.accountId,
          errorType: response.error.errorType,
          errorMessage: response.error.message,
        });
        return { matched: false, dynamicActions: [], warnings: [] };
      }

      return interpretRuleResult(response.value.value);
    } catch (e) {
      this.logger.track("Unexpected error invoking User Code Executor for JS rule condition.", {
        code: "rule_evaluator.js_condition.invoke_error",
        ruleId: rule.id,
        accountId: context.signal.accountId,
        error: e,
      });
      return { matched: false, dynamicActions: [], warnings: [] };
    }
  }

  async annotateRuleError(rule: Rule, error: { message: string; errorType: string }): Promise<void> {
    try {
      await this.accountDb.annotateRuleError(rule.accountId, rule.id, `[${error.errorType}] ${error.message}`);
    } catch {
      // Best-effort — don't fail rule evaluation if annotation fails
      this.logger.track("Failed to annotate rule error.", { code: "rule_evaluator.annotate_failed", ruleId: rule.id });
    }
  }
}
