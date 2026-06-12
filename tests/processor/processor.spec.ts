import { randomUUID } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "neverthrow";
import { SignalProcessor, deriveGroupingKey, SYSTEM_RULES, extractForwardedAddress } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { baseUrgency } from "../../src/processor/priority.js";
import type { ArcMatcher, RuleEvaluator, Notifier, Forwarder, ReplySender, InboundSignalMessage, SqsDispatcher } from "../../src/processor/processor.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/arc-matcher.js";
import type { Arc, Rule, Signal, Alias, AccountFilteringConfig } from "../../src/types/index.js";
import { dbError } from "../../src/errors.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
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

// Default context: sender example.com is pre-approved so most tests exercise the happy path without triggering the filter-mode fallback.
// Tests that specifically test sender filtering use explicit mockResolvedValueOnce overrides.
const DEFAULT_EMAIL_CONFIG: Alias = {
  id: "cfg-default", accountId: "acct-test-001", address: "user@example.com", domain: "example.com", alias: "user",
  unknownSenderPolicy: "quarantine_visible",
  createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
};

// Default AliasSender: marks example.com as an allowed sender for the default alias.
const DEFAULT_SENDER_ENTRY: import("../../src/types/index.js").AliasSender = {
  accountId: "acct-test-001", aliasAddress: "user@example.com", domain: "example.com", alias: "user", senderDomain: "example.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z",
};
const DEFAULT_CTX = { retentionDays: 0, filtering: null, emailConfig: DEFAULT_EMAIL_CONFIG, registeredDomains: [], userEmails: [], billingPlan: "Paid" as const, onboardingCompleted: true };

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

function makeReplySender(): ReplySender {
  return {
    sendReply: vi.fn().mockResolvedValue({ messageId: "pong-msg-001" }),
  };
}

