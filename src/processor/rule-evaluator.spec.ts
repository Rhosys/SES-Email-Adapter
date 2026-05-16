import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import { JsonLogicRuleEvaluator, stripSensitive } from "./rule-evaluator.js";
import type { RuleAnnotationStore } from "./rule-evaluator.js";
import type { UserCodeExecutorClient, UserCodeResponse } from "./user-code-client.js";
import type { Rule, Signal, Arc } from "../types/index.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "SES#test-msg-001",
    accountId: "acc_123",
    source: "inbound",
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
    spamScore: 0.01,
    summary: "A test email.",
    classificationModelId: "model-v1",
    s3Key: "emails/test-msg-001.eml",
    status: "active",
    createdAt: "2024-01-15T10:00:00Z",
    embeddings: { "model-v1": [0.1, 0.2, 0.3] },
    ...overrides,
  } as Signal;
}

function makeArc(overrides: Partial<Arc> = {}): Arc {
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
    ...overrides,
  } as Arc;
}

function makeJsRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule_js_001",
    accountId: "acc_123",
    name: "JS condition rule",
    condition: "",
    conditionType: "js",
    code: "return signal.spamScore > 0.5;",
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
    mockExecutor = { invoke: vi.fn() };
    mockStore = { annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
    evaluator = new JsonLogicRuleEvaluator(mockLogger, mockExecutor, mockStore);
  });

  it("returns true when user code returns a truthy result", async () => {
    const response: UserCodeResponse = { success: true, purpose: "rule_condition", result: 42 };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toBe(true);
    expect(mockExecutor.invoke).toHaveBeenCalledWith({
      tenantId: "acc_123",
      purpose: "rule_condition",
      functionCode: "return signal.spamScore > 0.5;",
      executionContext: expect.objectContaining({
        signal: expect.not.objectContaining({ s3Key: expect.anything() }),
        arc: expect.objectContaining({ id: "arc_001" }),
      }),
    });
  });

  it("returns false when user code returns null", async () => {
    const response: UserCodeResponse = { success: true, purpose: "rule_condition", result: null };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toBe(false);
    expect(mockStore.annotateRuleError).not.toHaveBeenCalled();
  });

  it("returns false when user code returns a falsy value (0)", async () => {
    const response: UserCodeResponse = { success: true, purpose: "rule_condition", result: 0 };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toBe(false);
  });

  it("returns false and annotates rule on timeout", async () => {
    const response: UserCodeResponse = { success: false, error: { message: "User code execution timed out", type: "timeout" } };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule({ id: "rule_timeout" }),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toBe(false);
    expect(mockStore.annotateRuleError).toHaveBeenCalledWith(
      "acc_123",
      "rule_timeout",
      "[timeout] User code execution timed out",
    );
  });

  it("returns false and annotates rule on runtime error", async () => {
    const response: UserCodeResponse = { success: false, error: { message: "ReferenceError: foo is not defined", type: "runtime_error" } };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule({ id: "rule_runtime" }),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toBe(false);
    expect(mockStore.annotateRuleError).toHaveBeenCalledWith(
      "acc_123",
      "rule_runtime",
      "[runtime_error] ReferenceError: foo is not defined",
    );
  });

  it("falls through to evalCondition for non-JS rules", async () => {
    const jsonLogicRule: Rule = {
      id: "rule_jl_001",
      accountId: "acc_123",
      name: "JSON Logic rule",
      condition: JSON.stringify({ "==": [{ "var": "isMatchedArc" }, true] }),
      actions: [{ type: "assign_label", value: "matched" }],
      status: "enabled",
      priorityOrder: 1,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const result = await evaluator.evaluate(
      jsonLogicRule,
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: true },
    );

    expect(result).toBe(true);
    expect(mockExecutor.invoke).not.toHaveBeenCalled();
  });
});

describe("stripSensitive", () => {
  it("removes s3Key and embeddings from Signal", () => {
    const signal = makeSignal({ s3Key: "secret/path.eml", embeddings: { "model": [1, 2, 3] } });
    const stripped = stripSensitive(signal);

    expect(stripped).not.toHaveProperty("s3Key");
    expect(stripped).not.toHaveProperty("embeddings");
    expect(stripped).toHaveProperty("id", signal.id);
    expect(stripped).toHaveProperty("accountId", signal.accountId);
  });

  it("preserves all Arc fields", () => {
    const arc = makeArc({ labels: ["important"] });
    const stripped = stripSensitive(arc);

    expect(stripped).toHaveProperty("id", arc.id);
    expect(stripped).toHaveProperty("labels", ["important"]);
  });
});
