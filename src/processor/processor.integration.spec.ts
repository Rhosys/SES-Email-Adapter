import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { ok, okAsync, errAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher, SqsDispatcher, Notifier, Forwarder, TestReplier } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { S3RetentionService } from "../embedding/s3-retention-service.js";
import type { Signal, Arc, Alias } from "../types/index.js";
import { dbError } from "../errors.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster-registry
// ---------------------------------------------------------------------------

vi.mock("../embedding/cluster-registry.js", () => {
  const entry = Object.freeze({
    clusterId: "aurora-prod-titan-v2",
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
    getClusterById: (id: string) => (id === entry.clusterId ? entry : null),
    getReadCluster: () => entry,
  };
});

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-integration";
const SES_MESSAGE_ID = "msg-integration-001";

const DEFAULT_ALIAS: Alias = {
  id: "cfg-default",
  accountId: TEST_ACCOUNT_ID,
  address: "user@example.com",
  filterMode: "allow_all",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_CTX = {
  retentionDays: 30,
  filtering: null,
  emailConfig: DEFAULT_ALIAS,
  registeredDomains: [],
  userEmails: [],
  billingPlan: "Paid" as const,
};

const validClassification: ClassificationOutput = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
  spamScore: 0.05,
  summary: "Integration test email.",
  labels: [],
  classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
};

// ---------------------------------------------------------------------------
// Test double factories
// ---------------------------------------------------------------------------

function makeStore(): ProcessorDatabase {
  return {
    getSignalByMessageId: vi.fn().mockReturnValue(okAsync(null)),
    saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
    updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
    getArc: vi.fn().mockReturnValue(okAsync(null)),
    findArcByGroupingKey: vi.fn().mockReturnValue(okAsync(null)),
    saveArc: vi.fn().mockReturnValue(okAsync(undefined)),
    listEnabledRules: vi.fn().mockReturnValue(okAsync(SYSTEM_RULES)),
    getProcessorAccountContext: vi.fn().mockReturnValue(okAsync(DEFAULT_CTX)),
    saveAlias: vi.fn().mockImplementation((a: Alias) => okAsync(a)),
    getSender: vi.fn().mockReturnValue(okAsync({
      accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com",
      domain: "example.com", mode: "allow", addedAt: "2024-01-01T00:00:00Z",
    })),
    saveSender: vi.fn().mockReturnValue(okAsync(undefined)),
    getTemplate: vi.fn().mockReturnValue(okAsync(null)),
    updateGlobalReputation: vi.fn().mockReturnValue(okAsync(undefined)),
    getDomainByName: vi.fn().mockReturnValue(okAsync(null)),
  };
}

function makeMimeParser(): MimeParser {
  return {
    parse: vi.fn().mockReturnValue(okAsync({
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Integration test email",
      textBody: "Hello from integration test",
      htmlBody: "<p>Hello from integration test</p>",
      attachments: [],
      headers: { "authentication-results": "spf=pass dkim=pass" },
      sentAt: "2024-01-15T09:00:00Z",
    })),
  };
}

function makeClassifier(): Pick<SignalClassifier, "classify"> {
  return { classify: vi.fn().mockResolvedValue({ ...validClassification }) };
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
    upsertEmbedding: vi.fn().mockResolvedValue(undefined),
    findMatch: vi.fn().mockResolvedValue(null),
  };
}

function makeArcMatcher(): ArcMatcher {
  return {
    findMatch: vi.fn().mockReturnValue(okAsync(null)),
    upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)),
  };
}

function makeRetentionService(): S3RetentionService {
  return {
    applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: `emails/${SES_MESSAGE_ID}` }),
  };
}

function makeSqsDispatcher(): SqsDispatcher {
  return {
    sendMessage: vi.fn().mockReturnValue(okAsync(undefined)),
  };
}

function makeNotifier(): Notifier {
  return {
    notify: vi.fn().mockReturnValue(okAsync(undefined)),
    notifyBlocked: vi.fn().mockReturnValue(okAsync(undefined)),
  };
}

function makeForwarder(): Forwarder {
  return {
    forward: vi.fn().mockReturnValue(okAsync(undefined)),
  };
}

function makeTestReplier(): TestReplier {
  return {
    pong: vi.fn().mockResolvedValue({ messageId: "pong-msg-001" }),
  };
}

/**
 * Build an inbound signal SQS event (from SES notification).
 */
