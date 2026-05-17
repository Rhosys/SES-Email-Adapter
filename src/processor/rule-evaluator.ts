import type { RuleEvaluator } from "./processor.js";
import type { Rule, Signal, Arc } from "../types/index.js";
import type { Logger } from "../logger.js";
import type { UserCodeExecutorClient, UserCodeResponse, RuleExecutionResult } from "./user-code-client.js";
import type { Result } from "neverthrow";
import { ok } from "neverthrow";
import type { DbError } from "../errors.js";
import { evalCondition } from "./rule-engine.js";

// ---------------------------------------------------------------------------
// Strip sensitive fields before passing to user code (allowlist approach)
// ---------------------------------------------------------------------------

export type StrippedSignal = Pick<Signal, "id" | "from" | "subject" | "summary" | "spamScore" | "workflow" | "recipientAddress" | "workflowData">;
export type StrippedArc = Pick<Arc, "id" | "labels" | "urgency" | "summary" | "workflow" | "status">;

export function stripSensitive(signal: Signal): StrippedSignal;
export function stripSensitive(arc: Arc): StrippedArc;
export function stripSensitive(obj: Signal | Arc): StrippedSignal | StrippedArc {
  if ("from" in obj && "subject" in obj) {
    const signal = obj as Signal;
    return {
      id: signal.id,
      from: signal.from,
      subject: signal.subject,
      summary: signal.summary,
      spamScore: signal.spamScore,
      workflow: signal.workflow,
      recipientAddress: signal.recipientAddress,
      workflowData: signal.workflowData,
    };
  }
  const arc = obj as Arc;
  return {
    id: arc.id,
    labels: arc.labels,
    urgency: arc.urgency,
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
  private readonly store: RuleAnnotationStore;

  constructor(logger: Logger, userCodeExecutor?: UserCodeExecutorClient, store?: RuleAnnotationStore) {
    this.logger = logger;
    this.userCodeExecutor = userCodeExecutor ?? { invoke: () => Promise.resolve({ success: false, error: { message: "User code executor not configured", type: "runtime_error" } } as UserCodeResponse) };
    this.store = store ?? { annotateRuleError: () => Promise.resolve(ok(undefined)) };
  }

  async evaluate(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): Promise<boolean> {
    if (rule.conditionType === "js") {
      return this.evaluateJsCondition(rule, context);
    }

    try {
      return await evalCondition(rule.condition, context);
    } catch {
      this.logger.track("Rule condition evaluation threw an exception. The json-logic engine failed to evaluate the condition expression. The rule will be treated as non-matching and processing continues.", { code: "rule_evaluator.condition.failed", ruleId: rule.id, condition: rule.condition });
      return false;
    }
  }

  private async evaluateJsCondition(rule: Rule, context: { signal: Signal; arc: Arc; isMatchedArc: boolean }): Promise<boolean> {
    try {
      const response = await this.userCodeExecutor.invoke({
        tenantId: context.signal.accountId,
        purpose: "rule_condition",
        functionCode: rule.code!,
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
        return false;
      }

      return Boolean((response as RuleExecutionResult).result);
    } catch (e) {
      this.logger.track("Unexpected error invoking User Code Executor for JS rule condition.", {
        code: "rule_evaluator.js_condition.invoke_error",
        ruleId: rule.id,
        accountId: context.signal.accountId,
        error: e,
      });
      return false;
    }
  }

  async annotateRuleError(rule: Rule, error: { message: string; type: string }): Promise<void> {
    try {
      await this.store.annotateRuleError(rule.accountId, rule.id, `[${error.type}] ${error.message}`);
    } catch {
      // Best-effort — don't fail rule evaluation if annotation fails
      this.logger.track("Failed to annotate rule error.", { code: "rule_evaluator.annotate_failed", ruleId: rule.id });
    }
  }
}
