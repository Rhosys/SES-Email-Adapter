import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps } from "./_shared-new-deps.js";
import type { ThreadMatcherPort, RuleEvaluator, InboundSignalMessage, SqsDispatcher } from "../../src/processor/processor.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { CtxLike } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Thread, Rule, Alias, AliasSender } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

vi.mock("../../src/embedding/cluster-registry.js", () => {
  const entry = Object.freeze({
    registryId: "aurora-prod-titan-v2",
    clusterArn: "arn:aws:rds:eu-central-1:123456789012:cluster:aurora-prod-titan-v2",
    secretArn: "arn:aws:secretsmanager:eu-central-1:123456789012:secret:aurora-prod-titan-v2-xxxxxx",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([entry]),
    getActiveClusters: () => [entry],
    getRegistryById: (id: string) => (id === entry.registryId ? entry : null),
    getPrimaryThreadMatcherRegistry: () => entry,
  };
});

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-001";

const DEFAULT_ALIAS: Alias = {
  id: "cfg-default", accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", aliasName: "user",
  unknownSenderPolicy: "quarantine_visible",
  createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_SENDER_ENTRY: AliasSender = {
  accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", aliasName: "user", senderDomain: "example.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_CTX = { retentionDuration: "P3M", filtering: null, aliasConfig: DEFAULT_ALIAS, registeredDomains: [], userEmails: [], billingPlan: "Paid" as const, onboardingCompleted: true } satisfies CtxLike;

const validClassification: ClassificationOutput = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
  tags: [],
  summary: "A test email.",
  labels: [],
  actions: [],
};

function makeStore() {
  const threadDb = makeThreadDbMock();
  const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
  const processingDb = makeProcessingDbMock();
  // Override defaults for this test file
  vi.mocked(accountDb.listEnabledRules).mockReturnValue(Promise.resolve(ok(SYSTEM_RULES)));
  applyCtx(accountDb, DEFAULT_CTX);
  vi.mocked(accountDb.getSender).mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY)));
  return { threadDb, accountDb, processingDb };
}

