import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { randomUUID } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "neverthrow";
import { SignalProcessor, deriveGroupingKey, SYSTEM_RULES, extractForwardedAddress } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { baseUrgency } from "../../src/processor/priority.js";
import type { ThreadMatcherPort, RuleEvaluator, Notifier,  ReplySender, InboundSignalMessage, SqsDispatcher } from "../../src/processor/processor.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { CtxLike } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Thread, Rule, Signal, Alias, AccountFilteringConfig } from "../../src/types/index.js";
import { dbError } from "../../src/errors.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import type { HandlerRegistry } from "../../src/workflow/registry.js";
import type { SchedulerClient } from "../../src/scheduler/scheduler-client.js";

// Mock cluster-registry so processor can resolve the read cluster
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

// Default context: sender example.com is pre-approved so most tests exercise the happy path without triggering the filter-mode fallback.
// Tests that specifically test sender filtering use explicit mockResolvedValueOnce overrides.
const DEFAULT_EMAIL_CONFIG: Alias = {
  id: "cfg-default", accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", aliasName: "user",
  unknownSenderPolicy: "quarantine_visible",
  createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
};

// Default AliasSender: marks example.com as an allowed sender for the default alias.
const DEFAULT_SENDER_ENTRY: import("../../src/types/index.js").AliasSender = {
  accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", aliasName: "user", senderDomain: "example.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z",
};
const DEFAULT_CTX = { retentionDuration: "P3M", filtering: null, aliasConfig: DEFAULT_EMAIL_CONFIG, registeredDomains: [], userEmails: [], billingPlan: "Paid" as const, onboardingCompleted: true } satisfies CtxLike;

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

function makeReplySender(): ReplySender {
  return {
    sendReply: vi.fn().mockResolvedValue(ok({ messageId: "pong-msg-001" })),
  };
}

