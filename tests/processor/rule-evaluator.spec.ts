import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import { JsonLogicRuleEvaluator, stripSensitive } from "../../src/processor/rule-evaluator.js";
import type { RuleAnnotationStore } from "../../src/processor/rule-evaluator.js";
import type { UserCodeExecutorClient, UserCodeResponse } from "../../src/processor/user-code-client.js";
import type { Rule, Signal, Arc } from "../../src/types/index.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

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
    mockExecutor = { invoke: vi.fn(), validateAst: vi.fn() };
    mockStore = { annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
    evaluator = new JsonLogicRuleEvaluator(mockLogger, mockExecutor, mockStore);
  });

  it("returns matched with no dynamic actions when user code returns a truthy result", async () => {
    const response: UserCodeResponse = { success: true, purpose: "rule_condition", result: 42 };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toEqual({ matched: true, dynamicActions: [], warnings: [] });
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

  it("returns non-matching when user code returns null", async () => {
    const response: UserCodeResponse = { success: true, purpose: "rule_condition", result: null };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toEqual({ matched: false, dynamicActions: [], warnings: [] });
    expect(mockStore.annotateRuleError).not.toHaveBeenCalled();
  });

  it("returns non-matching when user code returns undefined", async () => {
    const response: UserCodeResponse = { success: true, purpose: "rule_condition", result: undefined };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toEqual({ matched: false, dynamicActions: [], warnings: [] });
  });

  it("returns matched with dynamic actions when user code returns a RuleAction array", async () => {
    const response: UserCodeResponse = { success: true, purpose: "rule_condition", result: [{ type: "archive" }, { type: "assign_label", value: "auto" }] };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result.matched).toBe(true);
    expect(result.dynamicActions).toEqual([{ type: "archive" }, { type: "assign_label", value: "auto" }]);
    expect(result.warnings).toEqual([]);
  });

  it("returns non-matching and annotates rule on timeout", async () => {
    const response: UserCodeResponse = { success: false, error: { message: "User code execution timed out", type: "timeout" } };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule({ id: "rule_timeout" }),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toEqual({ matched: false, dynamicActions: [], warnings: [] });
    expect(mockStore.annotateRuleError).toHaveBeenCalledWith(
      "acc_123",
      "rule_timeout",
      "[timeout] User code execution timed out",
    );
  });

  it("returns non-matching and annotates rule on runtime error", async () => {
    const response: UserCodeResponse = { success: false, error: { message: "ReferenceError: foo is not defined", type: "runtime_error" } };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule({ id: "rule_runtime" }),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(result).toEqual({ matched: false, dynamicActions: [], warnings: [] });
    expect(mockStore.annotateRuleError).toHaveBeenCalledWith(
      "acc_123",
      "rule_runtime",
      "[runtime_error] ReferenceError: foo is not defined",
    );
  });

  it("returns non-matching and logs on timeout", async () => {
    const response: UserCodeResponse = { success: false, error: { message: "User code execution timed out", type: "timeout" } };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    await evaluator.evaluate(
      makeJsRule({ id: "rule_timeout_log" }),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(mockLogger.calls.some(c => c.method === "track" && c.context?.errorType === "timeout")).toBe(true);
  });

  it("returns non-matching and logs on runtime error", async () => {
    const response: UserCodeResponse = { success: false, error: { message: "ReferenceError: x is not defined", type: "runtime_error" } };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    await evaluator.evaluate(
      makeJsRule({ id: "rule_runtime_log" }),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
    );

    expect(mockLogger.calls.some(c => c.method === "track" && c.context?.errorType === "runtime_error")).toBe(true);
  });

  it("returns matched with warnings when user code returns array with invalid actions (Zod validation failure)", async () => {
    const response: UserCodeResponse = {
      success: true,
      purpose: "rule_condition",
      result: [
        { type: "archive" },
        { type: "totally_invalid_action_type" },
        { type: "assign_label", value: "valid" },
      ],
    };
    vi.mocked(mockExecutor.invoke).mockResolvedValue(response);

    const result = await evaluator.evaluate(
      makeJsRule(),
      { signal: makeSignal(), arc: makeArc(), isMatchedArc: false },
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

    expect(result).toEqual({ matched: true, dynamicActions: [], warnings: [] });
    expect(mockExecutor.invoke).not.toHaveBeenCalled();
  });
});

/**
 * Property 2: Context preparation produces exactly the specified fields
 * Validates: Requirements 4.1, 4.2, 4.4
 */
describe("stripSensitive — Property 2: context preparation produces exactly the specified fields", () => {
  const EXPECTED_SIGNAL_KEYS = ["id", "from", "subject", "summary", "spamScore", "workflow", "recipientAddress", "workflowData"];
  const EXPECTED_ARC_KEYS = ["id", "labels", "urgency", "summary", "workflow", "status"];

  const signalCases = [
    {
      label: "full Signal → output has exactly the 8 specified fields",
      input: () => makeSignal({
        s3Key: "emails/msg.eml",
        embeddings: { "model-v1": [0.1, 0.2] },
        headers: { "x-custom": "value" },
      }),
      expectedKeys: EXPECTED_SIGNAL_KEYS,
      expectedValues: (signal: Signal) => ({
        id: signal.id,
        from: signal.from,
        subject: signal.subject,
        summary: signal.summary,
        spamScore: signal.spamScore,
        workflow: signal.workflow,
        recipientAddress: signal.recipientAddress,
        workflowData: signal.workflowData,
      }),
      absentKeys: ["s3Key", "embeddings", "headers", "accountId", "source", "receivedAt", "to", "cc", "textBody", "attachments", "status", "createdAt", "classificationModelId"],
    },
    {
      label: "Signal with s3Key/embeddings/headers → none appear in output",
      input: () => makeSignal({
        s3Key: "secret/path.eml",
        embeddings: { "model": [1, 2, 3] },
        headers: { "x-mailer": "test", "dkim-signature": "abc" },
      }),
      expectedKeys: EXPECTED_SIGNAL_KEYS,
      expectedValues: (signal: Signal) => ({
        id: signal.id,
        from: signal.from,
        subject: signal.subject,
        summary: signal.summary,
        spamScore: signal.spamScore,
        workflow: signal.workflow,
        recipientAddress: signal.recipientAddress,
        workflowData: signal.workflowData,
      }),
      absentKeys: ["s3Key", "embeddings", "headers"],
    },
  ] as const;

  it.each(signalCases)("$label", ({ input, expectedKeys, expectedValues, absentKeys }) => {
    const signal = input();
    const stripped = stripSensitive(signal);

    expect(Object.keys(stripped).sort()).toEqual([...expectedKeys].sort());
    expect(stripped).toEqual(expectedValues(signal));
    for (const key of absentKeys) {
      expect(stripped).not.toHaveProperty(key);
    }
  });

  const arcCases = [
    {
      label: "full Arc → output has exactly {id, labels, urgency, summary, workflow, status}",
      input: () => makeArc({ labels: ["important", "billing"], urgency: "high" }),
      expectedKeys: EXPECTED_ARC_KEYS,
      expectedValues: (arc: Arc) => ({
        id: arc.id,
        labels: arc.labels,
        urgency: arc.urgency,
        summary: arc.summary,
        workflow: arc.workflow,
        status: arc.status,
      }),
      absentKeys: ["accountId", "lastSignalAt", "createdAt", "updatedAt"],
    },
  ] as const;

  it.each(arcCases)("$label", ({ input, expectedKeys, expectedValues, absentKeys }) => {
    const arc = input();
    const stripped = stripSensitive(arc);

    expect(Object.keys(stripped).sort()).toEqual([...expectedKeys].sort());
    expect(stripped).toEqual(expectedValues(arc));
    for (const key of absentKeys) {
      expect(stripped).not.toHaveProperty(key);
    }
  });
});
