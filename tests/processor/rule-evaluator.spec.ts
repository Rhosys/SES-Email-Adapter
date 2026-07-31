import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import type { RuleAnnotationStore } from "../../src/processor/rule-evaluator.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";
import { userCodeError } from "../../src/processor/user-code-client.js";
import type { Rule, Signal, Thread } from "../../src/types/index.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<Omit<Signal, "data">> & { data?: Partial<Signal["data"]> } = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "SES#test-msg-001",
    accountId: "acc_123",
    source: "inbound",
    type: "email",
    status: "active",
    createdAt: "2024-01-15T10:00:00Z",
    ...baseOverrides,
    data: {
      receivedAt: "2024-01-15T10:00:00Z",
      from: { address: "sender@example.com" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email",
      textBody: "Hello world",
      attachments: [],
      headers: { "x-custom": "value" },
      recipientAddress: "user@example.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "A test email.",
      s3Key: "emails/test-msg-001.eml",
      embeddings: { "model-v1": [0.1, 0.2, 0.3] },
      ...dataOverrides,
    },
  } as Signal;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "arc_001",
    accountId: "acc_123",
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "Test arc",
    lastSignalAt: "2024-01-15T10:00:00Z",
    createdAt: "2024-01-15T09:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    sender: { address: "sender@example.com" },
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  } as Thread;
}

function makeJsRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule_js_001",
    accountId: "acc_123",
    name: "JS condition rule",
    condition: "return signal.workflow === 'content';",
    conditionType: "js",
    actions: [{ type: "assign_label", value: "spam" }],
    status: "enabled",
    priorityOrder: 1,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JsonLogicRuleEvaluator — JS condition path", () => {
  let mockLogger: MockLogger;
  let mockExecutor: UserCodeExecutorClient;
  let mockStore: RuleAnnotationStore;
  let evaluator: JsonLogicRuleEvaluator;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockExecutor = { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() };
    mockStore = { annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
    evaluator = new JsonLogicRuleEvaluator(mockLogger, mockExecutor, mockStore);
  });

  it("returns matched with no dynamic actions when user code returns a truthy result", async () => {
    vi.mocked(mockExecutor.invoke).mockResolvedValue(ok({ value: 42 }));

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: false },
    );

    expect(result).toEqual({ matched: true, dynamicActions: [], warnings: [] });
    expect(mockExecutor.invoke).toHaveBeenCalledWith({
      tenantId: "acc_123",
      purpose: "rule_condition",
      functionCode: "return signal.workflow === 'content';",
      executionContext: expect.objectContaining({
        signal: expect.not.objectContaining({ s3Key: expect.anything() }),
        thread: expect.objectContaining({ id: "arc_001" }),
      }),
    });
  });

  it("returns non-matching when user code returns null", async () => {
    vi.mocked(mockExecutor.invoke).mockResolvedValue(ok({ value: null }));

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: false },
    );

    expect(result).toEqual({ matched: false, dynamicActions: [], warnings: [] });
    expect(mockStore.annotateRuleError).not.toHaveBeenCalled();
  });

  it("returns non-matching when user code returns undefined", async () => {
    vi.mocked(mockExecutor.invoke).mockResolvedValue(ok({ value: undefined }));

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: false },
    );

    expect(result).toEqual({ matched: false, dynamicActions: [], warnings: [] });
  });

  it("returns matched with dynamic actions when user code returns a RuleAction array", async () => {
    vi.mocked(mockExecutor.invoke).mockResolvedValue(ok({ value: [{ type: "archive" }, { type: "assign_label", value: "auto" }] }));

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: false },
    );

    expect(result.matched).toBe(true);
    expect(result.dynamicActions).toEqual([{ type: "archive" }, { type: "assign_label", value: "auto" }]);
    expect(result.warnings).toEqual([]);
  });

  it("returns non-matching and annotates rule on timeout", async () => {
    vi.mocked(mockExecutor.invoke).mockResolvedValue(err(userCodeError("timeout", "User code execution timed out")));

    const result = await evaluator.evaluate(
      makeJsRule({ id: "rule_timeout" }),
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: false },
    );

    expect(result).toEqual({ matched: false, dynamicActions: [], warnings: [] });
    expect(mockStore.annotateRuleError).toHaveBeenCalledWith(
      "acc_123",
      "rule_timeout",
      "[timeout] User code execution timed out",
    );
  });

  it("returns non-matching and annotates rule on runtime error", async () => {
    vi.mocked(mockExecutor.invoke).mockResolvedValue(err(userCodeError("runtime_error", "ReferenceError: foo is not defined")));

    const result = await evaluator.evaluate(
      makeJsRule({ id: "rule_runtime" }),
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: false },
    );

    expect(result).toEqual({ matched: false, dynamicActions: [], warnings: [] });
    expect(mockStore.annotateRuleError).toHaveBeenCalledWith(
      "acc_123",
      "rule_runtime",
      "[runtime_error] ReferenceError: foo is not defined",
    );
  });

  it("returns non-matching and logs on timeout", async () => {
    vi.mocked(mockExecutor.invoke).mockResolvedValue(err(userCodeError("timeout", "User code execution timed out")));

    await evaluator.evaluate(
      makeJsRule({ id: "rule_timeout_log" }),
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: false },
    );

    expect(mockLogger.calls.some(c => c.method === "track" && c.context?.errorType === "timeout")).toBe(true);
  });

  it("returns non-matching and logs on runtime error", async () => {
    vi.mocked(mockExecutor.invoke).mockResolvedValue(err(userCodeError("runtime_error", "ReferenceError: x is not defined")));

    await evaluator.evaluate(
      makeJsRule({ id: "rule_runtime_log" }),
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: false },
    );

    expect(mockLogger.calls.some(c => c.method === "track" && c.context?.errorType === "runtime_error")).toBe(true);
  });

  it("returns matched with warnings when user code returns array with invalid actions (Zod validation failure)", async () => {
    vi.mocked(mockExecutor.invoke).mockResolvedValue(ok({ value: [
      { type: "archive" },
      { type: "totally_invalid_action_type" },
      { type: "assign_label", value: "valid" },
    ] }));

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: false },
    );

    expect(result.matched).toBe(true);
    expect(result.dynamicActions).toEqual([
      { type: "archive" },
      { type: "assign_label", value: "valid" },
    ]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("Element [1]");
    expect(result.warnings[0]).toContain("not a valid RuleAction");
  });

  it("falls through to evalCondition for non-JS rules and wraps boolean result", async () => {
    const jsonLogicRule: Rule = {
      id: "rule_jl_001",
      accountId: "acc_123",
      name: "JSON Logic rule",
      condition: JSON.stringify({ "==": [{ "var": "isMatchedThread" }, true] }),
      actions: [{ type: "assign_label", value: "matched" }],
      status: "enabled",
      priorityOrder: 1,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const result = await evaluator.evaluate(
      jsonLogicRule,
      { signal: makeSignal(), thread: makeThread(), isMatchedThread: true },
    );

    expect(result).toEqual({ matched: true, dynamicActions: [], warnings: [] });
    expect(mockExecutor.invoke).not.toHaveBeenCalled();
  });
});