function makeAlias(overrides: Partial<Alias> = {}): Alias {
  return {
    id: "cfg-001",
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    aliasName: "user",
    unknownSenderPolicy: "quarantine_visible",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// Helper to make an AliasSender entry (approved sender for a given alias+domain).
function makeAliasSenderConfig(domain: string, aliasAddress = "user@example.com"): import("../../src/types/index.js").AliasSender {
  return { accountId: TEST_ACCOUNT_ID, aliasAddress, domain: "example.com", aliasName: "user", senderDomain: domain, policy: "allow", addedAt: "2024-01-01T00:00:00Z" };
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

function makeClassifier(): Pick<SignalClassifier, "classify"> {
  return {
    classify: vi.fn().mockImplementation(() => Promise.resolve(ok({ ...validClassification }))),
  };
}

function makeEmbeddingGenerator(): EmbeddingGenerator {
  return {
    generateForModel: vi.fn().mockResolvedValue(
      ok({ modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 }),
    ),
    generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
  };
}

function makeAuroraWriter(): MultiClusterAuroraWriter {
  return {
    upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
    findMatch: vi.fn().mockResolvedValue(ok(null)),
  };
}

function makeThreadMatcher(): ThreadMatcherPort {
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

function makeNotifier(): Notifier {
  return {
    notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    
  };
}

const SHARED_NEW_DEPS = {
  userCodeExecutor: { invoke: vi.fn().mockResolvedValue({ success: true, result: undefined }), validateAst: vi.fn().mockResolvedValue({ success: true }), validateAstBatch: vi.fn().mockResolvedValue({ success: true }) } as unknown as UserCodeExecutorClient,
  billingHandler: new BillingHandler(),
  handlerRegistry: { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as HandlerRegistry,
  schedulerClient: { createFollowup: vi.fn().mockResolvedValue(ok(undefined)), deleteFollowup: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as SchedulerClient,
};

function makeMessage(opts: {
  accountId?: string;
  s3Key?: string;
  sesMessageId?: string;
  timestamp?: string;
  destination?: string[];
  dkimVerdict?: "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";
  dmarcVerdict?: "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";
} = {}): InboundSignalMessage {
  const sesMessageId = opts.sesMessageId ?? "msg-123";
  return {
    s3Key: opts.s3Key ?? `emails/${sesMessageId}`,
    sesMessageId,
    idempotencyKey: "test-idempotency-key",
    timestamp: opts.timestamp ?? "2024-01-15T10:00:00Z",
    destination: opts.destination ?? ["user@example.com"],
    dkimVerdict: opts.dkimVerdict ?? "PASS",
    dmarcVerdict: opts.dmarcVerdict ?? "PASS",
  };
}

const validClassification: ClassificationOutput = {
  workflow: "conversation",
  workflowData: {
    workflow: "conversation",
    sentiment: "neutral",
    requiresReply: false,
  },
  tags: [],
  summary: "A test personal email.",
  labels: [],
  actions: [],
};

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: randomUUID(),
    accountId: TEST_ACCOUNT_ID,
    name: "Test rule",
    condition: "true",
    actions: [],
    status: "enabled",
    priorityOrder: 100,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "arc-existing",
    accountId: TEST_ACCOUNT_ID,
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "Existing arc summary.",
    lastSignalAt: "2024-01-10T00:00:00Z",
    createdAt: "2024-01-10T00:00:00Z",
    updatedAt: "2024-01-10T00:00:00Z",
    senderAddress: "sender@example.com",
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SignalProcessor", () => {
  let threadDb: ReturnType<typeof makeThreadDbMock>;
  let accountDb: ReturnType<typeof makeAccountDbMock>;
  let processingDb: ReturnType<typeof makeProcessingDbMock>;
  let contentSanitizer: ContentSanitizerClient;
  let classifier: Pick<SignalClassifier, "classify">;
  let embeddingGenerator: EmbeddingGenerator;
  let auroraWriter: MultiClusterAuroraWriter;
  let threadMatcher: ThreadMatcherPort;
  let ruleEvaluator: RuleEvaluator;
  let processor: SignalProcessor;
  let mockLogger: MockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    ({ threadDb, accountDb, processingDb } = makeStore());
    contentSanitizer = makeContentSanitizer();
    classifier = makeClassifier();
    embeddingGenerator = makeEmbeddingGenerator();
    auroraWriter = makeAuroraWriter();
    threadMatcher = makeThreadMatcher();
    ruleEvaluator = makeRuleEvaluator(mockLogger);
    processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...SHARED_NEW_DEPS, threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, logger: mockLogger, notifier: makeNotifier(), forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path — new Arc
  // -------------------------------------------------------------------------

  describe("new signal with no matching Arc", () => {
    it("saves a Signal after classification", async () => {
      await processor.processRecord(makeMessage({ sesMessageId: "msg-abc" }), 1);

      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.id).toMatch(/^sgn-/);
      expect(saved.source).toBe("email");
      expect(saved.data.workflow).toBe("conversation");
      expect(saved.accountId).toBe(TEST_ACCOUNT_ID);
    });

    it("creates a new Arc when threadMatcher returns null", async () => {
      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveThread).toHaveBeenCalledOnce();
      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.id).toBeTruthy();
      expect(arc.status).toBe("active");
      expect(arc.accountId).toBe(TEST_ACCOUNT_ID);
    });

    it("links Signal to the newly created Arc", async () => {
      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.threadId).toBe(arc.id);
    });

    it("embeds the signal content and runs arc matching", async () => {
      await processor.processRecord(makeMessage(), 1);

      expect(embeddingGenerator.generateForModel).toHaveBeenCalledOnce();
      // personal workflow has no grouping key — falls back to vector search
      expect(threadMatcher.findMatch).toHaveBeenCalledOnce();
    });

    it("stores the embedding after saving", async () => {
      await processor.processRecord(makeMessage(), 1);

      expect(auroraWriter.upsertEmbedding).toHaveBeenCalledOnce();
    });

    it("sets Arc workflow and summary from classification", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        workflow: "payments",
        summary: "Receipt from Stripe for $99.",
        labels: ["billing"],
        workflowData: {
          workflow: "payments",
          paymentType: "receipt",
          vendor: "Stripe",
          amount: 99,
          currency: "USD",
        },
      }));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.workflow).toBe("payments");
      expect(arc.summary).toBe("Receipt from Stripe for $99.");
      expect(arc.labels).toContain("billing");
    });

    it("preserves from/to/subject from parsed MIME on the Signal", async () => {
      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.from.address).toBe("sender@example.com");
      expect(signal.data.subject).toBe("Test email");
    });

    it("sets recipientAddress from the SQS destination field", async () => {
      await processor.processRecord(makeMessage({ destination: ["inbox@customer.com"] }), 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.recipientAddress).toBe("inbox@customer.com");
    });
  });

  // -------------------------------------------------------------------------
  // Matching Arc
  // -------------------------------------------------------------------------

  describe("signal that matches an existing Arc", () => {
    it("links Signal to the existing Arc instead of creating a new one", async () => {
      const existing = makeThread({ id: "arc-existing" });
      vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.threadId).toBe("arc-existing");
    });

    it("updates Arc summary and lastSignalAt from new classification", async () => {
      const existing = makeThread({ id: "arc-existing", summary: "Old summary." });
      vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        summary: "Updated summary from new signal.",
      }));

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.updateThread).toHaveBeenCalledOnce();
      const [, arcId, status, , fields] = vi.mocked(threadDb.updateThread).mock.calls[0]!;
      expect(arcId).toBe("arc-existing");
      expect(status).toBe("active");
      expect(fields.summary).toBe("Updated summary from new signal.");
    });
  });

  // -------------------------------------------------------------------------
  // Rule evaluation
  // -------------------------------------------------------------------------

  describe("rule evaluation", () => {
    it("applies assign_label action when rule matches", async () => {
      const rule: Rule = {
        id: "rule-1",
        accountId: TEST_ACCOUNT_ID,
        name: "Label billing",
        condition: "true",
        actions: [{ type: "assign_label", value: "billing" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.labels).toContain("billing");
    });

    it("archives Arc when archive action matches", async () => {
      const rule: Rule = {
        id: "rule-2",
        accountId: TEST_ACCOUNT_ID,
        name: "Archive newsletters",
        condition: "true",
        actions: [{ type: "archive" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.status).toBe("archived");
    });

    it("does not apply rule when condition evaluates to false", async () => {
      const rule: Rule = {
        id: "rule-3",
        accountId: TEST_ACCOUNT_ID,
        name: "Never matches",
        condition: '{"==": [1, 2]}',
        actions: [{ type: "archive" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.status).toBe("active");
    });

    it("collects forward addresses from matching rules but does not call forwarder when none configured", async () => {
      const rule: Rule = {
        id: "rule-fwd",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward all",
        condition: "true",
        actions: [{ type: "forward", value: "backup@personal.com" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      // No error — processor without forwarder silently skips forward actions
      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // matchedRules
  // -------------------------------------------------------------------------

  describe("matchedRules", () => {
    it("writes matched rule with labelsAdded to signal", async () => {
      const rule: Rule = {
        id: "rule-label",
        accountId: TEST_ACCOUNT_ID,
        name: "Tag billing",
        condition: "true",
        actions: [{ type: "assign_label", value: "billing" }],
        status: "enabled",
        priorityOrder: 100,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.matchedRules).toHaveLength(1);
      expect(signal.data.matchedRules![0]!.ruleId).toBe("rule-label");
      expect(signal.data.matchedRules![0]!.labelsAdded).toContain("billing");
      expect(signal.data.matchedRules![0]!.statusChange).toBeUndefined();
    });

    it("writes statusChange on the matching rule for a quarantined signal", async () => {
      const rule: Rule = {
        id: "rule-quarantine",
        accountId: TEST_ACCOUNT_ID,
        name: "Quarantine unknown",
        condition: "true",
        actions: [{ type: "quarantine_visible" }],
        status: "enabled",
        priorityOrder: 100,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));
      applyCtx(accountDb, {
        ...DEFAULT_CTX,
        aliasConfig: { ...DEFAULT_EMAIL_CONFIG, unknownSenderPolicy: "allow_all" },
      }, { once: true });

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.status).toBe("quarantine_visible");
      expect(signal.data.matchedRules).toHaveLength(1);
      expect(signal.data.matchedRules![0]!.statusChange).toBe("quarantine_visible");
    });

    it("does not include rules that did not match", async () => {
      const matching: Rule = { ...makeRule({ id: "r-match", name: "Matches", condition: "true", actions: [{ type: "archive" }] }) };
      const nonMatching: Rule = { ...makeRule({ id: "r-skip", name: "Never", condition: '{"==": [1, 2]}', actions: [{ type: "block_hidden" }] }) };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([matching, nonMatching])));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.matchedRules?.map((r) => r.ruleId)).toEqual(["r-match"]);
    });
  });

  // -------------------------------------------------------------------------
  // Forwarding (dispatched via SQS side-effect)
  // -------------------------------------------------------------------------

  describe("forwarding", () => {
    let sqsDispatcher: SqsDispatcher;

    beforeEach(() => {
      sqsDispatcher = { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
      processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...SHARED_NEW_DEPS, threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, sqsDispatcher, logger: mockLogger, notifier: makeNotifier(), forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() } });
    });

    it("dispatches side-effect with forward action in matchedRules when forward rule matches", async () => {
      const rule: Rule = {
        id: "rule-fwd",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward to backup",
        condition: "true",
        actions: [{ type: "forward", value: "backup@personal.com" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage({ s3Key: "emails/msg-123" }), 1);

      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      const forwardActions = payload.signal.data.matchedRules?.flatMap((r) => r.actions.filter((a) => a.type === "forward"));
      expect(forwardActions).toContainEqual({ type: "forward", value: "backup@personal.com" });
    });

    it("includes multiple forward addresses in matchedRules when multiple forward actions match", async () => {
      const rule: Rule = {
        id: "rule-multi",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward to two addresses",
        condition: "true",
        actions: [
          { type: "forward", value: "first@example.com" },
          { type: "forward", value: "second@example.com" },
        ],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage(), 1);

      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      const forwardActions = payload.signal.data.matchedRules?.flatMap((r) => r.actions.filter((a) => a.type === "forward"));
      expect(forwardActions).toContainEqual({ type: "forward", value: "first@example.com" });
      expect(forwardActions).toContainEqual({ type: "forward", value: "second@example.com" });
    });

    it("does not include forward actions in matchedRules when rule does not match", async () => {
      const rule: Rule = {
        id: "rule-no-match",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward invoices",
        condition: '{"==": [1, 2]}',
        actions: [{ type: "forward", value: "accountant@firm.com" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage(), 1);

      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      const forwardActions = payload.signal.data.matchedRules?.flatMap((r) => r.actions.filter((a) => a.type === "forward")) ?? [];
      expect(forwardActions).toHaveLength(0);
    });

    it("dispatches side-effect after arc and signal are saved", async () => {
      const sqsMock = vi.mocked(sqsDispatcher.sendMessage);

      const rule: Rule = {
        id: "rule-fwd",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward all",
        condition: "true",
        actions: [{ type: "forward", value: "copy@example.com" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage(), 1);

      // saveSignal was called before sqsDispatcher.sendMessage
      const signalOrder = vi.mocked(threadDb.saveSignal).mock.invocationCallOrder[0]!;
      const dispatchOrder = sqsMock.mock.invocationCallOrder[0]!;
      expect(signalOrder).toBeLessThan(dispatchOrder);
    });

    it("continues processing when no forward rule matches", async () => {
      const rule: Rule = {
        id: "rule-fwd",
        accountId: TEST_ACCOUNT_ID,
        name: "Forward all",
        condition: "true",
        actions: [{ type: "forward", value: "copy@example.com" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage(), 1);

      // Signal was saved and side-effect dispatched
      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  describe("deduplication", () => {
    it("skips processing if Signal with same messageId already exists", async () => {
      vi.mocked(threadDb.getSignalByMessageId).mockReturnValueOnce(Promise.resolve(ok({
        id: "SES#msg-123",
      } as never)));

      await processor.processRecord(makeMessage({ sesMessageId: "msg-123" }), 1);

      expect(classifier.classify).not.toHaveBeenCalled();
      expect(threadDb.saveSignal).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Batch processing
  // -------------------------------------------------------------------------

  describe("batch processing", () => {
    it("processes all SQS records", async () => {
      const messages = [
        makeMessage({ sesMessageId: "msg-1" }),
        makeMessage({ sesMessageId: "msg-2" }),
        makeMessage({ sesMessageId: "msg-3" }),
      ];

      for (const message of messages) {
        await processor.processRecord(message, 1);
      }

      expect(classifier.classify).toHaveBeenCalledTimes(3);
      expect(threadDb.saveSignal).toHaveBeenCalledTimes(3);
    });

    it("continues processing remaining records when one fails", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("Bedrock error"))
        .mockResolvedValueOnce(ok(validClassification));

      const result1 = await processor.processRecord(makeMessage({ sesMessageId: "msg-fail" }), 1);
      const result2 = await processor.processRecord(makeMessage({ sesMessageId: "msg-ok" }), 1);

      expect(result1.isErr()).toBe(true);
      expect(result2.isOk()).toBe(true);
      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.id).toMatch(/^sgn-/);
      expect(saved.source).toBe("email");
    });
  });

  // -------------------------------------------------------------------------
  // Notifications (dispatched via SQS side-effect)
  // -------------------------------------------------------------------------

  describe("notifications", () => {
    let sqsDispatcher: SqsDispatcher;

    beforeEach(() => {
      sqsDispatcher = { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
      processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...SHARED_NEW_DEPS, threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, sqsDispatcher, logger: mockLogger, notifier: makeNotifier(), forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() } });
    });

    it("dispatches side-effect after saving a new Signal", async () => {
      await processor.processRecord(makeMessage(), 1);

      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
    });

    it("dispatches side-effect payload containing accountId, thread, and signal", async () => {
      await processor.processRecord(makeMessage(), 1);

      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      expect(payload.signal.accountId).toBe(TEST_ACCOUNT_ID);
      expect(payload.thread!.accountId).toBe(TEST_ACCOUNT_ID);
      expect(payload.signal.threadId).toBe(payload.thread!.id);
    });

    it("does not fail processing when sqsDispatcher returns err", async () => {
      vi.mocked(sqsDispatcher.sendMessage).mockReturnValueOnce(Promise.resolve(err(dbError(new Error("SQS error")))));

      const result = await processor.processRecord(makeMessage(), 1);

      // Signal was still saved
      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      // But the overall result is err because dispatch failed
      expect(result.isErr()).toBe(true);
    });

    it("dispatches side-effect even without explicit notifier configured", async () => {
      // Processor with default notifier — side-effect dispatch still happens
      const processorWithoutNotifier = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never,
        ...SHARED_NEW_DEPS,
        threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, logger: mockLogger,
        notifier: makeNotifier(), forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
        replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) }, sqsDispatcher,
        draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
        calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
      });

      await processorWithoutNotifier.processRecord(makeMessage(), 1);

      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Sender filtering
  // -------------------------------------------------------------------------

  describe("sender filtering", () => {
    let notifier: Notifier;

    beforeEach(() => {
      notifier = makeNotifier();
      processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...SHARED_NEW_DEPS, threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, notifier, logger: mockLogger, forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() } });
    });

    it("quarantines signal on brand new address when account filtering was never configured, and creates the alias (ingest invariant)", async () => {
      // No alias and no account-level filtering config saved (filtering: null in DEFAULT_CTX) — the
      // platform default (quarantine_visible) must apply rather than silently falling through to allow_all.
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: null }, { once: true });
      // No existing sender entry for a brand-new address
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));
      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      expect(threadDb.saveThread).not.toHaveBeenCalled();
      // The address is real, so its alias must exist even though the signal is quarantined; but no
      // sender disposition is recorded (the sender is unknown/pending until the user acts).
      expect(accountDb.ensureAlias).toHaveBeenCalledWith("acct-001", "user@example.com", "quarantine_visible", null);
      expect(accountDb.incrementStatMetric).toHaveBeenCalledWith("acct-001", "totalAliases", 1, expect.stringContaining(".alias"));
      expect(accountDb.saveSender).not.toHaveBeenCalled();

      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
    });

    it("does not create the alias when it already exists (known recipient)", async () => {
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: makeAlias() }, { once: true });
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      // aliasConfig present → the invariant skips the write entirely.
      expect(accountDb.ensureAlias).not.toHaveBeenCalled();
      expect(accountDb.incrementStatMetric).not.toHaveBeenCalledWith("acct-001", "totalAliases", 1, expect.anything());
    });

    it("allows signal from a known sender (eTLD+1 in approved list)", async () => {
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: makeAlias() }, { once: true });
      // getSender returns an approved entry for example.com (default mock already does this)

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      expect(threadDb.saveThread).toHaveBeenCalledOnce();
      expect(accountDb.saveAlias).not.toHaveBeenCalled(); // no auto-approve needed
    });

    it("unknown sender with default filter mode → quarantine_visible (shown in review queue)", async () => {
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: makeAlias() }, { once: true }); // default filterMode: quarantine_visible
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveThread).not.toHaveBeenCalled();
      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
      expect(saved.threadId).toBeUndefined();
    });

    it("filter mode quarantine_visible: unknown sender → quarantine_visible", async () => {
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: makeAlias({ unknownSenderPolicy: "quarantine_visible" }) }, { once: true });
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
    });

    it("filter mode quarantine_hidden: unknown sender → quarantine_hidden", async () => {
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: makeAlias({ unknownSenderPolicy: "quarantine_hidden" }) }, { once: true });
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_hidden");
    });

    it("silently blocks signal when a block_hidden rule matches", async () => {
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: makeAlias() }, { once: true });
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([
        makeRule({ condition: JSON.stringify({ "in": ["system:sender:untrusted", { var: "thread.labels" }] }), actions: [{ type: "block_hidden" }] }),
      ])));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("block_hidden");
    });

    it("bypasses filtering when signal matches an existing Arc", async () => {
      const existingArc: Thread = {
        id: "existing-arc",
        accountId: TEST_ACCOUNT_ID,
        workflow: "conversation",
        labels: [],
        status: "active",
        summary: "Existing conversation",
        lastSignalAt: "2024-01-14T10:00:00Z",
        createdAt: "2024-01-14T10:00:00Z",
        updatedAt: "2024-01-14T10:00:00Z",
        senderAddress: "sender@example.com",
        recipientAddress: "user@example.com",
        subject: "Test email",
      };
      vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existingArc)));

      await processor.processRecord(makeMessage(), 1);

      // Filtering fallback bypassed on matched arc — signal is active despite untrusted sender
      expect(threadDb.updateThread).toHaveBeenCalledOnce();
      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
    });

    it("allow_all mode auto-approves new sender without blocking", async () => {
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: makeAlias({ unknownSenderPolicy: "allow_all" }) }, { once: true });
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null))); // sender not yet in list

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveThread).toHaveBeenCalledOnce();
      expect(accountDb.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, expect.any(String), "example.com", "allow");
    });

    it("saves blocked signal with classification data for user review", async () => {
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: makeAlias() }, { once: true });
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.data.workflow).toBe(validClassification.workflow);
      expect(saved.data.summary).toBe(validClassification.summary);
      expect(saved.data.tags).toEqual(validClassification.tags);
    });

    it("quarantines new address when defaultUnknownSenderPolicy is quarantine_visible and no alias exists", async () => {
      applyCtx(accountDb, {
        retentionDuration: "P3M",
        filtering: { defaultUnknownSenderPolicy: "quarantine_visible" },
        aliasConfig: null,
        registeredDomains: [],
        userEmails: [],
        billingPlan: "Paid",
        onboardingCompleted: true,
      }, { once: true });

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveThread).not.toHaveBeenCalled();
      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      // aliasConfig is null → uses defaultUnknownSenderPolicy directly → system:sender:untrusted → quarantine_visible
      expect(saved.status).toBe("quarantine_visible");
    });
  });

  // -------------------------------------------------------------------------
  // Global reputation tracking
  // -------------------------------------------------------------------------

  describe("global reputation tracking", () => {
    it("updates reputation with per-status count for blocked signals", async () => {
      applyCtx(accountDb, { ...DEFAULT_CTX, aliasConfig: makeAlias() }, { once: true });
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      expect(processingDb.updateGlobalReputation).toHaveBeenCalledWith(
        "example.com",
        expect.stringMatching(/^(quarantine_visible|quarantine_hidden|block_hidden|block_reject|report_violation)$/),
      );
    });

    it("does not update reputation for allowed signals", async () => {
      await processor.processRecord(makeMessage(), 1);

      expect(processingDb.updateGlobalReputation).not.toHaveBeenCalled();
    });

    it("does not fail processing when updateGlobalReputation throws", async () => {
      vi.mocked(processingDb.updateGlobalReputation).mockRejectedValueOnce(new Error("DynamoDB error"));

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Arc grouping key
  // -------------------------------------------------------------------------

  describe("arc grouping key", () => {
    it("uses deterministic key lookup for auth signals instead of vector search", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", code: "123456", service: "GitHub" },
      }));

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.findThreadByGroupingKey).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "user@example.com:auth:example.com",
      );
      // All tiers now execute in parallel (R4) — threadMatcher.findMatch IS called
      // but the grouping key result takes priority in selection
    });

    it("stores groupingKey on a newly created arc", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", code: "123456", service: "GitHub" },
      }));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.groupingKey).toBe("user@example.com:auth:example.com");
    });

    it("reuses existing arc found by grouping key", async () => {
      const existing = makeThread({ id: "auth-arc", groupingKey: "user@example.com:auth:example.com" });
      vi.mocked(threadDb.findThreadByGroupingKey).mockReturnValueOnce(Promise.resolve(ok(existing)));
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", code: "999999", service: "GitHub" },
      }));

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.updateThread).toHaveBeenCalledOnce();
      const [, arcId] = vi.mocked(threadDb.updateThread).mock.calls[0]!;
      expect(arcId).toBe("auth-arc");
    });

    it("scopes vector search by recipientAddress for workflows without a grouping key", async () => {
      await processor.processRecord(makeMessage({ destination: ["inbox@work.com"] }), 1);

      expect(threadMatcher.findMatch).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "inbox@work.com",
        expect.any(Array),
      );
    });

    it("uses order number as grouping key when present", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        workflow: "package",
        workflowData: { workflow: "package", packageType: "shipping", retailer: "Amazon", orderNumber: "112-999" },
      }));

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.findThreadByGroupingKey).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "user@example.com:package:112-999",
      );
    });

    it("falls back to vector search for package without order number", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        workflow: "package",
        workflowData: { workflow: "package", packageType: "shipping", retailer: "Amazon" },
      }));

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.findThreadByGroupingKey).not.toHaveBeenCalled();
      expect(threadMatcher.findMatch).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Pure function unit tests
  // -------------------------------------------------------------------------

  describe("deriveGroupingKey", () => {
    it("returns recipientAddress:workflow:senderETLD1 for auth", () => {
      expect(deriveGroupingKey("auth", { workflow: "auth", authType: "otp", service: "GitHub" }, "me@example.com", "github.com"))
        .toBe("me@example.com:auth:github.com");
    });

    it("returns null for conversation (vector search)", () => {
      expect(deriveGroupingKey("conversation", { workflow: "conversation", sentiment: "neutral", requiresReply: false }, "me@example.com", "friend.com"))
        .toBeNull();
    });

    it("uses senderETLD1 grouping for test workflow", () => {
      expect(deriveGroupingKey("test", { workflow: "test", triggeredBy: "user" }, "me@example.com", "mydomain.com"))
        .toBe("me@example.com:test:mydomain.com");
    });

    it("uses senderETLD1 grouping for notice workflow (threads all notices from same sender)", () => {
      expect(deriveGroupingKey("notice", { workflow: "notice", noticeType: "privacy_policy", provider: "Google" }, "me@example.com", "google.com"))
        .toBe("me@example.com:notice:google.com");
    });

    it("uses senderETLD1 grouping for payments workflow", () => {
      expect(deriveGroupingKey("payments", { workflow: "payments", paymentType: "receipt", vendor: "Stripe" }, "me@example.com", "stripe.com"))
        .toBe("me@example.com:payments:stripe.com");
    });

    it("uses senderETLD1 grouping for content workflow", () => {
      expect(deriveGroupingKey("content", { workflow: "content", contentType: "newsletter", publisher: "TLDR" }, "me@example.com", "tldr.tech"))
        .toBe("me@example.com:content:tldr.tech");
    });

    it("uses senderETLD1 grouping for alert workflow", () => {
      expect(deriveGroupingKey("alert", { workflow: "alert", alertType: "suspicious_login", service: "GitHub", requiresAction: true }, "me@example.com", "github.com"))
        .toBe("me@example.com:alert:github.com");
    });

    it("uses orderNumber as key for package workflow when present", () => {
      expect(deriveGroupingKey("package", { workflow: "package", packageType: "shipping", retailer: "Amazon", orderNumber: "112-999" }, "me@example.com", "amazon.com"))
        .toBe("me@example.com:package:112-999");
    });

    it("returns null for package without orderNumber (falls back to vector search)", () => {
      expect(deriveGroupingKey("package", { workflow: "package", packageType: "shipping", retailer: "Amazon" }, "me@example.com", "amazon.com"))
        .toBeNull();
    });

    it("uses ticketId as key for support workflow when present", () => {
      expect(deriveGroupingKey("support", { workflow: "support", eventType: "ticket_updated", service: "Zendesk", ticketId: "ZD-4567" }, "me@example.com", "zendesk.com"))
        .toBe("me@example.com:support:ZD-4567");
    });

    it("returns null for support without ticketId (falls back to vector search)", () => {
      expect(deriveGroupingKey("support", { workflow: "support", eventType: "ticket_opened", service: "Zendesk" }, "me@example.com", "zendesk.com"))
        .toBeNull();
    });

    it("returns null for travel (vector search workflow)", () => {
      expect(deriveGroupingKey("travel", { workflow: "travel", travelType: "flight", provider: "Delta" }, "me@example.com", "delta.com"))
        .toBeNull();
    });
  });

  describe("baseUrgency", () => {
    it("auth is always critical", () => {
      expect(baseUrgency("auth", { workflow: "auth", authType: "otp", service: "GitHub" })).toBe("critical");
    });

    it("alert is critical when requiresAction=true", () => {
      expect(baseUrgency("alert", { workflow: "alert", alertType: "suspicious_login", service: "GitHub", requiresAction: true })).toBe("critical");
      expect(baseUrgency("alert", { workflow: "alert", alertType: "fraud_alert", service: "Chase", requiresAction: true })).toBe("critical");
      expect(baseUrgency("alert", { workflow: "alert", alertType: "ci_failure", service: "GitHub Actions", requiresAction: true })).toBe("critical");
    });

    it("alert is high when requiresAction=false", () => {
      expect(baseUrgency("alert", { workflow: "alert", alertType: "new_device", service: "GitHub", requiresAction: false })).toBe("high");
      expect(baseUrgency("alert", { workflow: "alert", alertType: "domain_expiry", service: "Cloudflare", requiresAction: false })).toBe("high");
    });

    it("payments is critical on payment_failed", () => {
      expect(baseUrgency("payments", { workflow: "payments", paymentType: "payment_failed", vendor: "Stripe" })).toBe("critical");
    });

    it("payments is normal for all other payment types", () => {
      expect(baseUrgency("payments", { workflow: "payments", paymentType: "invoice", vendor: "Stripe" })).toBe("normal");
      expect(baseUrgency("payments", { workflow: "payments", paymentType: "receipt", vendor: "AWS" })).toBe("normal");
      expect(baseUrgency("payments", { workflow: "payments", paymentType: "subscription_renewal", vendor: "GitHub" })).toBe("normal");
    });

    it("test is always high (user is actively waiting for inbox confirmation)", () => {
      expect(baseUrgency("test", { workflow: "test", triggeredBy: "user" })).toBe("high");
    });

    it("support falls through to normal (urgency handled by system rules SR-10–SR-14)", () => {
      expect(baseUrgency("support", { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "urgent" })).toBe("normal");
      expect(baseUrgency("support", { workflow: "support", eventType: "awaiting_response", service: "Zendesk" })).toBe("normal");
      expect(baseUrgency("support", { workflow: "support", eventType: "ticket_opened", service: "Zendesk" })).toBe("normal");
    });

    it("content is always low", () => {
      expect(baseUrgency("content", { workflow: "content", contentType: "newsletter", publisher: "TLDR" })).toBe("low");
      expect(baseUrgency("content", { workflow: "content", contentType: "promotion", publisher: "Nike" })).toBe("low");
    });

    it("notice is always silent", () => {
      expect(baseUrgency("notice", { workflow: "notice", noticeType: "privacy_policy", provider: "Google" })).toBe("silent");
      expect(baseUrgency("notice", { workflow: "notice", noticeType: "service_notice", provider: "Stripe" })).toBe("silent");
    });

    it("onboarding is always silent", () => {
      expect(baseUrgency("onboarding", { workflow: "onboarding", onboardingType: "welcome", service: "Acme" } as unknown as import("../../src/types/index.js").WorkflowData)).toBe("silent");
    });

    it("travel is normal (no special urgency boost)", () => {
      expect(baseUrgency("travel", { workflow: "travel", travelType: "flight", provider: "Delta" })).toBe("normal");
    });

    it("conversation falls through to normal (urgency handled by system rules SR-07–SR-08)", () => {
      expect(baseUrgency("conversation", { workflow: "conversation", sentiment: "urgent", requiresReply: true })).toBe("normal");
      expect(baseUrgency("conversation", { workflow: "conversation", sentiment: "positive", requiresReply: false })).toBe("normal");
      expect(baseUrgency("conversation", { workflow: "conversation", sentiment: "neutral", requiresReply: false })).toBe("normal");
    });

    it("crm falls through to normal (urgency handled by system rule SR-09)", () => {
      expect(baseUrgency("crm", { workflow: "crm" })).toBe("normal");
      expect(baseUrgency("crm", { workflow: "crm" })).toBe("normal");
      expect(baseUrgency("crm", { workflow: "crm" })).toBe("normal");
    });
  });

  // -------------------------------------------------------------------------
  // Workflow-specific urgency rules (SR-07–SR-14)
  // -------------------------------------------------------------------------

  describe("workflow urgency system rules", () => {
    async function processWithWorkflow(classification: Partial<ClassificationOutput>): Promise<Thread> {
      const full: ClassificationOutput = {
        workflow: "conversation",
        workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
        tags: [], summary: "test", labels: [], actions: [],
        ...classification,
      };
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(full));
      await processor.processRecord(makeMessage({ sesMessageId: randomUUID() }), 1);
      return vi.mocked(threadDb.saveThread).mock.calls.at(-1)![0] as Thread;
    }

    it("SR-07: conversation + requiresReply + urgent sentiment → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "conversation", workflowData: { workflow: "conversation", sentiment: "urgent", requiresReply: true } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-07: conversation + requiresReply + negative sentiment → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "conversation", workflowData: { workflow: "conversation", sentiment: "negative", requiresReply: true } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-08: conversation with no prior replies → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "conversation", workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-08: conversation with prior replies (system:replied) → not low (falls back to arc urgency)", async () => {
      vi.mocked(threadMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(makeThread({
        workflow: "conversation", labels: [], urgency: "normal",
        sentMessageIds: ["<prior-msg@example.com>"],
      }))));
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        workflow: "conversation", workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
        tags: [], summary: "test", labels: [], actions: [],
      }));
      await processor.processRecord(makeMessage({ sesMessageId: randomUUID() }), 1);
      const signal = vi.mocked(threadDb.saveSignal).mock.calls.at(-1)![0] as Signal;
      expect(signal.data.urgency).toBe("normal");
    });

    it("crm → normal urgency (crmType/urgency fields removed)", async () => {
      const arc = await processWithWorkflow({ workflow: "crm", workflowData: { workflow: "crm" } });
      expect(arc.urgency).toBe("normal");
    });

    it("SR-10: support + priority:urgent → critical urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "urgent" } });
      expect(arc.urgency).toBe("critical");
    });

    it("SR-11: support + priority:high → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "high" } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-12: support + awaiting_response → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "awaiting_response", service: "Zendesk" } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-13: support + priority:low → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "low" } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-14: support + ticket_opened → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_opened", service: "Zendesk" } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-14: support + ticket_resolved → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_resolved", service: "Zendesk" } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-10 wins over SR-14: support + priority:urgent + ticket_opened → critical (first-rule-wins)", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_opened", service: "Zendesk", priority: "urgent" } });
      expect(arc.urgency).toBe("critical");
    });

  });

  // -------------------------------------------------------------------------
  // Onboarding workflow
  // -------------------------------------------------------------------------

  describe("onboarding workflow", () => {
    const onboardingClassification: ClassificationOutput = {
      workflow: "onboarding" as import("../../src/types/index.js").Workflow,
      workflowData: { workflow: "onboarding", onboardingType: "welcome", service: "Acme App" } as unknown as import("../../src/types/index.js").WorkflowData,
      tags: [],
      summary: "Welcome to Acme App.",
      labels: [],
      actions: [],
    };

    it("processes onboarding emails as active when no blocking rule is configured", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(onboardingClassification));
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([]))); // no system rules — SR-03 (block onboarding) is disabled

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveThread).toHaveBeenCalledOnce();
      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
      expect(saved.data.workflow).toBe("onboarding");
    });

    it("blocks onboarding emails when a block rule targeting the onboarding workflow is active", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(onboardingClassification));
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([
        makeRule({ condition: JSON.stringify({ "==": [{ var: "signal.workflow" }, "onboarding"] }), actions: [{ type: "block_hidden" }] }),
      ])));

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...SHARED_NEW_DEPS, threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, notifier, logger: mockLogger, forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() } });
      await proc.processRecord(makeMessage(), 1);

      expect(threadDb.saveThread).not.toHaveBeenCalled();
      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("block_hidden");
    });

    it("quarantines onboarding emails when a quarantine rule is active", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(onboardingClassification));
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([
        makeRule({ condition: JSON.stringify({ "==": [{ var: "signal.workflow" }, "onboarding"] }), actions: [{ type: "quarantine_visible" }] }),
      ])));

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...SHARED_NEW_DEPS, threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, notifier, logger: mockLogger, forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() } });
      await proc.processRecord(makeMessage(), 1);

      expect(threadDb.saveThread).not.toHaveBeenCalled();
      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      // Plain `quarantine` action → quarantine_visible (shown in review queue)
      expect(saved.status).toBe("quarantine_visible");
    });
  });

  // -------------------------------------------------------------------------
  // Test email detection
  // -------------------------------------------------------------------------

  describe("test email detection", () => {
    it("overrides workflow to 'test' when the from-domain is one the account owns", async () => {
      // Default mime parser mock returns from: { address: "sender@example.com" }
      // getETLD1("sender@example.com") = "example.com" — a domain owned by the account.
      vi.mocked(accountDb.listDomains).mockReturnValueOnce(Promise.resolve(ok([{
        accountId: TEST_ACCOUNT_ID, domain: "example.com", status: "active", receivingSetupComplete: true, senderSetupComplete: true, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      } as never])));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.workflow).toBe("test");
      expect(signal.data.workflowData).toMatchObject({ workflow: "test", triggeredBy: "user" });
    });

    it("does not override workflow when the from-domain is not owned by the account", async () => {
      // Default listDomains mock returns [] → sender domain is not the account's own.
      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.workflow).toBe("conversation"); // unchanged from validClassification mock
    });
  });

  // -------------------------------------------------------------------------
  // Recipient → account/alias resolution (done inside the processor)
  // -------------------------------------------------------------------------

  describe("recipient resolution", () => {
    it("resolves via the alias when one matches (domain owner never consulted)", async () => {
      vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(ok(DEFAULT_EMAIL_CONFIG)));

      await processor.processRecord(makeMessage(), 1);

      expect(accountDb.getDomainOwner).not.toHaveBeenCalled();
      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.accountId).toBe(TEST_ACCOUNT_ID);
    });

    it("falls back to the domain owner when no alias matches", async () => {
      vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(ok(null)));
      vi.mocked(accountDb.getDomainOwner).mockReturnValue(Promise.resolve(ok({
        accountId: TEST_ACCOUNT_ID, domain: "example.com", status: "active", receivingSetupComplete: true, senderSetupComplete: true, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      } as never)));

      await processor.processRecord(makeMessage(), 1);

      expect(accountDb.getDomainOwner).toHaveBeenCalledOnce();
      expect(threadDb.saveSignal).toHaveBeenCalledOnce();
      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.accountId).toBe(TEST_ACCOUNT_ID);
    });

    it("drops the message when no alias and no active domain owner", async () => {
      vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(ok(null)));
      vi.mocked(accountDb.getDomainOwner).mockReturnValue(Promise.resolve(ok(null)));

      const result = await processor.processRecord(makeMessage(), 1);

      expect(result.isOk()).toBe(true);
      expect(threadDb.saveSignal).not.toHaveBeenCalled();
    });

    it("drops the message when the only domain owner is soft-deleted", async () => {
      vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(ok(null)));
      vi.mocked(accountDb.getDomainOwner).mockReturnValue(Promise.resolve(ok({
        accountId: TEST_ACCOUNT_ID, domain: "example.com", status: "deleted", receivingSetupComplete: true, senderSetupComplete: true, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      } as never)));

      const result = await processor.processRecord(makeMessage(), 1);

      expect(result.isOk()).toBe(true);
      expect(threadDb.saveSignal).not.toHaveBeenCalled();
    });

    it("reprocessSignal re-derives the account/alias from the recipient rather than trusting its argument", async () => {
      const storedSignal = {
        id: "sgn-reprocess", signalLookupId: "ses-msg-reprocess", accountId: TEST_ACCOUNT_ID,
        status: "active", source: "email", type: "email", labels: [], createdAt: "2024-01-15T10:00:00Z",
        data: { sesMessageId: "msg-reprocess", s3Key: "emails/msg-reprocess", recipientAddress: "user@example.com", receivedAt: "2024-01-15T10:00:00Z" },
      };
      (threadDb as unknown as { getSignalById: ReturnType<typeof vi.fn> }).getSignalById =
        vi.fn().mockReturnValue(Promise.resolve(ok(storedSignal)));
      (threadDb as unknown as { getSignalByMessageId: ReturnType<typeof vi.fn> }).getSignalByMessageId =
        vi.fn().mockReturnValue(Promise.resolve(ok(storedSignal)));
      vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(ok(DEFAULT_EMAIL_CONFIG)));

      const result = await processor.reprocessSignal(TEST_ACCOUNT_ID, "sgn-reprocess", "thr-test");

      expect(result.isOk()).toBe(true);
      // Re-derivation ran against the recipient address from the stored signal.
      expect(accountDb.getAliasByGlobalAddress).toHaveBeenCalledWith("user@example.com");
    });

    it("tracks a mismatch but proceeds with the derived accountId when expectedAccountId disagrees", async () => {
      vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(ok(DEFAULT_EMAIL_CONFIG)));

      await processor.processRecord({ ...makeMessage(), expectedAccountId: "acct-someone-else" }, 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.accountId).toBe(TEST_ACCOUNT_ID); // derived value wins
      const mismatchLog = mockLogger.calls.find(c => c.context?.code === "processor.account_id_mismatch");
      expect(mismatchLog).toBeDefined();
      expect(mismatchLog!.context).toMatchObject({ derivedAccountId: TEST_ACCOUNT_ID, expectedAccountId: "acct-someone-else" });
    });
  });

  // -------------------------------------------------------------------------
  // Reprocess — original thread recency repair when a signal moves off it
  // -------------------------------------------------------------------------
  describe("reprocess thread recency repair", () => {
    const OLD_THREAD = "thr-old";
    // Signal returned by getSignalByMessageId after reprocess — reassigned to a new thread.
    const reassignedSignal = {
      id: "sgn-reprocess", signalLookupId: "ses-msg-reprocess", accountId: TEST_ACCOUNT_ID, threadId: "thr-new",
      status: "active", source: "email", type: "email", labels: [], createdAt: "2024-01-15T10:00:00Z",
      data: { sesMessageId: "msg-reprocess", s3Key: "emails/msg-reprocess", recipientAddress: "user@example.com", receivedAt: "2024-01-15T10:00:00Z" },
    };

    beforeEach(() => {
      (threadDb as unknown as { getSignalById: ReturnType<typeof vi.fn> }).getSignalById =
        vi.fn().mockReturnValue(Promise.resolve(ok(reassignedSignal)));
      (threadDb as unknown as { getSignalByMessageId: ReturnType<typeof vi.fn> }).getSignalByMessageId =
        vi.fn().mockReturnValue(Promise.resolve(ok(reassignedSignal)));
      vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(ok(DEFAULT_EMAIL_CONFIG)));
      vi.mocked(threadDb.getThread).mockReturnValue(Promise.resolve(ok({ id: OLD_THREAD, accountId: TEST_ACCOUNT_ID, status: "active", lastSignalAt: "2024-05-01T00:00:00Z" } as never)));
    });

    it("recomputes the old thread's lastSignalAt from its newest remaining signal", async () => {
      vi.mocked(threadDb.listSignals).mockReturnValue(Promise.resolve(ok({ items: [
        { data: { receivedAt: "2024-02-01T00:00:00Z" } },
        { data: { receivedAt: "2024-04-10T00:00:00Z" } },
        { data: { receivedAt: "2024-03-01T00:00:00Z" } },
      ] } as never)));

      const result = await processor.reprocessSignal(TEST_ACCOUNT_ID, "sgn-reprocess", OLD_THREAD);

      expect(result.isOk()).toBe(true);
      expect(threadDb.updateThread).toHaveBeenCalledWith(TEST_ACCOUNT_ID, OLD_THREAD, "active", "2024-04-10T00:00:00Z", {});
    });

    it("sets the old thread's lastSignalAt to the Unix epoch when no signals remain", async () => {
      vi.mocked(threadDb.listSignals).mockReturnValue(Promise.resolve(ok({ items: [] } as never)));

      const result = await processor.reprocessSignal(TEST_ACCOUNT_ID, "sgn-reprocess", OLD_THREAD);

      expect(result.isOk()).toBe(true);
      expect(threadDb.updateThread).toHaveBeenCalledWith(TEST_ACCOUNT_ID, OLD_THREAD, "active", "1970-01-01T00:00:00.000Z", {});
    });

    it("does not touch the old thread when the signal stays on it", async () => {
      const sameThreadSignal = { ...reassignedSignal, threadId: OLD_THREAD };
      (threadDb as unknown as { getSignalByMessageId: ReturnType<typeof vi.fn> }).getSignalByMessageId =
        vi.fn().mockReturnValue(Promise.resolve(ok(sameThreadSignal)));

      const result = await processor.reprocessSignal(TEST_ACCOUNT_ID, "sgn-reprocess", OLD_THREAD);

      expect(result.isOk()).toBe(true);
      expect(threadDb.updateThread).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Notice workflow arc behavior
  // -------------------------------------------------------------------------

  const noticeClassification: ClassificationOutput = {
    workflow: "notice",
    workflowData: { workflow: "notice", noticeType: "privacy_policy", provider: "Google" },
    tags: [],
    summary: "Privacy policy update from Google.",
    labels: [],
    actions: [],
  };

  describe("notice workflow arc behavior", () => {
    let notifier: Notifier;

    beforeEach(() => {
      notifier = makeNotifier();
      processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...SHARED_NEW_DEPS, threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, notifier, logger: mockLogger, forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() } });
    });

    it("blocks notice emails silently — no arc created, signal saved as blocked", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(noticeClassification));

      await processor.processRecord(makeMessage(), 1);

      expect(threadDb.saveThread).not.toHaveBeenCalled();
      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.status).toBe("block_hidden");
      expect(signal.data.workflow).toBe("notice");
    });

    it("does not call notifier for a blocked notice email", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(noticeClassification));

      await processor.processRecord(makeMessage(), 1);

      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("blocks notice emails from untrusted senders (SR-04 rule fires, fallback does not apply)", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(noticeClassification));
      // Untrusted sender: no approved sender entry — filter-mode fallback would quarantine, but SR-04 fires first
      applyCtx(accountDb, {
        ...DEFAULT_CTX,
        aliasConfig: makeAlias(),
      }, { once: true });
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.status).toBe("block_hidden"); // SR-04 sets status → fallback skipped (hasStatusOutcome = true)
      expect(threadDb.saveThread).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Pong auto-reply (test workflow)
  // -------------------------------------------------------------------------

  const testClassification: ClassificationOutput = {
    workflow: "test",
    workflowData: { workflow: "test", triggeredBy: "user" },
    tags: [],
    summary: "Test email from account owner.",
    labels: [],
    actions: [],
  };

  describe("pong auto-reply", () => {
    let sqsDispatcher: SqsDispatcher;

    beforeEach(() => {
      sqsDispatcher = { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
      processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...SHARED_NEW_DEPS, threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, sqsDispatcher, logger: mockLogger, notifier: makeNotifier(), forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: makeReplySender(), draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() } });
    });

    it("dispatches side-effect with pong action when workflow is 'test'", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(testClassification));

      await processor.processRecord(makeMessage(), 1);

      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      const pongActions = payload.signal.data.matchedRules?.flatMap((r) => r.actions.filter((a) => a.type === "pong")) ?? [];
      expect(pongActions.length).toBeGreaterThan(0);
    });

    it("dispatches side-effect payload with signal containing from address and subject for pong", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(testClassification));

      await processor.processRecord(makeMessage(), 1);

      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      // Default mime parser mock: from.address = "sender@example.com", subject = "Test email"
      expect(payload.signal.data.from.address).toBe("sender@example.com");
      expect(payload.signal.data.subject).toBe("Test email");
    });

    it("dispatches side-effect with recipientAddress for pong from-address resolution", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(testClassification));

      await processor.processRecord(makeMessage(), 1);

      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      expect(payload.signal.data.recipientAddress).toBe("user@example.com");
    });

    it("dispatches side-effect with signal.id as sgn- prefixed ID for inReplyTo", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(testClassification));

      await processor.processRecord(makeMessage({ sesMessageId: "original-ses-123" }), 1);

      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      expect(payload.signal.id).toMatch(/^sgn-/);
    });

    it("does not include pong action for non-test workflows", async () => {
      // classifier returns conversation by default (no mockResolvedValueOnce override)
      await processor.processRecord(makeMessage(), 1);

      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      const pongActions = payload.signal.data.matchedRules?.flatMap((r) => r.actions.filter((a) => a.type === "pong")) ?? [];
      expect(pongActions).toHaveLength(0);
    });

    it("still dispatches side-effect when replySender is configured", async () => {
      const processorWithReplier = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...SHARED_NEW_DEPS, threadDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, threadMatcher, ruleEvaluator, logger: mockLogger, notifier: makeNotifier(), forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) }, sqsDispatcher, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() } });
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(testClassification));

      const result = await processorWithReplier.processRecord(makeMessage(), 1);
      expect(result.isOk()).toBe(true);
      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
    });

    it("dispatches side-effect with signal.recipientAddress containing the domain for lookup", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(testClassification));

      await processor.processRecord(makeMessage({ destination: ["me@custom-domain.com"] }), 1);

      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      expect(payload.signal.data.recipientAddress).toBe("me@custom-domain.com");
    });
  });

  // -------------------------------------------------------------------------
  // DKIM/DMARC block — emails failing verification are rejected at pipeline entry
  // -------------------------------------------------------------------------

  describe("DKIM/DMARC block at pipeline entry", () => {
    it("blocks email and saves signal with block_reject status when DKIM fails", async () => {
      await processor.processRecord(makeMessage({ dkimVerdict: "FAIL", dmarcVerdict: "PASS" }), 1);

      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("block_reject");
      expect(threadDb.saveThread).not.toHaveBeenCalled();
    });

    it("blocks email and saves signal with block_reject status when DMARC fails", async () => {
      await processor.processRecord(makeMessage({ dkimVerdict: "PASS", dmarcVerdict: "FAIL" }), 1);

      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("block_reject");
      expect(threadDb.saveThread).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Rule actions: assign_workflow and delete
  // -------------------------------------------------------------------------

  describe("rule actions — assign_workflow and delete", () => {
    it("assign_workflow action changes the arc workflow to the specified value", async () => {
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([{
        id: "rw-rule",
        accountId: TEST_ACCOUNT_ID,
        name: "Reclassify as content",
        condition: "true",
        actions: [{ type: "assign_workflow", value: "content" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }])));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.workflow).toBe("content");
    });

    it("multiple actions in one rule are all applied in order", async () => {
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([{
        id: "multi-rule",
        accountId: TEST_ACCOUNT_ID,
        name: "Label and archive",
        condition: "true",
        actions: [
          { type: "assign_label", value: "archived-auto" },
          { type: "archive" },
        ],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }])));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.labels).toContain("archived-auto");
      expect(arc.status).toBe("archived");
    });

    it("assign_workflow propagates to signal.data.workflow (C.1)", async () => {
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([{
        id: "rw-propagate",
        accountId: TEST_ACCOUNT_ID,
        name: "Reclassify signal as content",
        condition: "true",
        actions: [{ type: "assign_workflow", value: "content" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }])));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.data.workflow).toBe("content");
    });

    it("assign_workflow still updates thread workflow during rule evaluation (C.2 — existing behavior)", async () => {
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([{
        id: "rw-thread",
        accountId: TEST_ACCOUNT_ID,
        name: "Reclassify thread as content",
        condition: "true",
        actions: [{ type: "assign_workflow", value: "content" }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }])));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.workflow).toBe("content");
    });

    it("last assign_workflow wins when multiple rules fire (C.3)", async () => {
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([
        {
          id: "rw-first",
          accountId: TEST_ACCOUNT_ID,
          name: "Set content",
          condition: "true",
          actions: [{ type: "assign_workflow", value: "content" }],
          status: "enabled",
          priorityOrder: 0,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "rw-second",
          accountId: TEST_ACCOUNT_ID,
          name: "Set notification",
          condition: "true",
          actions: [{ type: "assign_workflow", value: "notification" }],
          status: "enabled",
          priorityOrder: 1,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ])));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.data.workflow).toBe("notification");
      // Thread also gets last-wins
      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.workflow).toBe("notification");
    });
  });

  describe("forwarded email detection", () => {
    it("attaches original:* label when X-Forwarded-To header is present", async () => {
      vi.mocked(contentSanitizer.invoke).mockReturnValueOnce(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: "sender@example.com", name: "Sender" },
          to: [{ address: "user@example.com" }],
          cc: [],
          subject: "Forwarded email",
          textBody: "Hello",
          attachments: [],
          headers: { "x-forwarded-to": "john@gmail.com" },
        },
        urlMapping: {},
      })));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.labels).toContain("original:john@gmail.com");
    });

    it("extracts address from X-Original-To header with angle brackets", async () => {
      vi.mocked(contentSanitizer.invoke).mockReturnValueOnce(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: "sender@example.com", name: "Sender" },
          to: [{ address: "user@example.com" }],
          cc: [],
          subject: "Forwarded email",
          textBody: "Hello",
          attachments: [],
          headers: { "x-original-to": "<alice@example.com>" },
        },
        urlMapping: {},
      })));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.labels).toContain("original:alice@example.com");
    });

    it("extracts address from Resent-To header with display name", async () => {
      vi.mocked(contentSanitizer.invoke).mockReturnValueOnce(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: "sender@example.com", name: "Sender" },
          to: [{ address: "user@example.com" }],
          cc: [],
          subject: "Forwarded email",
          textBody: "Hello",
          attachments: [],
          headers: { "resent-to": "Bob Smith <bob@example.com>" },
        },
        urlMapping: {},
      })));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.labels).toContain("original:bob@example.com");
    });

    it("X-Forwarded-To takes priority over X-Original-To when both are present", async () => {
      vi.mocked(contentSanitizer.invoke).mockReturnValueOnce(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: "sender@example.com", name: "Sender" },
          to: [{ address: "user@example.com" }],
          cc: [],
          subject: "Forwarded email",
          textBody: "Hello",
          attachments: [],
          headers: {
            "x-forwarded-to": "primary@gmail.com",
            "x-original-to": "secondary@gmail.com",
          },
        },
        urlMapping: {},
      })));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.labels).toContain("original:primary@gmail.com");
      expect(arc.labels).not.toContain("original:secondary@gmail.com");
    });

    it("does not attach any original:* label when no forwarding headers are present", async () => {
      vi.mocked(contentSanitizer.invoke).mockReturnValueOnce(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: "sender@example.com", name: "Sender" },
          to: [{ address: "user@example.com" }],
          cc: [],
          subject: "Regular email",
          textBody: "Hello",
          attachments: [],
          headers: { "authentication-results": "spf=pass" },
        },
        urlMapping: {},
      })));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(threadDb.saveThread).mock.calls[0]![0] as Thread;
      expect(arc.labels.some((l) => l.startsWith("original:"))).toBe(false);
    });
  });

  describe("extractForwardedAddress", () => {
    it("returns null when no forwarding headers present", () => {
      expect(extractForwardedAddress({ "content-type": "text/plain" })).toBeNull();
    });

    it("returns bare address from X-Forwarded-To", () => {
      expect(extractForwardedAddress({ "x-forwarded-to": "john@gmail.com" })).toBe("john@gmail.com");
    });

    it("returns address from angle-bracket form", () => {
      expect(extractForwardedAddress({ "x-original-to": "<alice@example.com>" })).toBe("alice@example.com");
    });

    it("returns address from display-name form", () => {
      expect(extractForwardedAddress({ "resent-to": "Bob Smith <bob@example.com>" })).toBe("bob@example.com");
    });

    it("is case-insensitive for header names", () => {
      expect(extractForwardedAddress({ "X-Forwarded-To": "carol@example.com" })).toBe("carol@example.com");
    });
  });
});