function makeAlias(overrides: Partial<Alias> = {}): Alias {
  return {
    id: "cfg-001",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    domain: "example.com",
    alias: "user",
    unknownSenderPolicy: "quarantine_visible",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// Helper to make an AliasSender entry (approved sender for a given alias+domain).
function makeSenderEntry(domain: string, aliasAddress = "user@example.com"): import("../../src/types/index.js").AliasSender {
  return { accountId: TEST_ACCOUNT_ID, aliasAddress, domain: "example.com", alias: "user", senderDomain: domain, policy: "allow", addedAt: "2024-01-01T00:00:00Z" };
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
    accountId: opts.accountId ?? TEST_ACCOUNT_ID,
    s3Key: opts.s3Key ?? `emails/${sesMessageId}`,
    sesMessageId,
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
  spamScore: 0.05,
  summary: "A test personal email.",
  labels: [],
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

function makeArc(overrides: Partial<Arc> = {}): Arc {
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SignalProcessor", () => {
  let arcDb: ReturnType<typeof makeArcDbMock>;
  let accountDb: ReturnType<typeof makeAccountDbMock>;
  let processingDb: ReturnType<typeof makeProcessingDbMock>;
  let contentSanitizer: ContentSanitizerClient;
  let classifier: Pick<SignalClassifier, "classify">;
  let embeddingGenerator: EmbeddingGenerator;
  let auroraWriter: MultiClusterAuroraWriter;
  let arcMatcher: ArcMatcher;
  let ruleEvaluator: RuleEvaluator;
  let processor: SignalProcessor;
  let mockLogger: MockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    ({ arcDb, accountDb, processingDb } = makeStore());
    contentSanitizer = makeContentSanitizer();
    classifier = makeClassifier();
    embeddingGenerator = makeEmbeddingGenerator();
    auroraWriter = makeAuroraWriter();
    arcMatcher = makeArcMatcher();
    ruleEvaluator = makeRuleEvaluator(mockLogger);
    processor = new SignalProcessor({ ...SHARED_NEW_DEPS, arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, logger: mockLogger, notifier: makeNotifier(), forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" } });
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

      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.id).toMatch(/^sgn-/);
      expect(saved.source).toBe("email");
      expect(saved.data.workflow).toBe("conversation");
      expect(saved.accountId).toBe(TEST_ACCOUNT_ID);
    });

    it("creates a new Arc when arcMatcher returns null", async () => {
      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveArc).toHaveBeenCalledOnce();
      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.id).toBeTruthy();
      expect(arc.status).toBe("active");
      expect(arc.accountId).toBe(TEST_ACCOUNT_ID);
    });

    it("links Signal to the newly created Arc", async () => {
      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.arcId).toBe(arc.id);
    });

    it("embeds the signal content and runs arc matching", async () => {
      await processor.processRecord(makeMessage(), 1);

      expect(embeddingGenerator.generateForModel).toHaveBeenCalledOnce();
      // personal workflow has no grouping key — falls back to vector search
      expect(arcMatcher.findMatch).toHaveBeenCalledOnce();
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.workflow).toBe("payments");
      expect(arc.summary).toBe("Receipt from Stripe for $99.");
      expect(arc.labels).toContain("billing");
    });

    it("preserves from/to/subject from parsed MIME on the Signal", async () => {
      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.from.address).toBe("sender@example.com");
      expect(signal.data.subject).toBe("Test email");
    });

    it("sets recipientAddress from the SQS destination field", async () => {
      await processor.processRecord(makeMessage({ destination: ["inbox@customer.com"] }), 1);

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.recipientAddress).toBe("inbox@customer.com");
    });
  });

  // -------------------------------------------------------------------------
  // Matching Arc
  // -------------------------------------------------------------------------

  describe("signal that matches an existing Arc", () => {
    it("links Signal to the existing Arc instead of creating a new one", async () => {
      const existing = makeArc({ id: "arc-existing" });
      vi.mocked(arcMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.arcId).toBe("arc-existing");
    });

    it("updates Arc summary and lastSignalAt from new classification", async () => {
      const existing = makeArc({ id: "arc-existing", summary: "Old summary." });
      vi.mocked(arcMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existing)));
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        summary: "Updated summary from new signal.",
      }));

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.updateArc).toHaveBeenCalledOnce();
      const [, arcId, status, , fields] = vi.mocked(arcDb.updateArc).mock.calls[0]!;
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.status).toBe("active");
    });

    it("skips disabled actions", async () => {
      const rule: Rule = {
        id: "rule-disabled",
        accountId: TEST_ACCOUNT_ID,
        name: "Disabled label rule",
        condition: "true",
        actions: [{ type: "assign_label", value: "important", disabled: true }],
        status: "enabled",
        priorityOrder: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.labels).not.toContain("important");
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

      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
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

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
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
        actions: [{ type: "quarantine" }],
        status: "enabled",
        priorityOrder: 100,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([rule])));
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok({
        ...DEFAULT_CTX,
        emailConfig: { ...DEFAULT_EMAIL_CONFIG, unknownSenderPolicy: "allow_all" },
      })));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.status).toBe("quarantine_visible");
      expect(signal.data.matchedRules).toHaveLength(1);
      expect(signal.data.matchedRules![0]!.statusChange).toBe("quarantine_visible");
    });

    it("does not include rules that did not match", async () => {
      const matching: Rule = { ...makeRule({ id: "r-match", name: "Matches", condition: "true", actions: [{ type: "archive" }] }) };
      const nonMatching: Rule = { ...makeRule({ id: "r-skip", name: "Never", condition: '{"==": [1, 2]}', actions: [{ type: "block_hidden" }] }) };
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([matching, nonMatching])));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
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
      processor = new SignalProcessor({ ...SHARED_NEW_DEPS, arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, sqsDispatcher, logger: mockLogger, notifier: makeNotifier(), forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" } });
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
      const signalOrder = vi.mocked(arcDb.saveSignal).mock.invocationCallOrder[0]!;
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
      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------

  describe("deduplication", () => {
    it("skips processing if Signal with same messageId already exists", async () => {
      vi.mocked(arcDb.getSignalByMessageId).mockReturnValueOnce(Promise.resolve(ok({
        id: "SES#msg-123",
      } as never)));

      await processor.processRecord(makeMessage({ sesMessageId: "msg-123" }), 1);

      expect(classifier.classify).not.toHaveBeenCalled();
      expect(arcDb.saveSignal).not.toHaveBeenCalled();
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
      expect(arcDb.saveSignal).toHaveBeenCalledTimes(3);
    });

    it("continues processing remaining records when one fails", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("Bedrock error"))
        .mockResolvedValueOnce(ok(validClassification));

      const result1 = await processor.processRecord(makeMessage({ sesMessageId: "msg-fail" }), 1);
      const result2 = await processor.processRecord(makeMessage({ sesMessageId: "msg-ok" }), 1);

      expect(result1.isErr()).toBe(true);
      expect(result2.isOk()).toBe(true);
      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
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
      processor = new SignalProcessor({ ...SHARED_NEW_DEPS, arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, sqsDispatcher, logger: mockLogger, notifier: makeNotifier(), forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" } });
    });

    it("dispatches side-effect after saving a new Signal", async () => {
      await processor.processRecord(makeMessage(), 1);

      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
    });

    it("dispatches side-effect payload containing accountId, arc, and signal", async () => {
      await processor.processRecord(makeMessage(), 1);

      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      expect(payload.signal.accountId).toBe(TEST_ACCOUNT_ID);
      expect(payload.arc.accountId).toBe(TEST_ACCOUNT_ID);
      expect(payload.signal.arcId).toBe(payload.arc.id);
    });

    it("does not dispatch side-effect when signal is blocked (spamScore >= 0.9 triggers system rule)", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        spamScore: 0.95,
      }));

      await processor.processRecord(makeMessage(), 1);

      // Blocked signals don't reach the side-effect dispatch path
      expect(sqsDispatcher.sendMessage).not.toHaveBeenCalled();
    });

    it("does not fail processing when sqsDispatcher returns err", async () => {
      vi.mocked(sqsDispatcher.sendMessage).mockReturnValueOnce(Promise.resolve(err(dbError(new Error("SQS error")))));

      const result = await processor.processRecord(makeMessage(), 1);

      // Signal was still saved
      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
      // But the overall result is err because dispatch failed
      expect(result.isErr()).toBe(true);
    });

    it("dispatches side-effect even without explicit notifier configured", async () => {
      // Processor with default notifier — side-effect dispatch still happens
      const processorWithoutNotifier = new SignalProcessor({
        ...SHARED_NEW_DEPS,
        arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, logger: mockLogger,
        notifier: makeNotifier(), forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
        replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) }, sqsDispatcher,
        draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
        calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" },
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
      processor = new SignalProcessor({ ...SHARED_NEW_DEPS, arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, notifier, logger: mockLogger, forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" } });
    });

    it("allows signal on brand new address and auto-creates aliases with sender approved", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: null },
      )));
      // No existing sender entry for a brand-new address
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));
      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
      expect(arcDb.saveArc).toHaveBeenCalledOnce();
      expect(accountDb.saveAlias).toHaveBeenCalledOnce();

      const savedConfig = vi.mocked(accountDb.saveAlias).mock.calls[0]![0] as Alias;
      expect(savedConfig.unknownSenderPolicy).toBe("quarantine_visible");
      expect(accountDb.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, expect.any(String), "example.com", "allow");
    });

    it("allows signal from a known sender (eTLD+1 in approved list)", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      )));
      // getSender returns an approved entry for example.com (default mock already does this)

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
      expect(arcDb.saveArc).toHaveBeenCalledOnce();
      expect(accountDb.saveAlias).not.toHaveBeenCalled(); // no auto-approve needed
    });

    it("unknown sender with default filter mode → quarantine_visible (shown in review queue)", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias() }, // default filterMode: quarantine_visible
      )));
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveArc).not.toHaveBeenCalled();
      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
      expect(saved.arcId).toBeUndefined();
    });

    it("quarantines high-spam signal from approved sender (SR-03 fires)", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      )));
      // Approved sender → SR-03 fires on high spam → quarantine_hidden
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        spamScore: 0.95,
      }));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_hidden");
    });

    it("filter mode quarantine_visible: unknown sender → quarantine_visible", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias({ unknownSenderPolicy: "quarantine_visible" }) },
      )));
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_visible");
    });

    it("filter mode quarantine_hidden: unknown sender → quarantine_hidden", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias({ unknownSenderPolicy: "quarantine_hidden" }) },
      )));
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_hidden");
    });

    it("silently blocks signal when a block_hidden rule matches", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      )));
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([
        makeRule({ condition: JSON.stringify({ "in": ["system:sender:untrusted", { var: "arc.labels" }] }), actions: [{ type: "block_hidden" }] }),
      ])));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("block_hidden");
    });

    it("bypasses filtering when signal matches an existing Arc", async () => {
      const existingArc: Arc = {
        id: "existing-arc",
        accountId: TEST_ACCOUNT_ID,
        workflow: "conversation",
        labels: [],
        status: "active",
        summary: "Existing conversation",
        lastSignalAt: "2024-01-14T10:00:00Z",
        createdAt: "2024-01-14T10:00:00Z",
        updatedAt: "2024-01-14T10:00:00Z",
      };
      vi.mocked(arcMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(existingArc)));

      await processor.processRecord(makeMessage(), 1);

      // Filtering fallback bypassed on matched arc — signal is active despite untrusted sender
      expect(arcDb.updateArc).toHaveBeenCalledOnce();
      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
    });

    it("quarantines a known sender with high spam score (SR-03 fires regardless of filter mode)", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias({ unknownSenderPolicy: "quarantine_visible" }) },
      )));
      // Sender is known/approved but spam score is too high — SR-03 quarantines hidden independently of filter mode
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        spamScore: 0.95,
      }));

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_hidden");
    });

    it("allow_all mode auto-approves new sender without blocking", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias({ unknownSenderPolicy: "allow_all" }) },
      )));
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null))); // sender not yet in list

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveArc).toHaveBeenCalledOnce();
      expect(accountDb.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, expect.any(String), "example.com", "allow");
    });

    it("saves blocked signal with classification data for user review", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      )));
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.data.workflow).toBe(validClassification.workflow);
      expect(saved.data.summary).toBe(validClassification.summary);
      expect(saved.data.spamScore).toBe(validClassification.spamScore);
    });

    it("quarantines new address when newAddressHandling is block_until_approved (default disposition)", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok({
        retentionDays: 0,
        filtering: { newAddressHandling: "block_until_approved", defaultUnknownSenderPolicy: "quarantine_visible" },
        emailConfig: null,
        registeredDomains: [],
        userEmails: [],
        billingPlan: "Paid",
        onboardingCompleted: true,
      })));

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      // emailConfig is null → effectiveSenderEntry = null → system:sender:untrusted → filter mode fallback (quarantine_visible)
      expect(saved.status).toBe("quarantine_visible");
    });
  });

  // -------------------------------------------------------------------------
  // Global reputation tracking
  // -------------------------------------------------------------------------

  describe("global reputation tracking", () => {
    it("updates reputation with wasBlocked=true for blocked signals", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok(
        { ...DEFAULT_CTX, emailConfig: makeAlias() },
      )));
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      expect(processingDb.updateGlobalReputation).toHaveBeenCalledWith(
        "example.com",
        expect.objectContaining({ wasBlocked: true }),
      );
    });

    it("updates reputation with wasBlocked=false for active signals", async () => {
      await processor.processRecord(makeMessage(), 1);

      expect(processingDb.updateGlobalReputation).toHaveBeenCalledWith(
        "example.com",
        expect.objectContaining({ wasBlocked: false }),
      );
    });

    it("marks wasSpam=true when spamScore >= 0.9", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        spamScore: 0.97,
      }));

      await processor.processRecord(makeMessage(), 1);

      expect(processingDb.updateGlobalReputation).toHaveBeenCalledWith(
        "example.com",
        expect.objectContaining({ wasSpam: true }),
      );
    });

    it("does not fail processing when updateGlobalReputation throws", async () => {
      vi.mocked(processingDb.updateGlobalReputation).mockRejectedValueOnce(new Error("DynamoDB error"));

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveSignal).toHaveBeenCalledOnce();
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

      expect(arcDb.fastFindArcByAlternativeLookupKey).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "user@example.com:auth:example.com",
      );
      expect(arcMatcher.findMatch).not.toHaveBeenCalled();
    });

    it("stores groupingKey on a newly created arc", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", code: "123456", service: "GitHub" },
      }));

      await processor.processRecord(makeMessage(), 1);

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.groupingKey).toBe("user@example.com:auth:example.com");
    });

    it("reuses existing arc found by grouping key", async () => {
      const existing = makeArc({ id: "auth-arc", groupingKey: "user@example.com:auth:example.com" });
      vi.mocked(arcDb.fastFindArcByAlternativeLookupKey).mockReturnValueOnce(Promise.resolve(ok(existing)));
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", code: "999999", service: "GitHub" },
      }));

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.updateArc).toHaveBeenCalledOnce();
      const [, arcId] = vi.mocked(arcDb.updateArc).mock.calls[0]!;
      expect(arcId).toBe("auth-arc");
    });

    it("scopes vector search by recipientAddress for workflows without a grouping key", async () => {
      await processor.processRecord(makeMessage({ destination: ["inbox@work.com"] }), 1);

      expect(arcMatcher.findMatch).toHaveBeenCalledWith(
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

      expect(arcDb.fastFindArcByAlternativeLookupKey).toHaveBeenCalledWith(
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

      expect(arcDb.fastFindArcByAlternativeLookupKey).not.toHaveBeenCalled();
      expect(arcMatcher.findMatch).toHaveBeenCalledOnce();
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

    it("uses senderETLD1 grouping for status workflow (threads all notices from same sender)", () => {
      expect(deriveGroupingKey("status", { workflow: "status", statusType: "privacy_policy", provider: "Google" }, "me@example.com", "google.com"))
        .toBe("me@example.com:status:google.com");
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

    it("support falls through to normal (urgency handled by system rules SR-20–SR-24)", () => {
      expect(baseUrgency("support", { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "urgent" })).toBe("normal");
      expect(baseUrgency("support", { workflow: "support", eventType: "awaiting_response", service: "Zendesk" })).toBe("normal");
      expect(baseUrgency("support", { workflow: "support", eventType: "ticket_opened", service: "Zendesk" })).toBe("normal");
    });

    it("content is always low", () => {
      expect(baseUrgency("content", { workflow: "content", contentType: "newsletter", publisher: "TLDR" })).toBe("low");
      expect(baseUrgency("content", { workflow: "content", contentType: "promotion", publisher: "Nike" })).toBe("low");
    });

    it("status is always silent", () => {
      expect(baseUrgency("status", { workflow: "status", statusType: "privacy_policy", provider: "Google" })).toBe("silent");
      expect(baseUrgency("status", { workflow: "status", statusType: "service_notice", provider: "Stripe" })).toBe("silent");
    });

    it("onboarding is always silent", () => {
      expect(baseUrgency("onboarding", { workflow: "onboarding", onboardingType: "welcome", service: "Acme" } as unknown as import("../../src/types/index.js").WorkflowData)).toBe("silent");
    });

    it("travel is normal (no special urgency boost)", () => {
      expect(baseUrgency("travel", { workflow: "travel", travelType: "flight", provider: "Delta" })).toBe("normal");
    });

    it("conversation falls through to normal (urgency handled by system rules SR-15–SR-16)", () => {
      expect(baseUrgency("conversation", { workflow: "conversation", sentiment: "urgent", requiresReply: true })).toBe("normal");
      expect(baseUrgency("conversation", { workflow: "conversation", sentiment: "positive", requiresReply: false })).toBe("normal");
      expect(baseUrgency("conversation", { workflow: "conversation", sentiment: "neutral", requiresReply: false })).toBe("normal");
    });

    it("crm falls through to normal (urgency handled by system rules SR-17–SR-19)", () => {
      expect(baseUrgency("crm", { workflow: "crm" })).toBe("normal");
      expect(baseUrgency("crm", { workflow: "crm" })).toBe("normal");
      expect(baseUrgency("crm", { workflow: "crm" })).toBe("normal");
    });
  });

  // -------------------------------------------------------------------------
  // Workflow-specific urgency rules (SR-15–SR-24)
  // -------------------------------------------------------------------------

  describe("workflow urgency system rules", () => {
    async function processWithWorkflow(classification: Partial<ClassificationOutput>): Promise<Arc> {
      const full: ClassificationOutput = {
        workflow: "conversation",
        workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
        spamScore: 0.05, summary: "test", labels: [],
        ...classification,
      };
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(full));
      await processor.processRecord(makeMessage({ sesMessageId: randomUUID() }), 1);
      return vi.mocked(arcDb.saveArc).mock.calls.at(-1)![0] as Arc;
    }

    it("SR-15: conversation + requiresReply + urgent sentiment → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "conversation", workflowData: { workflow: "conversation", sentiment: "urgent", requiresReply: true } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-15: conversation + requiresReply + negative sentiment → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "conversation", workflowData: { workflow: "conversation", sentiment: "negative", requiresReply: true } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-16: conversation with no prior replies → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "conversation", workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-16: conversation with prior replies (system:replied) → not low (falls back to arc urgency)", async () => {
      vi.mocked(arcMatcher.findMatch).mockReturnValueOnce(Promise.resolve(ok(makeArc({
        workflow: "conversation", labels: [], urgency: "normal",
        sentMessageIds: ["<prior-msg@example.com>"],
      }))));
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        workflow: "conversation", workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
        spamScore: 0.05, summary: "test", labels: [],
      }));
      await processor.processRecord(makeMessage({ sesMessageId: randomUUID() }), 1);
      const signal = vi.mocked(arcDb.saveSignal).mock.calls.at(-1)![0] as Signal;
      expect(signal.data.urgency).toBe("normal");
    });

    it("crm → normal urgency (crmType/urgency fields removed)", async () => {
      const arc = await processWithWorkflow({ workflow: "crm", workflowData: { workflow: "crm" } });
      expect(arc.urgency).toBe("normal");
    });

    it("SR-20: support + priority:urgent → critical urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "urgent" } });
      expect(arc.urgency).toBe("critical");
    });

    it("SR-21: support + priority:high → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "high" } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-22: support + awaiting_response → high urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "awaiting_response", service: "Zendesk" } });
      expect(arc.urgency).toBe("high");
    });

    it("SR-23: support + priority:low → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_updated", service: "Zendesk", priority: "low" } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-24: support + ticket_opened → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_opened", service: "Zendesk" } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-24: support + ticket_resolved → low urgency", async () => {
      const arc = await processWithWorkflow({ workflow: "support", workflowData: { workflow: "support", eventType: "ticket_resolved", service: "Zendesk" } });
      expect(arc.urgency).toBe("low");
    });

    it("SR-20 wins over SR-24: support + priority:urgent + ticket_opened → critical (first-rule-wins)", async () => {
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
      spamScore: 0.02,
      summary: "Welcome to Acme App.",
      labels: [],
    };

    it("processes onboarding emails as active when no blocking rule is configured", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(onboardingClassification));
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([]))); // no system rules — SR-01 (block onboarding) is disabled

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveArc).toHaveBeenCalledOnce();
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("active");
      expect(saved.data.workflow).toBe("onboarding");
    });

    it("blocks onboarding emails when a block rule targeting system:workflow:onboarding is active", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(onboardingClassification));
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([
        makeRule({ condition: JSON.stringify({ "in": ["system:workflow:onboarding", { var: "arc.labels" }] }), actions: [{ type: "block_hidden" }] }),
      ])));

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ ...SHARED_NEW_DEPS, arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, notifier, logger: mockLogger, forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" } });
      await proc.processRecord(makeMessage(), 1);

      expect(arcDb.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("block_hidden");
    });

    it("quarantines onboarding emails when a quarantine rule is active", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(onboardingClassification));
      vi.mocked(accountDb.listEnabledRules).mockReturnValueOnce(Promise.resolve(ok([
        makeRule({ condition: JSON.stringify({ "in": ["system:workflow:onboarding", { var: "arc.labels" }] }), actions: [{ type: "quarantine" }] }),
      ])));

      const notifier = makeNotifier();
      const proc = new SignalProcessor({ ...SHARED_NEW_DEPS, arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, notifier, logger: mockLogger, forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" } });
      await proc.processRecord(makeMessage(), 1);

      expect(arcDb.saveArc).not.toHaveBeenCalled();
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      // Plain `quarantine` action → quarantine_visible (shown in review queue)
      expect(saved.status).toBe("quarantine_visible");
    });
  });

  // -------------------------------------------------------------------------
  // Test email detection
  // -------------------------------------------------------------------------

  describe("test email detection", () => {
    it("overrides workflow to 'test' when from-domain matches a registered account domain", async () => {
      // Default mime parser mock returns from: { address: "sender@example.com" }
      // getETLD1("sender@example.com") = "example.com"
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok({
        ...DEFAULT_CTX,
        registeredDomains: ["example.com"],
      })));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.workflow).toBe("test");
      expect(signal.data.workflowData).toMatchObject({ workflow: "test", triggeredBy: "user" });
    });

    it("overrides workflow to 'test' when from-address exactly matches a userEmail (case-insensitive)", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok({
        ...DEFAULT_CTX,
        userEmails: ["SENDER@example.com"], // uppercase — must still match
      })));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.workflow).toBe("test");
    });

    it("does not override workflow when from-domain is not in registeredDomains and address not in userEmails", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok({
        ...DEFAULT_CTX,
        registeredDomains: ["otherdomain.com"],
        userEmails: ["different@email.com"],
      })));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.data.workflow).toBe("conversation"); // unchanged from validClassification mock
    });
  });

  // -------------------------------------------------------------------------
  // Notice workflow arc behavior
  // -------------------------------------------------------------------------

  const noticeClassification: ClassificationOutput = {
    workflow: "status",
    workflowData: { workflow: "status", statusType: "privacy_policy", provider: "Google" },
    spamScore: 0.0,
    summary: "Privacy policy update from Google.",
    labels: [],
  };

  describe("notice workflow arc behavior", () => {
    let notifier: Notifier;

    beforeEach(() => {
      notifier = makeNotifier();
      processor = new SignalProcessor({ ...SHARED_NEW_DEPS, arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, notifier, logger: mockLogger, forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) }, sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" } });
    });

    it("blocks status emails silently — no arc created, signal saved as blocked", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(noticeClassification));

      await processor.processRecord(makeMessage(), 1);

      expect(arcDb.saveArc).not.toHaveBeenCalled();
      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.status).toBe("block_hidden");
      expect(signal.data.workflow).toBe("status");
    });

    it("does not call notifier for a blocked status email", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(noticeClassification));

      await processor.processRecord(makeMessage(), 1);

      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("blocks status emails from untrusted senders (SR-05 rule fires, fallback does not apply)", async () => {
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(noticeClassification));
      // Untrusted sender: no approved sender entry — filter-mode fallback would quarantine, but SR-05 fires first
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok({
        ...DEFAULT_CTX,
        emailConfig: makeAlias(),
      })));
      vi.mocked(accountDb.getSender).mockReturnValueOnce(Promise.resolve(ok(null)));

      await processor.processRecord(makeMessage(), 1);

      const signal = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(signal.status).toBe("block_hidden"); // SR-05 sets status → fallback skipped (hasStatusOutcome = true)
      expect(arcDb.saveArc).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Pong auto-reply (test workflow)
  // -------------------------------------------------------------------------

  const testClassification: ClassificationOutput = {
    workflow: "test",
    workflowData: { workflow: "test", triggeredBy: "user" },
    spamScore: 0.0,
    summary: "Test email from account owner.",
    labels: [],
  };

  describe("pong auto-reply", () => {
    let sqsDispatcher: SqsDispatcher;

    beforeEach(() => {
      sqsDispatcher = { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
      processor = new SignalProcessor({ ...SHARED_NEW_DEPS, arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, sqsDispatcher, logger: mockLogger, notifier: makeNotifier(), forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: makeReplySender(), draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" } });
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
      expect(payload.signal.data.textBody).toBe("Hello world");
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
      const processorWithReplier = new SignalProcessor({ ...SHARED_NEW_DEPS, arcDb, accountDb, processingDb, contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", classifier, embeddingGenerator, auroraWriter, arcMatcher, ruleEvaluator, logger: mockLogger, notifier: makeNotifier(), forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) }, retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) }, replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) }, sqsDispatcher, draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never, calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" } });
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
  // Spam threshold — per-address and account-level overrides
  // -------------------------------------------------------------------------

  describe("spam threshold override", () => {
    it("quarantines signal when per-address spamScoreThreshold is lower than default and score exceeds it", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok({
        ...DEFAULT_CTX,
        emailConfig: makeAlias({
          unknownSenderPolicy: "quarantine_visible",
          spamScoreThreshold: 0.5,
        }),
      })));
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        spamScore: 0.7, // above per-address threshold (0.5), below default (0.9)
      }));

      await processor.processRecord(makeMessage(), 1);

      // DEFAULT_SENDER_ENTRY is approved → SR-03 fires → quarantine_hidden
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_hidden");
    });

    it("uses account-level spamScoreThreshold when no per-address override is set", async () => {
      vi.mocked(accountDb.getProcessorAccountContext).mockReturnValueOnce(Promise.resolve(ok({
        ...DEFAULT_CTX,
        emailConfig: makeAlias({ unknownSenderPolicy: "quarantine_visible" }),
        filtering: { defaultUnknownSenderPolicy: "quarantine_visible", newAddressHandling: "auto_allow", spamScoreThreshold: 0.6 },
      })));
      vi.mocked(classifier.classify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok({
        ...validClassification,
        spamScore: 0.7, // above account threshold (0.6), below default (0.9)
      }));

      await processor.processRecord(makeMessage(), 1);

      // DEFAULT_SENDER_ENTRY is approved → SR-03 fires → quarantine_hidden
      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("quarantine_hidden");
    });
  });

  // -------------------------------------------------------------------------
  // DKIM/DMARC block — emails failing verification are rejected at pipeline entry
  // -------------------------------------------------------------------------

  describe("DKIM/DMARC block at pipeline entry", () => {
    it("blocks email and saves signal with block_reject status when DKIM fails", async () => {
      await processor.processRecord(makeMessage({ dkimVerdict: "FAIL", dmarcVerdict: "PASS" }), 1);

      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("block_reject");
      expect(arcDb.saveArc).not.toHaveBeenCalled();
    });

    it("blocks email and saves signal with block_reject status when DMARC fails", async () => {
      await processor.processRecord(makeMessage({ dkimVerdict: "PASS", dmarcVerdict: "GRAY" }), 1);

      const saved = vi.mocked(arcDb.saveSignal).mock.calls[0]![0] as Signal;
      expect(saved.status).toBe("block_reject");
      expect(arcDb.saveArc).not.toHaveBeenCalled();
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
      expect(arc.labels).toContain("archived-auto");
      expect(arc.status).toBe("archived");
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
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

      const arc = vi.mocked(arcDb.saveArc).mock.calls[0]![0] as Arc;
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