function makeInboundEvent(opts: {
  sesMessageId?: string;
  receiveCount?: number;
}): SQSEvent {
  const sesMessageId = opts.sesMessageId ?? SES_MESSAGE_ID;
  const notification = {
    accountId: TEST_ACCOUNT_ID,
    mail: {
      messageId: sesMessageId,
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
    },
    receipt: {
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PASS" },
      action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
    },
  };

  return {
    Records: [{
      messageId: "sqs-integration-0",
      receiptHandle: "handle",
      body: JSON.stringify({ Message: JSON.stringify(notification) }),
      attributes: {
        ApproximateReceiveCount: String(opts.receiveCount ?? 1),
        SentTimestamp: "1234567890",
        SenderId: "sender",
        ApproximateFirstReceiveTimestamp: "1234567890",
      },
      messageAttributes: {},
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:123:queue",
      awsRegion: "us-east-1",
    }],
  };
}

/**
 * Build a side-effect SQS event (dispatched by the processor itself).
 */
function makeSideEffectEvent(payload: { signal: Signal; arc: Arc }): SQSEvent {
  return {
    Records: [{
      messageId: "sqs-side-effect-0",
      receiptHandle: "handle",
      body: JSON.stringify(payload),
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "1234567890",
        SenderId: "sender",
        ApproximateFirstReceiveTimestamp: "1234567890",
      },
      messageAttributes: {
        messageType: {
          stringValue: "side_effect",
          dataType: "String",
          stringListValues: [],
          binaryListValues: [],
        },
      },
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:123:queue",
      awsRegion: "us-east-1",
    }],
  };
}

/**
 * Build a realistic Signal as it would exist in DDB after first-attempt processing.
 */
function makeExistingSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: `SES#${SES_MESSAGE_ID}`,
    arcId: "arc-integration-001",
    accountId: TEST_ACCOUNT_ID,
    source: "email",
    receivedAt: "2024-01-15T10:00:00Z",
    from: { address: "sender@example.com", name: "Sender" },
    to: [{ address: "user@example.com" }],
    cc: [],
    subject: "Integration test email",
    textBody: "Hello from integration test",
    attachments: [],
    headers: {},
    recipientAddress: "user@example.com",
    workflow: "conversation",
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.05,
    summary: "Integration test email.",
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    s3Key: `emails/${SES_MESSAGE_ID}`,
    status: "active",
    createdAt: "2024-01-15T10:00:00Z",
    embeddings: { "amazon.titan-embed-text-v2:0": new Array(1024).fill(0.1) },
    matchedRules: [],
    ...overrides,
  };
}