/**
 * Property 2: Context preparation produces exactly the specified fields
 * Validates: Requirements 4.1, 4.2, 4.4
 */
describe("JS rule context — Property 2: context preparation produces exactly the specified fields", () => {
  const EXPECTED_SIGNAL_KEYS = ["id", "from", "subject", "summary", "workflow", "recipientAddress", "workflowData"];
  const EXPECTED_THREAD_KEYS = ["id", "labels", "urgency", "summary", "workflow", "status"];

  it("executionContext.signal has exactly the 7 specified fields — sensitive fields excluded", async () => {
    const mockExecutor = { invoke: vi.fn().mockResolvedValue(ok({ value: false })), validateAst: vi.fn(), validateAstBatch: vi.fn() };
    const evaluator = new JsonLogicRuleEvaluator(createMockLogger(), mockExecutor, { annotateRuleError: vi.fn().mockResolvedValue(ok(undefined)) });

    const signal = makeSignal({
      data: {
        s3Key: "emails/msg.eml",
        embeddings: { "model-v1": [0.1, 0.2] },
        headers: { "x-custom": "value" },
      },
    });
    const thread = makeThread({ labels: ["important", "billing"], urgency: "high" });
    const rule: Rule = { id: "r-1", accountId: "acc-1", name: "test", condition: "return false", conditionType: "js", actions: [], status: "enabled", priorityOrder: 1, createdAt: "", updatedAt: "" };

    await evaluator.evaluate(rule, { signal, thread, isMatchedThread: false });

    const ctx = mockExecutor.invoke.mock.calls[0]![0].executionContext;
    expect(Object.keys(ctx.signal).sort()).toEqual([...EXPECTED_SIGNAL_KEYS].sort());
    expect(ctx.signal).toEqual({
      id: signal.id,
      from: signal.data.from,
      subject: signal.data.subject,
      summary: signal.data.summary,
      workflow: signal.data.workflow,
      recipientAddress: signal.data.recipientAddress,
      workflowData: signal.data.workflowData,
    });
    // Sensitive fields must not leak
    expect(ctx.signal).not.toHaveProperty("s3Key");
    expect(ctx.signal).not.toHaveProperty("embeddings");
    expect(ctx.signal).not.toHaveProperty("headers");
    expect(ctx.signal).not.toHaveProperty("accountId");
    expect(ctx.signal).not.toHaveProperty("textBody");
    expect(ctx.signal).not.toHaveProperty("attachments");
  });

  it("executionContext.thread has exactly {id, labels, urgency, summary, workflow, status}", async () => {
    const mockExecutor = { invoke: vi.fn().mockResolvedValue(ok({ value: false })), validateAst: vi.fn(), validateAstBatch: vi.fn() };
    const evaluator = new JsonLogicRuleEvaluator(createMockLogger(), mockExecutor, { annotateRuleError: vi.fn().mockResolvedValue(ok(undefined)) });

    const signal = makeSignal({});
    const thread = makeThread({ labels: ["important", "billing"], urgency: "high" });
    const rule: Rule = { id: "r-1", accountId: "acc-1", name: "test", condition: "return false", conditionType: "js", actions: [], status: "enabled", priorityOrder: 1, createdAt: "", updatedAt: "" };

    await evaluator.evaluate(rule, { signal, thread, isMatchedThread: false });

    const ctx = mockExecutor.invoke.mock.calls[0]![0].executionContext;
    expect(Object.keys(ctx.thread).sort()).toEqual([...EXPECTED_THREAD_KEYS].sort());
    expect(ctx.thread).toEqual({
      id: thread.id,
      labels: thread.labels,
      urgency: thread.urgency,
      summary: thread.summary,
      workflow: thread.workflow,
      status: thread.status,
    });
    expect(ctx.thread).not.toHaveProperty("accountId");
    expect(ctx.thread).not.toHaveProperty("lastSignalAt");
    expect(ctx.thread).not.toHaveProperty("createdAt");
    expect(ctx.thread).not.toHaveProperty("updatedAt");
  });
});
