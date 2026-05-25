import type { RuleEvaluator } from "./processor.js";
import type { Rule, Signal, Arc } from "../types/index.js";
import type { Logger } from "../logger.js";
import type { UserCodeExecutorClient, UserCodeResponse, RuleExecutionResult } from "./user-code-client.js";
import type { Result } from "neverthrow";
import { ok } from "neverthrow";
import type { DbError } from "../errors.js";
import { evalCondition } from "./rule-engine.js";
import { interpretRuleResult } from "./interpret-rule-result.js";
import type { RuleEvalResult } from "./interpret-rule-result.js";

// ---------------------------------------------------------------------------
// Strip sensitive fields before passing to user code (allowlist approach)
// ---------------------------------------------------------------------------

export type StrippedSignal = Pick<Signal["data"], "from" | "subject" | "summary" | "spamScore" | "workflow" | "recipientAddress" | "workflowData"> & Pick<Signal, "id">;
export type StrippedArc = Pick<Arc, "id" | "labels" | "urgency" | "summary" | "workflow" | "status">;

export function stripSensitive(signal: Signal): StrippedSignal;
export function stripSensitive(arc: Arc): StrippedArc;
export function stripSensitive(obj: Signal | Arc): StrippedSignal | StrippedArc {
  if ("data" in obj && "from" in (obj as Signal).data) {
    const signal = obj as Signal;
    return {
      id: signal.id,
      from: signal.data.from,
      subject: signal.data.subject,
      summary: signal.data.summary,
      spamScore: signal.data.spamScore,
      workflow: signal.data.workflow,
      recipientAddress: signal.data.recipientAddress,
      workflowData: signal.data.workflowData,
    };
  }
  const arc = obj as Arc;
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

  constructor(logger: Logger, userCodeExecutor?: UserCodeExecutorClient, accountDb?: RuleAnnotationStore) {
    this.logger = logger;
    this.userCodeExecutor = userCodeExecutor ?? { invoke: () => Promise.resolve({ success: false, error: { message: "User code executor not configured", type: "runtime_error" } } as UserCodeResponse), validateAst: () => Promise.resolve({ success: false, error: { message: "User code executor not configured", type: "runtime_error" } }), validateAstBatch: () => Promise.resolve({ success: false, error: { message: "User code executor not configured", type: "runtime_error" } }) };
    this.accountDb = accountDb ?? { annotateRuleError: () => Promise.resolve(ok(undefined)) };
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
        executionContext: { signal: stripSensitive(context.signal), arc: stripSensitive(context.arc) },
      });

      if (!response.success) {
        await this.annotateRuleError(rule, response.error);
        this.logger.track("User code execution failed for JS rule condition. The rule will be treated as non-matching.", {
          code: "rule_evaluator.js_condition.failed",
          ruleId: rule.id,
          accountId: context.signal.accountId,
          errorType: response.error.type,
          errorMessage: response.error.message,
        });
        return { matched: false, dynamicActions: [], warnings: [] };
      }

      return interpretRuleResult((response as RuleExecutionResult).result);
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

  async annotateRuleError(rule: Rule, error: { message: string; type: string }): Promise<void> {
    try {
      await this.accountDb.annotateRuleError(rule.accountId, rule.id, `[${error.type}] ${error.message}`);
    } catch {
      // Best-effort — don't fail rule evaluation if annotation fails
      this.logger.track("Failed to annotate rule error.", { code: "rule_evaluator.annotate_failed", ruleId: rule.id });
    }
  }
}
