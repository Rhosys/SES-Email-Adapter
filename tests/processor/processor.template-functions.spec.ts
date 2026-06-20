import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { SignalProcessor } from "../../src/processor/processor.js";
import type { ProcessorAccountContext } from "../../src/processor/processor.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";
import { userCodeError } from "../../src/processor/user-code-client.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { Signal, Arc, Alias, EmailTemplate } from "../../src/types/index.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/arc-matcher.js";
import type { S3RetentionService } from "../../src/embedding/s3-retention-service.js";
import type { EmailService } from "../../src/email/email-service.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_tmpl_test";

const DEFAULT_CTX: ProcessorAccountContext = {
  retentionDuration: "P1Y",
  filtering: null,
  aliasConfig: null,
  registeredDomains: ["example.com"],
  userEmails: ["user@example.com"],
  billingPlan: "Paid",
  onboardingCompleted: true,
};

const SYSTEM_RULES = [
  { id: "sys_1", accountId: TEST_ACCOUNT_ID, name: "System", condition: JSON.stringify(false), actions: [], status: "enabled" as const, priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
];

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "SES#tmpl-test-001",
    accountId: TEST_ACCOUNT_ID,
    source: "inbound",
    type: "email",
    status: "active",
    createdAt: "2024-01-15T10:00:00Z",
    ...overrides,
    data: {
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
      tags: [],
      summary: "A test email.",
      s3Key: "emails/tmpl-test-001.eml",
      matchedRules: [{ ruleId: "rule_draft", actions: [{ type: "auto_draft", value: "tmpl_001" }], labelsAdded: [] }],
    },
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
    senderAddress: "sender@example.com",
    recipientAddress: "user@example.com",
    subject: "Test email",
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
}): SignalProcessor {
  const { store, userCodeExecutor, logger } = opts;
  return new SignalProcessor({ ...makeSharedNewDeps(),
    ...store,
    userCodeExecutor,
    contentSanitizer: { invoke: vi.fn() } as unknown as ContentSanitizerClient,
    classifier: { classify: vi.fn() },
    embeddingGenerator: { generateForModel: vi.fn(), generateForSecondaryClusters: vi.fn() } as unknown as EmbeddingGenerator,
    auroraWriter: { upsertEmbedding: vi.fn(), findMatch: vi.fn() } as unknown as MultiClusterAuroraWriter,
    arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    ruleEvaluator: makeRuleEvaluator3(logger),
    logger,
    notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) } as unknown as S3RetentionService,
    replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-id" })) },
    sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    s3Client: {} as never,
    emailBucket: "test-bucket",
    contentBucket: "test-content-bucket",
    draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Template function resolution via User Code Executor", () => {
  let mockLogger: MockLogger;
  let mockExecutor: UserCodeExecutorClient;
  let store: ReturnType<typeof makeStore>;
  let processor: SignalProcessor;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockExecutor = { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() };
    store = makeStore();
    processor = makeProcessor({ store, userCodeExecutor: mockExecutor, logger: mockLogger });
  });

  it("resolves template functions and substitutes values into draft subject and body", async () => {
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(ok({ value: "Hello" }))
      .mockResolvedValueOnce(ok({ value: "Thanks for your email about Test email" }));

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
    expect(draft.data.subject).toBe("Re: Test email — Hello");
    expect(draft.data.textBody).toBe("Hi Sender, Thanks for your email about Test email");
    expect(draft.status).toBe("draft");
  });

  it("substitutes empty string and prevents auto-send when template function returns null", async () => {
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(ok({ value: null }))
      .mockResolvedValueOnce(ok({ value: "body text" }));

    const signal = makeSignal();
    const arc = makeArc();

    await processor.processSideEffect({ signal, arc });

    // Draft should still be saved but with empty string for the null function
    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(2);
    const draft = saveSignalCalls.map(c => c[0] as Signal).find(s => s.source === "user")!;
    expect(draft.data.subject).toBe("Re: Test email — ");
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
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(err(userCodeError("timeout", "User code execution timed out")))
      .mockResolvedValueOnce(ok({ value: "ok" }));

    const signal = makeSignal();
    const arc = makeArc();

    await processor.processSideEffect({ signal, arc });

    // Draft saved with empty string for timed-out function
    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(2);
    const draft = saveSignalCalls.map(c => c[0] as Signal).find(s => s.source === "user")!;
    expect(draft.data.subject).toBe("Re: Test email — ");
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
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(ok({ value: "Hello" }))
      .mockResolvedValueOnce(err(userCodeError("runtime_error", "ReferenceError: foo is not defined")));

    const signal = makeSignal();
    const arc = makeArc();

    await processor.processSideEffect({ signal, arc });

    // Draft saved with empty string for errored function
    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(2);
    const draft = saveSignalCalls.map(c => c[0] as Signal).find(s => s.source === "user")!;
    expect(draft.data.textBody).toBe("Hi Sender, ");
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
    const proc = makeProcessor({ store: storeNoFns, userCodeExecutor: mockExecutor, logger: mockLogger });

    const signal = makeSignal();
    const arc = makeArc();

    await proc.processSideEffect({ signal, arc });

    // User Code Executor should NOT be invoked
    expect(mockExecutor.invoke).not.toHaveBeenCalled();

    // Draft should still be saved with standard variable substitution
    const saveSignalCalls = vi.mocked(storeNoFns.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(1);
    const draft = saveSignalCalls[0]![0] as Signal;
    expect(draft.data.subject).toBe("Re: Test email — ");
  });

  it("logs at WARN level with template name, function name, and error details on execution error", async () => {
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(err(userCodeError("timeout", "User code execution timed out")))
      .mockResolvedValueOnce(ok({ value: "ok" }));

    await processor.processSideEffect({ signal: makeSignal(), arc: makeArc() });

    const warnCalls = mockLogger.calls.filter(c => c.method === "warn");
    const fnErrorWarn = warnCalls.find(c => c.context?.code === "processor.template_function.error");
    expect(fnErrorWarn).toBeDefined();
    expect(fnErrorWarn!.message).toBe("Template function execution failed.");
    expect(fnErrorWarn!.context).toMatchObject({
      templateName: "Auto-draft template",
      functionName: "greeting",
      error: { errorType: "timeout", message: "User code execution timed out" },
    });
  });

  it("logs at WARN level with template name, function name, and issue on null return", async () => {
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(ok({ value: null }))
      .mockResolvedValueOnce(ok({ value: "ok" }));

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
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(err(userCodeError("runtime_error", "ReferenceError: x is not defined")))
      .mockResolvedValueOnce(ok({ value: "ok" }));

    await processor.processSideEffect({ signal: makeSignal(), arc: makeArc() });

    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    const templateSignal = saveSignalCalls.find(([s]) => s.type === "invalid_template_function");
    expect(templateSignal).toBeDefined();
    expect(templateSignal![0].data).toEqual({
      resourceName: "Auto-draft template",
      functionName: "greeting",
      issue: "[runtime_error] ReferenceError: x is not defined",
    });
  });

  it("creates system signal on non-string return with template name, function name, and type info", async () => {
    // Simulate a function returning a number (non-string) — cast to bypass TS type safety
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(ok({ value: 42 } as any))
      .mockResolvedValueOnce(ok({ value: "ok" }));

    await processor.processSideEffect({ signal: makeSignal(), arc: makeArc() });

    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    const templateSignal = saveSignalCalls.find(([s]) => s.type === "invalid_template_function");
    expect(templateSignal).toBeDefined();
    expect(templateSignal![0].data).toEqual({
      resourceName: "Auto-draft template",
      functionName: "greeting",
      issue: "Function returned non-string value (type: number)",
    });
  });

  it("prevents auto-send and substitutes empty string when function returns non-string", async () => {
    // Simulate a function returning an object (non-string)
    vi.mocked(mockExecutor.invoke)
      .mockResolvedValueOnce(ok({ value: { foo: "bar" } } as any))
      .mockResolvedValueOnce(ok({ value: "body text" }));

    const signal = makeSignal();
    const arc = makeArc();

    await processor.processSideEffect({ signal, arc });

    const saveSignalCalls = vi.mocked(store.arcDb.saveSignal).mock.calls;
    expect(saveSignalCalls.length).toBe(2);
    const draft = saveSignalCalls.map(c => c[0] as Signal).find(s => s.source === "user")!;
    expect(draft.data.subject).toBe("Re: Test email — ");
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
