import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import { SignalProcessor } from "./processor.js";
import type { ProcessorDatabase, SqsDispatcher, Notifier, Forwarder, ReplySender, RuleEvaluator, ProcessorAccountContext } from "./processor.js";
import type { UserCodeExecutorClient, UserCodeResponse } from "./user-code-client.js";
import type { ContentSanitizerClient } from "./content-sanitizer-client.js";
import type { Signal, Arc, Alias, EmailTemplate } from "../types/index.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { S3RetentionService } from "../embedding/s3-retention-service.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_tmpl_test";

const DEFAULT_CTX: ProcessorAccountContext = {
  retentionDays: 365,
  filtering: null,
  emailConfig: null,
  registeredDomains: ["example.com"],
  userEmails: ["user@example.com"],
  billingPlan: "Paid",
};

const SYSTEM_RULES = [
  { id: "sys_1", accountId: TEST_ACCOUNT_ID, name: "System", condition: JSON.stringify(false), actions: [], status: "enabled" as const, priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
];

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "SES#tmpl-test-001",
    accountId: TEST_ACCOUNT_ID,
    source: "inbound",
    receivedAt: "2024-01-15T10:00:00Z",
    from: { address: "sender@external.com", name: "Sender" },
    to: [{ address: "user@example.com" }],
    cc: [],
    subject: "Test email",
    textBody: "Hello world",
    attachments: [],
    headers: {},
    recipientAddress: "user@example.com",
    workflow: "conversation",
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.01,
    summary: "A test email.",
    classificationModelId: "model-v1",
    s3Key: "emails/tmpl-test-001.eml",
    status: "active",
    createdAt: "2024-01-15T10:00:00Z",
    matchedRules: [{ ruleId: "rule_draft", actions: [{ type: "auto_draft", value: "tmpl_001" }] }],
    ...overrides,
  } as Signal;
}

function makeArc(overrides: Partial<Arc> = {}): Arc {
  return {
    id: "arc_tmpl_001",
    accountId: TEST_ACCOUNT_ID,
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

function makeTemplate(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    id: "tmpl_001",
    accountId: TEST_ACCOUNT_ID,
    name: "Auto-draft template",
    subject: "Re: {{signal.subject}} — {{fn.greeting}}",
    body: "Hi {{sender.name}}, {{fn.customBody}}",
    functions: [
      { name: "greeting", code: "return 'Hello';" },
      { name: "customBody", code: "return 'Thanks for your email about ' + signal.subject;" },
    ],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeStore(template: EmailTemplate | null = makeTemplate()): ProcessorDatabase {
  return {
    getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getArc: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    findArcByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveArc: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok(SYSTEM_RULES))),
    getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_CTX))),
    saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a))),
    getSender: vi.fn().mockReturnValue(Promise.resolve(ok({ policy: "allow", domain: "external.com", address: "sender@external.com" }))),
    saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(template))),
    updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    incrementStats: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    annotateTemplateError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  };
}

