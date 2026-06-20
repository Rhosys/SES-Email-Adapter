import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps } from "./_shared-new-deps.js";
import type { ArcMatcher, RuleEvaluator, InboundSignalMessage, SqsDispatcher, ProcessorAccountContext } from "../../src/processor/processor.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/arc-matcher.js";
import type { Arc, Rule, Alias, AliasSender } from "../../src/types/index.js";
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
    getPrimaryArcMatcherRegistry: () => entry,
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
  id: "cfg-default", accountId: TEST_ACCOUNT_ID, address: "user@example.com", domain: "example.com", alias: "user",
  unknownSenderPolicy: "quarantine_visible",
  createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_SENDER_ENTRY: AliasSender = {
  accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", alias: "user", senderDomain: "example.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_CTX = { retentionDuration: "P3M", filtering: null, aliasConfig: DEFAULT_ALIAS, registeredDomains: [], userEmails: [], billingPlan: "Paid" as const, onboardingCompleted: true } satisfies ProcessorAccountContext;

const validClassification: ClassificationOutput = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
  tags: [],
  summary: "A test email.",
  labels: [],
};

function makeStore() {
  const arcDb = makeArcDbMock();
  const accountDb = makeAccountDbMock();
  const processingDb = makeProcessingDbMock();
  // Override defaults for this test file
  vi.mocked(accountDb.listEnabledRules).mockReturnValue(Promise.resolve(ok(SYSTEM_RULES)));
  vi.mocked(accountDb.getProcessorAccountContext).mockReturnValue(Promise.resolve(ok(DEFAULT_CTX)));
  vi.mocked(accountDb.getSender).mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY)));
  return { arcDb, accountDb, processingDb };
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

function makeArcMatcher(): ArcMatcher {
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
    accountId: TEST_ACCOUNT_ID,
    s3Key: "emails/msg-123",
    sesMessageId: "msg-123",
    timestamp: "2024-01-15T10:00:00Z",
    destination: ["user@example.com"],
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
    ...opts,
  };
}

