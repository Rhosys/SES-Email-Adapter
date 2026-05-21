import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import { SignalProcessor } from "../../src/processor/processor.js";
import type { ProcessorAccountContext } from "../../src/processor/processor.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { UserCodeExecutorClient, UserCodeResponse } from "../../src/processor/user-code-client.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { Signal, Arc, Alias, EmailTemplate } from "../../src/types/index.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/multi-cluster-aurora-writer.js";
import type { S3RetentionService } from "../../src/embedding/s3-retention-service.js";
import type { SystemSignalCreator } from "../../src/processor/system-signal-creator.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

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

function makeStore(template: EmailTemplate | null = makeTemplate()) {
  const arcDb = makeArcDbMock();
  const accountDb = {
    ...makeAccountDbMock(),
    getSender: vi.fn().mockReturnValue(Promise.resolve(ok({ policy: "allow", domain: "external.com", address: "sender@external.com" }))),
    getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(template))),
  } as unknown as AccountDatabase;
  const processingDb = makeProcessingDbMock();
  return { arcDb, accountDb, processingDb };
}

function makeProcessor(opts: {
  store: ReturnType<typeof makeStore>;
  userCodeExecutor: UserCodeExecutorClient;
  logger: MockLogger;
  systemSignalCreator?: SystemSignalCreator;
}): SignalProcessor {
  const { store, userCodeExecutor, logger, systemSignalCreator } = opts;
  return new SignalProcessor({
    ...store,
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
    draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    ...(systemSignalCreator ? { systemSignalCreator } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Template function resolution via User Code Executor", () => {
  let mockLogger: MockLogger;
  let mockExecutor: UserCodeExecutorClient;
  let mockSystemSignalCreator: SystemSignalCreator;
  let store: ReturnType<typeof makeStore>;
  let processor: SignalProcessor;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockExecutor = { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() };
    mockSystemSignalCreator = { createInvalidRuleFunctionSignal: vi.fn().mockResolvedValue(undefined), createInvalidTemplateFunctionSignal: vi.fn().mockResolvedValue(undefined), createAutoSendBlockedSignal: vi.fn().mockResolvedValue(undefined) };
    store = makeStore();
    processor = makeProcessor({ store, userCodeExecutor: mockExecutor, logger: mockLogger, systemSignalCreator: mockSystemSignalCreator });
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
    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
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
    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.subject).toBe("Re: Test email — ");
    expect(draft.status).toBe("draft");

    // annotateTemplateError should be called for the null result
    expect(store.accountDb.annotateTemplateError).toHaveBeenCalledWith(
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
    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.subject).toBe("Re: Test email — ");
    expect(draft.status).toBe("draft");

    // annotateTemplateError called with timeout error
    expect(store.accountDb.annotateTemplateError).toHaveBeenCalledWith(
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
    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.textBody).toBe("Hi Sender, ");
    expect(draft.status).toBe("draft");

    // annotateTemplateError called with runtime error
    expect(store.accountDb.annotateTemplateError).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID,
      "tmpl_001",
      "customBody",
      "[runtime_error] ReferenceError: foo is not defined",
    );
  });

  it("skips template function resolution when template has no functions", async () => {
    const templateWithoutFunctions = makeTemplate({ functions: [] });
    const storeNoFns = makeStore(templateWithoutFunctions);
    const proc = makeProcessor({ store: storeNoFns, userCodeExecutor: mockExecutor, logger: mockLogger, systemSignalCreator: mockSystemSignalCreator });

    const signal = makeSignal();
    const arc = makeArc();

    await proc.processSideEffect({ signal, arc });

    // User Code Executor should NOT be invoked
    expect(mockExecutor.invoke).not.toHaveBeenCalled();

    // Draft should still be saved with standard variable substitution
    const saveSignalCalls = vi.mocked(storeNoFns.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.subject).toBe("Re: Test email — ");
  });

  it("logs at WARN level with template name, function name, and error details on execution error", async () => {
    const timeoutResponse: UserCodeResponse = {
      success: false,
      error: { message: "User code execution timed out", type: "timeout" },
    };
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(timeoutResponse)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "ok" });

    await processor.processSideEffect({ signal: makeSignal(), arc: makeArc() });

    const warnCalls = mockLogger.calls.filter(c => c.method === "warn");
    const fnErrorWarn = warnCalls.find(c => c.context?.code === "processor.template_function.error");
    expect(fnErrorWarn).toBeDefined();
    expect(fnErrorWarn!.message).toBe("Template function execution failed.");
    expect(fnErrorWarn!.context).toMatchObject({
      templateName: "Auto-draft template",
      functionName: "greeting",
      errorType: "timeout",
      errorMessage: "User code execution timed out",
    });
  });

  it("logs at WARN level with template name, function name, and issue on null return", async () => {
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: null })
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "ok" });

    await processor.processSideEffect({ signal: makeSignal(), arc: makeArc() });

    const warnCalls = mockLogger.calls.filter(c => c.method === "warn");
    const invalidReturnWarn = warnCalls.find(c => c.context?.code === "processor.template_function.invalid_return");
    expect(invalidReturnWarn).toBeDefined();
    expect(invalidReturnWarn!.message).toBe("Template function returned invalid value.");
    expect(invalidReturnWarn!.context).toMatchObject({
      templateName: "Auto-draft template",
      functionName: "greeting",
      issue: "Function returned no value",
    });
  });

  it("creates system signal on execution error with template name, function name, and issue", async () => {
    const runtimeErrorResponse: UserCodeResponse = {
      success: false,
      error: { message: "ReferenceError: x is not defined", type: "runtime_error" },
    };
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(runtimeErrorResponse)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "ok" });

    await processor.processSideEffect({ signal: makeSignal(), arc: makeArc() });

    expect(mockSystemSignalCreator.createInvalidTemplateFunctionSignal).toHaveBeenCalledWith({
      accountId: TEST_ACCOUNT_ID,
      arcId: "arc_tmpl_001",
      recipientAddress: "user@example.com",
      resourceName: "Auto-draft template",
      functionName: "greeting",
      issue: "[runtime_error] ReferenceError: x is not defined",
    });
  });

  it("creates system signal on non-string return with template name, function name, and type info", async () => {
    // Simulate a function returning a number (non-string) — cast to bypass TS type safety
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: 42 } as unknown as UserCodeResponse)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "ok" });

    await processor.processSideEffect({ signal: makeSignal(), arc: makeArc() });

    expect(mockSystemSignalCreator.createInvalidTemplateFunctionSignal).toHaveBeenCalledWith({
      accountId: TEST_ACCOUNT_ID,
      arcId: "arc_tmpl_001",
      recipientAddress: "user@example.com",
      resourceName: "Auto-draft template",
      functionName: "greeting",
      issue: "Function returned non-string value (type: number)",
    });
  });

  it("prevents auto-send and substitutes empty string when function returns non-string", async () => {
    // Simulate a function returning an object (non-string)
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: { foo: "bar" } } as unknown as UserCodeResponse)
      .mockResolvedValueOnce({ success: true, purpose: "template_function", result: "body text" });

    const signal = makeSignal();
    const arc = makeArc();

    await processor.processSideEffect({ signal, arc });

    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.subject).toBe("Re: Test email — ");
    expect(draft.status).toBe("draft");

    // annotateTemplateError should be called
    expect(store.accountDb.annotateTemplateError).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID,
      "tmpl_001",
      "greeting",
      "Function returned no value",
    );
  });
});
