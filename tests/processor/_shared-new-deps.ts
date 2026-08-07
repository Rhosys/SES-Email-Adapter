/**
 * Shared mock dependencies for the 4 new SignalProcessorOptions fields.
 * Import and spread into any new SignalProcessor({...}) call.
 */
import { vi } from "vitest";
import { ok } from "../../src/errors.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import type { HandlerRegistry } from "../../src/workflow/registry.js";
import type { SchedulerClient } from "../../src/scheduler/scheduler-client.js";
import type { Logger } from "../../src/logger.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";

export function makeSharedNewDeps() {
  return {
    userCodeExecutor: { invoke: vi.fn().mockResolvedValue({ success: true, result: undefined }), validateAst: vi.fn().mockResolvedValue({ success: true }), validateAstBatch: vi.fn().mockResolvedValue({ success: true }) } as unknown as UserCodeExecutorClient,
    billingHandler: new BillingHandler(),
    handlerRegistry: { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as HandlerRegistry,
    schedulerClient: { createFollowup: vi.fn().mockResolvedValue(ok(undefined)), deleteFollowup: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as SchedulerClient,
    platformTenantName: "test-platform",
  };
}

export function makeRuleEvaluator3(logger: Logger): JsonLogicRuleEvaluator {
  const userCodeExecutor = { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() } as unknown as UserCodeExecutorClient;
  const annotationStore = { annotateRuleError: vi.fn().mockResolvedValue(ok(undefined)) };
  return new JsonLogicRuleEvaluator(logger, userCodeExecutor, annotationStore);
}