function makeArc(overrides: Partial<Arc> = {}): Arc {
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

function buildProcessor(arcDb: ReturnType<typeof makeArcDbMock>, accountDb: ReturnType<typeof makeAccountDbMock>, processingDb: ReturnType<typeof makeProcessingDbMock>, arcMatcher: ArcMatcher, classifier: Pick<SignalClassifier, "classify">, logger: MockLogger, ruleEvaluator: RuleEvaluator) {
  return new SignalProcessor({
    ...makeSharedNewDeps(),
    arcDb,
    accountDb,
    processingDb,
    contentSanitizer: makeContentSanitizer(),
    s3Client: {} as never,
    emailBucket: "test-bucket",
    contentBucket: "test-content-bucket",
    classifier,
    embeddingGenerator: makeEmbeddingGenerator(),
    auroraWriter: makeAuroraWriter(),
    arcMatcher,
    ruleEvaluator,
    logger,
    notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
    replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
    sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" },
  });
}

// ---------------------------------------------------------------------------
// Tests — Processor delta computation for updateArc
// Validates: Requirements 7.5, 7.6, 7.7, 7.8
// ---------------------------------------------------------------------------

describe("Processor delta computation — updateArc vs saveArc", () => {
  let arcDb: ReturnType<typeof makeArcDbMock>;
  let accountDb: ReturnType<typeof makeAccountDbMock>;
  let processingDb: ReturnType<typeof makeProcessingDbMock>;
  let arcMatcher: ArcMatcher;
  let mockLogger: MockLogger;
  let ruleEvaluator: RuleEvaluator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    ({ arcDb, accountDb, processingDb } = makeStore());
    arcMatcher = makeArcMatcher();
    ruleEvaluator = makeRuleEvaluator(mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("existing active arc, no field changes → updateArc called with empty delta", async () => {
    // Classification returns same workflow+summary as existing arc → no optional fields in delta
    // Arc already has the system label that gets assigned during processing
    const existing = makeArc({ id: "arc-existing", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(arcMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(arcDb, accountDb, processingDb, arcMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(arcDb.updateArc).toHaveBeenCalledOnce();
    const [accountId, arcId, status, lastSignalAt, fields] = vi.mocked(arcDb.updateArc).mock.calls[0]!;
    expect(accountId).toBe(TEST_ACCOUNT_ID);
    expect(arcId).toBe("arc-existing");
    expect(status).toBe("active");
    expect(lastSignalAt).toBe("2024-01-15T10:00:00Z");
    // Denormalized display fields are always refreshed from the latest inbound signal
    const denormalized = { senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email" };
    expect(fields).toEqual(denormalized);
    expect(arcDb.saveArc).not.toHaveBeenCalled();
  });

  it("existing archived arc → updateArc reactivates to active", async () => {
    // Arc was archived — new signal reactivates it
    const existing = makeArc({ id: "arc-archived", status: "archived", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(arcMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(arcDb, accountDb, processingDb, arcMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(arcDb.updateArc).toHaveBeenCalledOnce();
    const [, , status, lastSignalAt, fields] = vi.mocked(arcDb.updateArc).mock.calls[0]!;
    expect(status).toBe("active");
    expect(lastSignalAt).toBe("2024-01-15T10:00:00Z");
    expect(fields).toEqual({ senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email" });
  });

  it("existing arc with archive rule → updateArc called with archived status", async () => {
    const existing = makeArc({ id: "arc-to-archive", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(arcMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    // Rule that archives the arc
    const archiveRule: Rule = {
      id: "rule-archive", accountId: TEST_ACCOUNT_ID, name: "Archive",
      condition: "true", actions: [{ type: "archive" }],
      status: "enabled", priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
    };
    vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([archiveRule])));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(arcDb, accountDb, processingDb, arcMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(arcDb.updateArc).toHaveBeenCalledOnce();
    const [, , status, , fields] = vi.mocked(arcDb.updateArc).mock.calls[0]!;
    expect(status).toBe("archived");
    expect(fields).toEqual({ senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email" });
  });

  it("existing arc with changed labels → updateArc includes labels in delta", async () => {
    // Arc starts with system label only; rule adds "billing"
    const existing = makeArc({ id: "arc-labels", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(arcMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    // Rule that adds a label
    const labelRule: Rule = {
      id: "rule-label", accountId: TEST_ACCOUNT_ID, name: "Add billing label",
      condition: "true", actions: [{ type: "assign_label", value: "billing" }],
      status: "enabled", priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
    };
    vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([labelRule])));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(arcDb, accountDb, processingDb, arcMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(arcDb.updateArc).toHaveBeenCalledOnce();
    const [, , status, , fields] = vi.mocked(arcDb.updateArc).mock.calls[0]!;
    expect(status).toBe("active");
    expect(fields).toEqual({ labels: ["system:workflow:conversation", "billing"], senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email" });
  });

  it("new arc (matchedArc is null) → saveArc called, not updateArc", async () => {
    // arcMatcher returns null (default) — no existing arc
    const classifier = makeClassifier();
    const processor = buildProcessor(arcDb, accountDb, processingDb, arcMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(arcDb.saveArc).toHaveBeenCalledOnce();
    expect(arcDb.updateArc).not.toHaveBeenCalled();
  });

  it("delete rule action type is not recognized — does not set arc status to deleted", async () => {
    // Verify that even if a rule somehow has type "delete", deriveOutcome ignores it
    // (the action type was removed from RuleActionType, but we test the processor's resilience)
    const existing = makeArc({ id: "arc-no-delete", workflow: "conversation", summary: "A test email.", labels: ["system:workflow:conversation"] });
    vi.mocked(arcMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

    // Manually craft a rule with a "delete" action — simulates legacy data
    const deleteRule: Rule = {
      id: "rule-delete", accountId: TEST_ACCOUNT_ID, name: "Delete rule",
      condition: "true", actions: [{ type: "delete" as never }],
      status: "enabled", priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
    };
    vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([deleteRule])));

    const classifier = makeClassifier({ workflow: "conversation", summary: "A test email." });
    const processor = buildProcessor(arcDb, accountDb, processingDb, arcMatcher, classifier, mockLogger, ruleEvaluator);

    await processor.processRecord(makeMessage(), 1);

    expect(arcDb.updateArc).toHaveBeenCalledOnce();
    const [, , status] = vi.mocked(arcDb.updateArc).mock.calls[0]!;
    // Status should be "active" (reactivation default) — NOT "deleted"
    expect(status).toBe("active");
    expect(status).not.toBe("deleted");
  });
});