function makeProcessor(opts: {
  store: ProcessorDatabase;
  userCodeExecutor: UserCodeExecutorClient;
  logger: MockLogger;
}): SignalProcessor {
  const { store, userCodeExecutor, logger } = opts;
  return new SignalProcessor({
    store,
    userCodeExecutor,
    contentSanitizer: { invoke: vi.fn() } as unknown as ContentSanitizerClient,
    classifier: { classify: vi.fn() },
    embeddingGenerator: { generateForModel: vi.fn(), generateForSecondaryClusters: vi.fn() } as unknown as EmbeddingGenerator,
    auroraWriter: { upsertEmbedding: vi.fn(), findMatch: vi.fn() } as unknown as MultiClusterAuroraWriter,
    arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    ruleEvaluator: new JsonLogicRuleEvaluator(logger),
    logger,
    notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) } as unknown as S3RetentionService,
    replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-id" }) },
    sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    s3Client: {} as never,
    emailBucket: "test-bucket",
    contentBucket: "test-content-bucket",
    contentCdnBaseUrl: "https://cdn.example.com",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Template function resolution via User Code Executor", () => {
  let mockLogger: MockLogger;
  let mockExecutor: UserCodeExecutorClient;
  let store: ProcessorDatabase;
  let processor: SignalProcessor;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockExecutor = { invoke: vi.fn() };
    store = makeStore();
    processor = makeProcessor({ store, userCodeExecutor: mockExecutor, logger: mockLogger });
  });

  it("resolves template functions and substitutes values into draft subject and body", async () => {
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "Hello" })
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "Thanks for your email about Test email" });

    const signal = makeSignal();
    const arc = makeArc();

    await processor.processSideEffect({ signal, arc });

    // Verify User Code Executor was invoked for each template function
    expect(mockExecutor.invoke).toHaveBeenCalledTimes(2);
    expect(mockExecutor.invoke).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TEST_ACCOUNT_ID,
      purpose: "template_function",
      functionCode: "return 'Hello';",
    }));
    expect(mockExecutor.invoke).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TEST_ACCOUNT_ID,
      purpose: "template_function",
      functionCode: "return 'Thanks for your email about ' + signal.subject;",
    }));

    // Verify draft was saved with resolved template values
    const saveSignalCalls = vi.mocked(store.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.subject).toBe("Re: Test email — Hello");
    expect(draft.textBody).toBe("Hi Sender, Thanks for your email about Test email");
    expect(draft.status).toBe("draft");
  });

  it("substitutes empty string and prevents auto-send when template function returns null", async () => {
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: null })
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "body text" });

    const signal = makeSignal();
    const arc = makeArc();

    await processor.processSideEffect({ signal, arc });

    // Draft should still be saved but with empty string for the null function
    const saveSignalCalls = vi.mocked(store.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.subject).toBe("Re: Test email — ");
    expect(draft.status).toBe("draft");

    // annotateTemplateError should be called for the null result
    expect(store.annotateTemplateError).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID,
      "tmpl_001",
      "greeting",
      "Function returned no value",
    );
  });

  it("substitutes empty string and annotates on timeout error", async () => {
    const timeoutResponse: UserCodeResponse = {
      success: false,
      error: { message: "User code execution timed out", type: "timeout" },
    };
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(timeoutResponse)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "ok" });

    const signal = makeSignal();
    const arc = makeArc();

    await processor.processSideEffect({ signal, arc });

    // Draft saved with empty string for timed-out function
    const saveSignalCalls = vi.mocked(store.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.subject).toBe("Re: Test email — ");
    expect(draft.status).toBe("draft");

    // annotateTemplateError called with timeout error
    expect(store.annotateTemplateError).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID,
      "tmpl_001",
      "greeting",
      "[timeout] User code execution timed out",
    );
  });

  it("substitutes empty string and annotates on runtime error", async () => {
    const runtimeErrorResponse: UserCodeResponse = {
      success: false,
      error: { message: "ReferenceError: foo is not defined", type: "runtime_error" },
    };
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "Hello" })
      .mockResolvedValueOnce(runtimeErrorResponse);

    const signal = makeSignal();
    const arc = makeArc();

    await processor.processSideEffect({ signal, arc });

    // Draft saved with empty string for errored function
    const saveSignalCalls = vi.mocked(store.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.textBody).toBe("Hi Sender, ");
    expect(draft.status).toBe("draft");

    // annotateTemplateError called with runtime error
    expect(store.annotateTemplateError).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID,
      "tmpl_001",
      "customBody",
      "[runtime_error] ReferenceError: foo is not defined",
    );
  });

  it("skips template function resolution when template has no functions", async () => {
    const templateWithoutFunctions = makeTemplate({ functions: [] });
    const storeNoFns = makeStore(templateWithoutFunctions);
    const proc = makeProcessor({ store: storeNoFns, userCodeExecutor: mockExecutor, logger: mockLogger });

    const signal = makeSignal();
    const arc = makeArc();

    await proc.processSideEffect({ signal, arc });

    // User Code Executor should NOT be invoked
    expect(mockExecutor.invoke).not.toHaveBeenCalled();

    // Draft should still be saved with standard variable substitution
    const saveSignalCalls = vi.mocked(storeNoFns.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.subject).toBe("Re: Test email — ");
  });
});