function makeExistingArc(overrides: Partial<Arc> = {}): Arc {
  return {
    id: "arc-integration-001",
    accountId: TEST_ACCOUNT_ID,
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "Integration test email.",
    lastSignalAt: "2024-01-15T10:00:00Z",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}


// ---------------------------------------------------------------------------
// Integration tests: End-to-end retry flow
// Validates: Requirements 1.1, 1.2, 2.1, 2.2, 3.3, 4.1, 4.2
// ---------------------------------------------------------------------------

describe("SignalProcessor integration: end-to-end retry flow", () => {
  let store: ProcessorDatabase;
  let mimeParser: MimeParser;
  let classifier: Pick<SignalClassifier, "classify">;
  let embeddingGenerator: EmbeddingGenerator;
  let auroraWriter: MultiClusterAuroraWriter;
  let arcMatcher: ArcMatcher;
  let retentionService: S3RetentionService;
  let sqsDispatcher: SqsDispatcher;
  let notifier: Notifier;
  let forwarder: Forwarder;
  let testReplier: TestReplier;
  let mockLogger: MockLogger;
  let processor: SignalProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    store = makeStore();
    mimeParser = makeMimeParser();
    classifier = makeClassifier();
    embeddingGenerator = makeEmbeddingGenerator();
    auroraWriter = makeAuroraWriter();
    arcMatcher = makeArcMatcher();
    retentionService = makeRetentionService();
    sqsDispatcher = makeSqsDispatcher();
    notifier = makeNotifier();
    forwarder = makeForwarder();
    testReplier = makeTestReplier();
    processor = new SignalProcessor({
      store,
      mimeParser,
      classifier,
      embeddingGenerator,
      auroraWriter,
      arcMatcher,
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      retentionService,
      sqsDispatcher,
      notifier,
      forwarder,
      testReplier,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: First attempt → saves arc → saves signal → S3 retention → Aurora → dispatches side-effect message
  // -------------------------------------------------------------------------

  describe("first attempt (receiveCount=1)", () => {
    it("executes full pipeline: parse → classify → arc match → save arc → save signal → S3 retention → Aurora → dispatch", async () => {
      const event = makeInboundEvent({ receiveCount: 1 });

      const result = await processor.process(event);

      // No failures
      expect(result.batchItemFailures).toHaveLength(0);

      // MIME was parsed
      expect(mimeParser.parse).toHaveBeenCalledOnce();

      // Classification ran
      expect(classifier.classify).toHaveBeenCalledOnce();

      // Embedding generated
      expect(embeddingGenerator.generateForModel).toHaveBeenCalledOnce();

      // Arc was saved before signal
      const callOrder: string[] = [];
      vi.mocked(store.saveArc).mock.invocationCallOrder.forEach(() => callOrder.push("saveArc"));
      vi.mocked(store.saveSignal).mock.invocationCallOrder.forEach(() => callOrder.push("saveSignal"));
      // Verify saveArc was called
      expect(store.saveArc).toHaveBeenCalled();
      // Verify saveSignal was called
      expect(store.saveSignal).toHaveBeenCalled();
      // saveArc invocation order < saveSignal invocation order
      const arcOrder = vi.mocked(store.saveArc).mock.invocationCallOrder[0]!;
      const signalOrder = vi.mocked(store.saveSignal).mock.invocationCallOrder[0]!;
      expect(arcOrder).toBeLessThan(signalOrder);

      // S3 retention was attempted
      expect(retentionService.applyPlanRetention).toHaveBeenCalledOnce();

      // Aurora upsert ran after signal save
      expect(auroraWriter.upsertEmbedding).toHaveBeenCalledOnce();
      const auroraOrder = vi.mocked(auroraWriter.upsertEmbedding).mock.invocationCallOrder[0]!;
      expect(auroraOrder).toBeGreaterThan(signalOrder);

      // Side-effect SQS message was dispatched after Aurora
      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
      const dispatchOrder = vi.mocked(sqsDispatcher.sendMessage).mock.invocationCallOrder[0]!;
      expect(dispatchOrder).toBeGreaterThan(auroraOrder);
    });

    it("dispatches side-effect payload containing signal and arc", async () => {
      const event = makeInboundEvent({ receiveCount: 1 });

      await processor.process(event);

      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      expect(payload.signal).toBeDefined();
      expect(payload.arc).toBeDefined();
      expect(payload.signal.accountId).toBe(TEST_ACCOUNT_ID);
      expect(payload.arc.accountId).toBe(TEST_ACCOUNT_ID);
      expect(payload.signal.arcId).toBe(payload.arc.id);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: Retry with existing signal → skips parse/classify → S3 retention → Aurora → dispatches side-effect message
  // -------------------------------------------------------------------------

  describe("retry with existing signal (receiveCount > 1, signal in DDB)", () => {
    const existingSignal = makeExistingSignal();
    const existingArc = makeExistingArc();

    beforeEach(() => {
      vi.mocked(store.getSignalByMessageId).mockReturnValue(okAsync(existingSignal));
      vi.mocked(store.getArc).mockReturnValue(okAsync(existingArc));
    });

    it("skips parse, classify, and embedding — resumes from S3 retention → Aurora → dispatch", async () => {
      const event = makeInboundEvent({ receiveCount: 3 });

      const result = await processor.process(event);

      // No failures
      expect(result.batchItemFailures).toHaveLength(0);

      // Signal was looked up from DDB
      expect(store.getSignalByMessageId).toHaveBeenCalledWith(TEST_ACCOUNT_ID, SES_MESSAGE_ID);

      // Arc was loaded from DDB
      expect(store.getArc).toHaveBeenCalledWith(TEST_ACCOUNT_ID, existingSignal.arcId);

      // Expensive operations were NOT called
      expect(mimeParser.parse).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(embeddingGenerator.generateForModel).not.toHaveBeenCalled();

      // No new DDB saves (arc and signal already exist)
      expect(store.saveArc).not.toHaveBeenCalled();
      expect(store.saveSignal).not.toHaveBeenCalled();

      // S3 retention was attempted (idempotent, always runs)
      expect(retentionService.applyPlanRetention).toHaveBeenCalledOnce();

      // Aurora upsert ran (idempotent)
      expect(auroraWriter.upsertEmbedding).toHaveBeenCalledOnce();

      // Side-effect SQS message was dispatched
      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      expect(payload.signal.id).toBe(existingSignal.id);
      expect(payload.arc.id).toBe(existingArc.id);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: Aurora failure on retry → no side-effect dispatch → batchItemFailure returned
  // -------------------------------------------------------------------------

  describe("Aurora failure on retry", () => {
    const existingSignal = makeExistingSignal();
    const existingArc = makeExistingArc();

    beforeEach(() => {
      vi.mocked(store.getSignalByMessageId).mockReturnValue(okAsync(existingSignal));
      vi.mocked(store.getArc).mockReturnValue(okAsync(existingArc));
      // Aurora fails
      vi.mocked(auroraWriter.upsertEmbedding).mockRejectedValue(new Error("Aurora cluster timeout"));
    });

    it("returns batchItemFailure and does not dispatch side-effects", async () => {
      const event = makeInboundEvent({ receiveCount: 2 });

      const result = await processor.process(event);

      // Record returned as failure
      expect(result.batchItemFailures).toHaveLength(1);
      expect(result.batchItemFailures[0]!.itemIdentifier).toBe("sqs-integration-0");

      // Side-effect dispatch was NOT called (Aurora failed)
      expect(sqsDispatcher.sendMessage).not.toHaveBeenCalled();

      // S3 retention still ran (fire-and-forget, before Aurora)
      expect(retentionService.applyPlanRetention).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: Side-effect message received → derives outcome → executes effects
  // -------------------------------------------------------------------------

  describe("side-effect message processing", () => {
    it("derives outcome from matchedRules and executes forward + notify", async () => {
      const signal = makeExistingSignal({
        matchedRules: [
          {
            ruleId: "rule-fwd",
            actions: [{ type: "forward", value: "backup@personal.com" }],
            labelsAdded: [],
          },
        ],
      });
      const arc = makeExistingArc();

      const event = makeSideEffectEvent({ signal, arc });

      const result = await processor.process(event);

      // No failures (side-effect handler does not return batchItemFailure for execution errors)
      expect(result.batchItemFailures).toHaveLength(0);

      // Forward was called with the address from matchedRules
      expect(forwarder.forward).toHaveBeenCalledOnce();
      expect(forwarder.forward).toHaveBeenCalledWith(
        signal.s3Key,
        "backup@personal.com",
        TEST_ACCOUNT_ID,
        expect.objectContaining({ senderDomain: "example.com" }),
      );

      // Notification was sent (no suppress_notification action)
      expect(notifier.notify).toHaveBeenCalledOnce();
      expect(notifier.notify).toHaveBeenCalledWith(TEST_ACCOUNT_ID, arc, signal);
    });

    it("executes pong when doPong action is present", async () => {
      const signal = makeExistingSignal({
        matchedRules: [
          {
            ruleId: "rule-pong",
            actions: [{ type: "pong" }],
            labelsAdded: [],
          },
        ],
      });
      const arc = makeExistingArc();

      const event = makeSideEffectEvent({ signal, arc });

      const result = await processor.process(event);

      expect(result.batchItemFailures).toHaveLength(0);
      expect(testReplier.pong).toHaveBeenCalledOnce();
      expect(testReplier.pong).toHaveBeenCalledWith(expect.objectContaining({
        to: signal.from.address,
        from: signal.recipientAddress,
      }));
    });

    it("suppresses notification when suppress_notification action is present", async () => {
      const signal = makeExistingSignal({
        matchedRules: [
          {
            ruleId: "rule-suppress",
            actions: [{ type: "suppress_notification" }],
            labelsAdded: [],
          },
        ],
      });
      const arc = makeExistingArc();

      const event = makeSideEffectEvent({ signal, arc });

      await processor.process(event);

      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("does not invoke inbound signal pipeline for side-effect messages", async () => {
      const signal = makeExistingSignal();
      const arc = makeExistingArc();

      const event = makeSideEffectEvent({ signal, arc });

      await processor.process(event);

      // None of the inbound signal pipeline was invoked
      expect(mimeParser.parse).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(embeddingGenerator.generateForModel).not.toHaveBeenCalled();
      expect(store.getSignalByMessageId).not.toHaveBeenCalled();
      expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    });
  });
});