function makeContentSanitizer(): ContentSanitizerClient {
  return {
    invoke: vi.fn().mockReturnValue(Promise.resolve(ok({
      success: true as const,
      parsed: {
        from: { address: "sender@example.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Test email",
        textBody: "Hello world",
        htmlBody: "<p>Hello world</p>",
        attachments: [],
        headers: { "authentication-results": "spf=pass dkim=pass" },
        sentAt: "2024-01-15T09:00:00Z",
      },
      urlMapping: {},
    }))),
  };
}

function makeClassifier(overrides: Partial<ClassificationOutput> = {}): Pick<SignalClassifier, "classify"> {
  return { classify: vi.fn().mockResolvedValue(ok({ ...validClassification, ...overrides })) };
}

function makeEmbeddingGenerator(): EmbeddingGenerator {
  return {
    generateForModel: vi.fn().mockResolvedValue(ok({ modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 })),
    generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
  };
}

function makeAuroraWriter(): MultiClusterAuroraWriter {
  return {
    upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
    findMatch: vi.fn().mockResolvedValue(ok(null)),
  };
}

function makeArcMatcher(): ThreadMatcherPort {
  return {
    findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  };
}

function makeRuleEvaluator(logger: MockLogger): RuleEvaluator {
  const mockUserCodeExecutor: UserCodeExecutorClient = { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() };
  const mockAnnotationStore = { annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
  return new JsonLogicRuleEvaluator(logger, mockUserCodeExecutor, mockAnnotationStore);
}

function makeMessage(opts: Partial<InboundSignalMessage> = {}): InboundSignalMessage {
  return {
    s3Key: "emails/msg-123",
    sesMessageId: "msg-123",
    compositeMailMessageId: "ses-msg-123",
    idempotencyKey: "test-idempotency-key",
    timestamp: "2024-01-15T10:00:00Z",
    destination: ["user@example.com"],
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
    ...opts,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "arc-existing",
    accountId: TEST_ACCOUNT_ID,
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "A test email.",
    lastSignalAt: "2024-01-10T00:00:00Z",
    createdAt: "2024-01-10T00:00:00Z",
    updatedAt: "2024-01-10T00:00:00Z",
    senderAddress: "sender@example.com",
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

function buildProcessor(threadDb: ReturnType<typeof makeThreadDbMock>, accountDb: ReturnType<typeof makeAccountDbMock>, processingDb: ReturnType<typeof makeProcessingDbMock>, threadMatcher: ThreadMatcherPort, classifier: Pick<SignalClassifier, "classify">, logger: MockLogger, ruleEvaluator: RuleEvaluator) {
  return new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never,
    ...makeSharedNewDeps(),
    threadDb,
    accountDb,
    processingDb,
    contentSanitizer: makeContentSanitizer(),
    s3Client: {} as never,
    emailBucket: "test-bucket",
    contentBucket: "test-content-bucket",
    classifier,
    embeddingGenerator: makeEmbeddingGenerator(),
    auroraWriter: makeAuroraWriter(),
    threadMatcher,
    ruleEvaluator,
    logger,
    notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
    retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
    replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
    sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
  });
}

// ---------------------------------------------------------------------------
// Tests — Processor delta computation for updateArc
// Validates: Requirements 7.5, 7.6, 7.7, 7.8
// ---------------------------------------------------------------------------

describe("Processor delta computation — updateArc vs saveArc", () => {
  let threadDb: ReturnType<typeof makeThreadDbMock>;
  let accountDb: ReturnType<typeof makeAccountDbMock>;
  let processingDb: ReturnType<typeof makeProcessingDbMock>;
  let threadMatcher: ThreadMatcherPort;
  let mockLogger: MockLogger;
  let ruleEvaluator: RuleEvaluator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    ({ threadDb, accountDb, processingDb } = makeStore());
    threadMatcher = makeArcMatcher();
    ruleEvaluator = makeRuleEvaluator(mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("existing active arc, no field changes → updateArc called with empty delta", async () => {
    // Classification returns same workflow+summary as existing arc → no optional fields in delta
    // Arc already has the system label that gets assigned during processing
    const existing = makeThread({ id: "arc-existing", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(threadDb, accountDb, processingDb, threadMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(threadDb.updateThread).toHaveBeenCalledOnce();
    const [accountId, arcId, status, lastSignalAt, fields] = vi.mocked(threadDb.updateThread).mock.calls[0]!;
    expect(accountId).toBe(TEST_ACCOUNT_ID);
    expect(arcId).toBe("arc-existing");
    expect(status).toBe("active");
    expect(lastSignalAt).toBe("2024-01-15T10:00:00Z");
    // Denormalized display fields are always refreshed from the latest inbound signal.
    // retentionDuration is backfilled from the account's configured retention since the
    // existing arc fixture predates retention tracking (no retentionDuration of its own).
    const denormalized = { senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email", retentionDuration: "P3M" };
    expect(fields).toEqual(denormalized);
    expect(threadDb.saveThread).not.toHaveBeenCalled();
  });

  it("existing arc with a stale retention → updateArc refreshes to the most recently resolved retention", async () => {
    // Arc carries a retention from an earlier signal (e.g. before the account's
    // configured retention changed) — the new signal's resolved retention takes over.
    const existing = makeThread({ id: "arc-existing", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"], retentionDuration: "P5Y" });
    vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(threadDb, accountDb, processingDb, threadMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(threadDb.updateThread).toHaveBeenCalledOnce();
    const [, , , , fields] = vi.mocked(threadDb.updateThread).mock.calls[0]!;
    expect(fields.retentionDuration).toBe("P3M");
  });

  it("existing archived arc → updateArc reactivates to active", async () => {
    // Arc was archived — new signal reactivates it
    const existing = makeThread({ id: "arc-archived", status: "archived", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(threadDb, accountDb, processingDb, threadMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(threadDb.updateThread).toHaveBeenCalledOnce();
    const [, , status, lastSignalAt, fields] = vi.mocked(threadDb.updateThread).mock.calls[0]!;
    expect(status).toBe("active");
    expect(lastSignalAt).toBe("2024-01-15T10:00:00Z");
    expect(fields).toEqual({ senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email", retentionDuration: "P3M" });
  });

  it("existing arc with archive rule → updateArc called with archived status", async () => {
    const existing = makeThread({ id: "arc-to-archive", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    // Rule that archives the arc
    const archiveRule: Rule = {
      id: "rule-archive", accountId: TEST_ACCOUNT_ID, name: "Archive",
      condition: "true", actions: [{ type: "archive" }],
      status: "enabled", priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
    };
    vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([archiveRule])));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(threadDb, accountDb, processingDb, threadMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(threadDb.updateThread).toHaveBeenCalledOnce();
    const [, , status, , fields] = vi.mocked(threadDb.updateThread).mock.calls[0]!;
    expect(status).toBe("archived");
    expect(fields).toEqual({ senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email", retentionDuration: "P3M" });
  });

  it("existing arc with changed labels → updateArc includes labels in delta", async () => {
    // Arc starts with system label only; rule adds "billing"
    const existing = makeThread({ id: "arc-labels", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    // Rule that adds a label
    const labelRule: Rule = {
      id: "rule-label", accountId: TEST_ACCOUNT_ID, name: "Add billing label",
      condition: "true", actions: [{ type: "assign_label", value: "billing" }],
      status: "enabled", priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
    };
    vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([labelRule])));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(threadDb, accountDb, processingDb, threadMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(threadDb.updateThread).toHaveBeenCalledOnce();
    const [, , status, , fields] = vi.mocked(threadDb.updateThread).mock.calls[0]!;
    expect(status).toBe("active");
    expect(fields).toEqual({ labels: ["system:workflow:conversation", "billing"], senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email", retentionDuration: "P3M" });
  });

  it("new arc (matchedArc is null) → saveArc called, not updateArc", async () => {
    // threadMatcher returns null (default) — no existing arc
    const classifier = makeClassifier();
    const processor = buildProcessor(threadDb, accountDb, processingDb, threadMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(threadDb.saveThread).toHaveBeenCalledOnce();
    expect(threadDb.updateThread).not.toHaveBeenCalled();
  });

  it("delete rule action type is not recognized — does not set arc status to deleted", async () => {
    // Verify that even if a rule somehow has type "delete", deriveOutcome ignores it
    // (the action type was removed from RuleActionType, but we test the processor's resilience)
    const existing = makeThread({ id: "arc-no-delete", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    // Manually craft a rule with a "delete" action — simulates legacy data
    const deleteRule: Rule = {
      id: "rule-delete", accountId: TEST_ACCOUNT_ID, name: "Delete rule",
      condition: "true", actions: [{ type: "delete" as never }],
      status: "enabled", priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
    };
    vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([deleteRule])));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(threadDb, accountDb, processingDb, threadMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(threadDb.updateThread).toHaveBeenCalledOnce();
    const [, , status] = vi.mocked(threadDb.updateThread).mock.calls[0]!;
    // Status should be "active" (reactivation default) — NOT "deleted"
    expect(status).toBe("active");
    expect(status).not.toBe("deleted");
  });

  it("matched thread — TTL is NOT refreshed on subsequent signals (product: expiry = createdAt + retention)", async () => {
    // Product expectation: thread TTL is computed once at creation time and pinned.
    // Subsequent signals update retentionDuration (metadata) but never recompute ttl.
    // This means the DynamoDB item expires at createdAt + original retention, regardless
    // of how many later signals arrive. The UI should display expiry relative to createdAt.
    const existingTtl = Math.floor(new Date("2024-01-10T00:00:00Z").getTime() / 1000) + 90 * 24 * 60 * 60; // createdAt + P3M
    const existing = makeThread({
      id: "arc-ttl-fixed",
      workflow: "conversation",
      summary: "A test email.",
      labels: ["system:workflow:conversation"],
      retentionDuration: "P3M",
      ttl: existingTtl,
    });
    vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(threadDb, accountDb, processingDb, threadMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(threadDb.updateThread).toHaveBeenCalledOnce();
    const [, , , , fields] = vi.mocked(threadDb.updateThread).mock.calls[0]!;
    // retentionDuration stays in sync with current config (not a change here, same value)
    // but crucially: no `ttl` field in the delta → DynamoDB item keeps its original TTL
    expect(fields).not.toHaveProperty("ttl");
  });
});
