import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ArcMatcher, InboundSignalMessage, SqsDispatcher } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ArcDatabase } from "../../src/database/arc-database.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/multi-cluster-aurora-writer.js";
import type { Signal, Arc, Alias, AliasSender, Workflow } from "../../src/types/index.js";
import { dbError } from "../../src/errors.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with a single active cluster
// ---------------------------------------------------------------------------

vi.mock("../../src/embedding/cluster-registry.js", () => {
  const cluster = Object.freeze({
    registryId: "cluster-primary",
    clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-primary",
    secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-primary",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([cluster]),
    getActiveClusters: () => [cluster],
    getRegistryById: (id: string) => (id === cluster.registryId ? cluster : null),
    getPrimaryArcMatcherRegistry: () => cluster,
  };
});

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

// ---------------------------------------------------------------------------
// Property 1: Resume from prior state on retry
// **Validates: Requirements 1.1, 1.2**
// ---------------------------------------------------------------------------

/**
 * For any signal that exists in DDB when receiveCount > 1, the processor SHALL
 * read the signal and its arc from DDB, then execute Aurora upserts and dispatch
 * side-effects, without re-parsing, re-classifying, or re-evaluating rules.
 */
describe("Feature: signal-processor-retry-resilience, Property 1: Resume from prior state on retry", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop1";

  const DEFAULT_ALIAS: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    unknownSenderPolicy: "allow_all",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    policy: "allow",
    addedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_CTX = {
    retentionDays: 0,
    filtering: null,
    emailConfig: DEFAULT_ALIAS,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  // -------------------------------------------------------------------------
  // Edge-case inputs
  // -------------------------------------------------------------------------

  // receiveCount values that matter for branching:
  // - 2: first retry (enters retry path, `receiveCount > 1`)
  // - 30: at RETRY_TRACK_THRESHOLD (still logs at warn level)
  // - 31: exceeds threshold (logs at error level on failure)
  const RECEIVE_COUNTS = [2, 30, 31] as const;

  // Embedding variations that exercise different Aurora upsert paths:
  // - valid embedding: normal upsert path
  // - undefined embeddings: Aurora upsert skipped for all clusters
  // - wrong model key: Aurora upsert skipped (no matching modelId)
  const SIGNAL_VARIANTS: Array<{ label: string; signal: Signal }> = [
    {
      label: "valid embedding for cluster model",
      signal: {
        id: "sgn-validEmb000000000000abc",
        signalLookupId: "ses-msg-valid-emb",
        sesMessageId: "msg-valid-emb",
        arcId: "arc-valid-emb",
        accountId: TEST_ACCOUNT_ID,
        source: "email" as const,
        receivedAt: "2024-01-15T10:00:00Z",
        from: { address: "sender@external.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Test email",
        textBody: "Hello world",
        attachments: [],
        headers: {},
        recipientAddress: "user@example.com",
        workflow: "conversation" as Workflow,
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
        spamScore: 0.01,
        summary: "A test email.",
        classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
        s3Key: "emails/msg-valid-emb",
        status: "active" as const,
        createdAt: "2024-01-15T10:00:00Z",
        embeddings: { "amazon.titan-embed-text-v2:0": [0.1, -0.5, 0.3] },
        matchedRules: [],
      } as Signal,
    },
    {
      label: "embeddings undefined (Aurora upsert skipped)",
      signal: {
        id: "sgn-noEmb0000000000000000abc",
        signalLookupId: "ses-msg-no-emb",
        sesMessageId: "msg-no-emb",
        arcId: "arc-no-emb",
        accountId: TEST_ACCOUNT_ID,
        source: "email" as const,
        receivedAt: "2024-01-15T10:00:00Z",
        from: { address: "sender@external.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Test email",
        textBody: "Hello world",
        attachments: [],
        headers: {},
        recipientAddress: "user@example.com",
        workflow: "conversation" as Workflow,
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
        spamScore: 0.01,
        summary: "A test email.",
        classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
        s3Key: "emails/msg-no-emb",
        status: "active" as const,
        createdAt: "2024-01-15T10:00:00Z",
        matchedRules: [],
      } as unknown as Signal,
    },
    {
      label: "embedding for wrong model (Aurora upsert skipped for cluster)",
      signal: {
        id: "sgn-wrongModel00000000000abc",
        signalLookupId: "ses-msg-wrong-model",
        sesMessageId: "msg-wrong-model",
        arcId: "arc-wrong-model",
        accountId: TEST_ACCOUNT_ID,
        source: "email" as const,
        receivedAt: "2024-01-15T10:00:00Z",
        from: { address: "sender@external.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Test email",
        textBody: "Hello world",
        attachments: [],
        headers: {},
        recipientAddress: "user@example.com",
        workflow: "conversation" as Workflow,
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
        spamScore: 0.01,
        summary: "A test email.",
        classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
        s3Key: "emails/msg-wrong-model",
        status: "active" as const,
        createdAt: "2024-01-15T10:00:00Z",
        embeddings: { "cohere.embed-english-v3": [0.1, 0.2, 0.3] },
        matchedRules: [],
      } as Signal,
    },
  ];

  // Build test cases: cross-product of signal variants × receive counts
  const RETRY_CASES = SIGNAL_VARIANTS.flatMap(({ label, signal }) =>
    RECEIVE_COUNTS.map((rc) => ({
      label: `${label}, receiveCount=${rc}`,
      signal,
      receiveCount: rc,
    })),
  );

  function arbArcForSignal(signal: Signal): Arc {
    return {
      id: signal.arcId!,
      accountId: signal.accountId,
      workflow: signal.workflow,
      labels: [],
      status: "active",
      summary: signal.summary,
      lastSignalAt: signal.receivedAt,
      createdAt: signal.receivedAt,
      updatedAt: signal.receivedAt,
    };
  }

  function makeMessage(sesMessageId: string): InboundSignalMessage {
    return {
      accountId: TEST_ACCOUNT_ID,
      s3Key: `emails/${sesMessageId}`,
      sesMessageId,
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  function makeStore(signal: Signal, arc: Arc) {
    const arcDb = {
      ...makeArcDbMock(),
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(arc))),
    } as unknown as ArcDatabase;
    const accountDb = makeAccountDbMock();
    const processingDb = makeProcessingDbMock();
    return { arcDb, accountDb, processingDb };
  }

  function makeAuroraWriter(): MultiClusterAuroraWriter {
    return {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };
  }

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  it.each(RETRY_CASES)("MIME parser is NOT called on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.sesMessageId!;
    const contentSanitizer: ContentSanitizerClient = { invoke: vi.fn() };

    const processor = new SignalProcessor({
      ...makeStore(signal, arc),
      contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(sesMessageId), receiveCount);
    expect(contentSanitizer.invoke).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES)("classifier is NOT called on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.sesMessageId!;
    const classifier: Pick<SignalClassifier, "classify"> = { classify: vi.fn() };

    const processor = new SignalProcessor({
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier,
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(sesMessageId), receiveCount);
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES)("rule evaluation is NOT called on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.sesMessageId!;
    const ruleEvaluator = new JsonLogicRuleEvaluator(mockLogger);
    const evaluateSpy = vi.spyOn(ruleEvaluator, "evaluate");

    const processor = new SignalProcessor({
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator,
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(sesMessageId), receiveCount);
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES.filter(c => c.signal.embeddings?.["amazon.titan-embed-text-v2:0"]))("Aurora upserts ARE called with the signal's cached embeddings on retry ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.sesMessageId!;
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(sesMessageId), receiveCount);

    expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();
    const call = vi.mocked(auroraWriter.upsertEmbedding).mock.calls[0]!;
    expect(call[0]).toMatchObject({
      arcId: arc.id,
      accountId: signal.accountId,
      embedding: signal.embeddings!["amazon.titan-embed-text-v2:0"],
    });
  });

  it.each(RETRY_CASES.filter(c => !c.signal.embeddings?.["amazon.titan-embed-text-v2:0"]))("Aurora upsert is SKIPPED when embedding is missing for cluster model ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.sesMessageId!;
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(sesMessageId), receiveCount);

    // Aurora upsert is NOT called when embedding is missing for the cluster's model
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES)("result is NOT a batchItemFailure on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.sesMessageId!;

    const processor = new SignalProcessor({
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    const result = await processor.processRecord(makeMessage(sesMessageId), receiveCount);
    expect(result.isOk()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Boundary: arcId falsy on retry → early error return
  // The code checks `if (!signal.arcId) return err(processError(...))`
  // -------------------------------------------------------------------------

  const FALSY_ARC_ID_CASES = [
    { label: "arcId=undefined (signal saved before arc assignment)", arcId: undefined },
    { label: "arcId='' (empty string — falsy)", arcId: "" },
  ] as const;

  it.each(FALSY_ARC_ID_CASES)("returns batchItemFailure when signal exists but $label", async ({ arcId }) => {
    const signal: Signal = {
      id: "sgn-noArc000000000000000abc",
      signalLookupId: "ses-msg-no-arc",
      sesMessageId: "msg-no-arc",
      arcId: arcId as string | undefined,
      accountId: TEST_ACCOUNT_ID,
      source: "email" as const,
      receivedAt: "2024-01-15T10:00:00Z",
      from: { address: "sender@external.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email",
      textBody: "Hello world",
      attachments: [],
      headers: {},
      recipientAddress: "user@example.com",
      workflow: "conversation" as Workflow,
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
      spamScore: 0.01,
      summary: "A test email.",
      classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      s3Key: "emails/msg-no-arc",
      status: "active" as const,
      createdAt: "2024-01-15T10:00:00Z",
      embeddings: { "amazon.titan-embed-text-v2:0": [0.1, 0.2] },
      matchedRules: [],
    } as Signal;

    const arcDb = {
      ...makeArcDbMock(),
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
    } as unknown as ArcDatabase;
    const accountDb = makeAccountDbMock();
    const processingDb = makeProcessingDbMock();

    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      arcDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    const result = await processor.processRecord(makeMessage("msg-no-arc"), 2);

    expect(result.isErr()).toBe(true);
    // No Aurora upserts should execute when arcId is falsy
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    // No DDB writes should execute
    expect(arcDb.saveSignal).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// Property 3: DDB read failure on retry returns batchItemFailure without writes
// **Validates: Requirements 1.5**
// ---------------------------------------------------------------------------

/**
 * For any retry attempt where the DDB read for the signal or arc record fails,
 * the processor SHALL return the record as a batchItemFailure without executing
 * any Aurora upserts, side-effect dispatches, or DDB writes.
 */
describe("Feature: signal-processor-retry-resilience, Property 3: DDB read failure on retry returns batchItemFailure without writes", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop3";

  const DEFAULT_ALIAS: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    unknownSenderPolicy: "allow_all",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    policy: "allow",
    addedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_CTX = {
    retentionDays: 0,
    filtering: null,
    emailConfig: DEFAULT_ALIAS,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  function makeRetryMessage(sesMessageId: string): InboundSignalMessage {
    return {
      accountId: TEST_ACCOUNT_ID,
      s3Key: `emails/${sesMessageId}`,
      sesMessageId,
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  function makeExistingSignal(sesMessageId: string): Signal {
    return {
      id: `sgn-${sesMessageId}`,
      signalLookupId: `ses-${sesMessageId}`,
      accountId: TEST_ACCOUNT_ID,
      sesMessageId,
      arcId: "arc-existing",
      source: "email",
      from: { address: "sender@external.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      attachments: [],
      headers: {},
      recipientAddress: "user@example.com",
      senderAddress: "sender@external.com",
      senderName: "Sender",
      subject: "Test email",
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      spamScore: 0.01,
      classificationModelId: "test-model",
      summary: "A test email.",
      labels: [],
      status: "active",
      s3Key: `emails/${sesMessageId}`,
      matchedRules: [],
      receivedAt: "2024-01-15T10:00:00Z",
      createdAt: "2024-01-15T10:00:01Z",
      updatedAt: "2024-01-15T10:00:01Z",
      embeddings: { "amazon.titan-embed-text-v2:0": new Array(10).fill(0.1) },
    } as Signal;
  }

  function makeAuroraWriter(): MultiClusterAuroraWriter {
    return {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };
  }

  function makeStore(overrides: { getSignalByMessageId?: unknown; getArc?: unknown } = {}) {
    const arcDb = {
      ...makeArcDbMock(),
      ...(overrides.getSignalByMessageId ? { getSignalByMessageId: overrides.getSignalByMessageId } : {}),
      ...(overrides.getArc ? { getArc: overrides.getArc } : {}),
    } as unknown as ArcDatabase;
    const accountDb = makeAccountDbMock();
    const processingDb = makeProcessingDbMock();
    return { arcDb, accountDb, processingDb };
  }

  // -------------------------------------------------------------------------
  // Edge-case inputs
  // -------------------------------------------------------------------------

  const DDB_ERRORS = [
    { label: "connection timeout", error: dbError(new Error("DDB error: Connection timeout")) },
    { label: "throughput exceeded", error: dbError(new Error("DDB error: ProvisionedThroughputExceededException")) },
  ] as const;

  // receiveCount values that exercise different log-level branches on failure:
  // - 2: first retry (warn level)
  // - 30: at threshold (warn level — threshold is >30)
  // - 31: exceeds threshold (error level)
  const RETRY_RECEIVE_COUNTS = [2, 30, 31] as const;

  const SES_MESSAGE_IDS = ["abc123", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"] as const;

  const SIGNAL_READ_FAILURE_CASES = DDB_ERRORS.flatMap(({ label: errLabel, error }) =>
    RETRY_RECEIVE_COUNTS.flatMap((rc) =>
      SES_MESSAGE_IDS.map((msgId) => ({
        label: `error="${errLabel}", receiveCount=${rc}, msgId="${msgId}"`,
        error,
        receiveCount: rc,
        sesMessageId: msgId,
      })),
    ),
  );

  const ARC_READ_FAILURE_CASES = DDB_ERRORS.flatMap(({ label: errLabel, error }) =>
    RETRY_RECEIVE_COUNTS.map((rc) => ({
      label: `error="${errLabel}", receiveCount=${rc}`,
      error,
      receiveCount: rc,
      sesMessageId: "test-msg-arc-fail",
    })),
  );

  it.each(SIGNAL_READ_FAILURE_CASES)("signal read failure returns batchItemFailure without Aurora upserts or DDB writes ($label)", async ({ error, receiveCount, sesMessageId }) => {
    const { arcDb, accountDb, processingDb } = makeStore({
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(err(error))),
    });
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      arcDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    const result = await processor.processRecord(makeRetryMessage(sesMessageId), receiveCount);

    expect(result.isErr()).toBe(true);
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    expect(arcDb.saveSignal).not.toHaveBeenCalled();
    expect(arcDb.saveArc).not.toHaveBeenCalled();
  });

  it.each(ARC_READ_FAILURE_CASES)("arc read failure returns batchItemFailure without Aurora upserts or DDB writes ($label)", async ({ error, receiveCount, sesMessageId }) => {
    const existingSignal = makeExistingSignal(sesMessageId);
    const { arcDb, accountDb, processingDb } = makeStore({
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(existingSignal))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(err(error))),
    });
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      arcDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    const result = await processor.processRecord(makeRetryMessage(sesMessageId), receiveCount);

    expect(result.isErr()).toBe(true);
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    expect(arcDb.saveSignal).not.toHaveBeenCalled();
    expect(arcDb.saveArc).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// Property 2: Missing signal on retry triggers fresh processing
// **Validates: Requirements 1.3**
// ---------------------------------------------------------------------------

/**
 * For any SQS record with receiveCount > 1 where the signal does NOT exist
 * in DDB, the processor SHALL execute the full first-attempt pipeline (parse,
 * classify, match, save) identically to a first delivery.
 */
describe("Feature: signal-processor-retry-resilience, Property 2: Missing signal on retry triggers fresh processing", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop2";

  const DEFAULT_ALIAS: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    unknownSenderPolicy: "allow_all",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    policy: "allow",
    addedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_CTX = {
    retentionDays: 0,
    filtering: null,
    emailConfig: DEFAULT_ALIAS,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  const validClassification = {
    workflow: "conversation" as const,
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.01,
    summary: "A test email.",
    labels: [],
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
  };

  function makeStore() {
    return { arcDb: makeArcDbMock(), accountDb: makeAccountDbMock(), processingDb: makeProcessingDbMock() };
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
    return { classify: vi.fn().mockResolvedValue({ ...validClassification }) };
  }

  function makeEmbeddingGenerator(): EmbeddingGenerator {
    return {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: new Array(10).fill(0.1), dimensions: 1024 }),
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

  function makeMessage(sesMessageId: string): InboundSignalMessage {
    return {
      accountId: TEST_ACCOUNT_ID,
      s3Key: `emails/${sesMessageId}`,
      sesMessageId,
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  // -------------------------------------------------------------------------
  // Edge-case inputs
  // -------------------------------------------------------------------------

  const MISSING_SIGNAL_CASES = [
    { label: "receiveCount=2 (first retry — enters retry path, falls through to full pipeline)", receiveCount: 2, sesMessageId: "msg-missing-first-retry" },
    { label: "receiveCount=30 (at threshold — still warn level on failure)", receiveCount: 30, sesMessageId: "msg-missing-at-threshold" },
    { label: "receiveCount=31 (exceeds threshold — error level on failure)", receiveCount: 31, sesMessageId: "msg-missing-over-threshold" },
  ] as const;

  it.each(MISSING_SIGNAL_CASES)("MIME parser IS called when signal does not exist on retry ($label)", async ({ receiveCount, sesMessageId }) => {
    const contentSanitizer = makeContentSanitizer();

    const processor = new SignalProcessor({
      ...makeStore(),
      contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(sesMessageId), receiveCount);
    expect(contentSanitizer.invoke).toHaveBeenCalled();
  });

  it.each(MISSING_SIGNAL_CASES)("classifier IS called when signal does not exist on retry ($label)", async ({ receiveCount, sesMessageId }) => {
    const classifier = makeClassifier();

    const processor = new SignalProcessor({
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier,
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(sesMessageId), receiveCount);
    expect(classifier.classify).toHaveBeenCalled();
  });

  it.each(MISSING_SIGNAL_CASES)("saveArc and saveSignal ARE called when signal does not exist on retry ($label)", async ({ receiveCount, sesMessageId }) => {
    const { arcDb, accountDb, processingDb } = makeStore();

    const processor = new SignalProcessor({
      arcDb, accountDb, processingDb,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(sesMessageId), receiveCount);
    expect(arcDb.saveArc).toHaveBeenCalled();
    expect(arcDb.saveSignal).toHaveBeenCalled();
  });

  it.each(MISSING_SIGNAL_CASES)("result is NOT a batchItemFailure when signal does not exist on retry ($label)", async ({ receiveCount, sesMessageId }) => {
    const processor = new SignalProcessor({
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    const result = await processor.processRecord(makeMessage(sesMessageId), receiveCount);
    expect(result.isOk()).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Property 8: Outcome re-derived from persisted matchedRules on retry
// **Validates: Requirements 4.1**
// ---------------------------------------------------------------------------

/**
 * For any signal that exists in DDB on retry, the processor SHALL call
 * `deriveOutcome()` with the signal's persisted `matchedRules` field to
 * reconstruct the processing outcome, rather than re-evaluating rules against
 * the current rule set.
 */
describe("Feature: signal-processor-retry-resilience, Property 8: Outcome re-derived from persisted matchedRules on retry", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop8";

  const DEFAULT_ALIAS: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    unknownSenderPolicy: "allow_all",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    policy: "allow",
    addedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_CTX = {
    retentionDays: 0,
    filtering: null,
    emailConfig: DEFAULT_ALIAS,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  // -------------------------------------------------------------------------
  // Edge-case inputs for matchedRules
  // -------------------------------------------------------------------------

  const MATCHED_RULES_CASES = [
    {
      label: "empty matchedRules (no actions — default outcome)",
      matchedRules: [],
    },
    {
      label: "single forward action (triggers side-effect dispatch)",
      matchedRules: [{ ruleId: "rule-1", actions: [{ type: "forward", value: "fwd@example.com" }], labelsAdded: [], statusChange: undefined }],
    },
    {
      label: "pong action (triggers test reply side-effect)",
      matchedRules: [{ ruleId: "rule-pong", actions: [{ type: "pong" }], labelsAdded: [], statusChange: undefined }],
    },
    {
      label: "suppress_notification (suppresses notify side-effect)",
      matchedRules: [{ ruleId: "rule-suppress", actions: [{ type: "suppress_notification" }], labelsAdded: [], statusChange: undefined }],
    },
    {
      label: "block action (first-wins status: blocked)",
      matchedRules: [{ ruleId: "rule-block", actions: [{ type: "block" }], labelsAdded: [], statusChange: "blocked" as const }],
    },
    {
      label: "conflicting status actions (first-wins: block beats archive)",
      matchedRules: [
        { ruleId: "rule-block", actions: [{ type: "block" }], labelsAdded: [], statusChange: "blocked" as const },
        { ruleId: "rule-archive", actions: [{ type: "archive" }], labelsAdded: [], statusChange: "archived" as const },
      ],
    },
    {
      label: "multiple non-status actions (forward + label + suppress)",
      matchedRules: [
        { ruleId: "rule-fwd", actions: [{ type: "forward", value: "fwd@example.com" }, { type: "assign_label", value: "urgent" }], labelsAdded: ["urgent"], statusChange: undefined },
        { ruleId: "rule-suppress", actions: [{ type: "suppress_notification" }], labelsAdded: [], statusChange: undefined },
      ],
    },
  ] as const;

  // Only test receive counts that exercise different code paths
  const RECEIVE_COUNTS = [2, 31] as const;

  const PROP8_CASES = MATCHED_RULES_CASES.flatMap(({ label: ruleLabel, matchedRules }) =>
    RECEIVE_COUNTS.map((rc) => ({
      label: `${ruleLabel}, receiveCount=${rc}`,
      matchedRules,
      receiveCount: rc,
    })),
  );

  function makeSignalWithRules(matchedRules: readonly unknown[]): Signal {
    return {
      id: "sgn-prop8000000000000000abc",
      signalLookupId: "ses-msg-prop8",
      sesMessageId: "msg-prop8",
      arcId: "arc-prop8",
      accountId: TEST_ACCOUNT_ID,
      source: "email" as const,
      receivedAt: "2024-01-15T10:00:00Z",
      from: { address: "sender@external.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email with rules",
      textBody: "Hello world",
      attachments: [],
      headers: {},
      recipientAddress: "user@example.com",
      workflow: "conversation" as Workflow,
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
      spamScore: 0.01,
      summary: "A test email.",
      classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      s3Key: "emails/msg-prop8",
      status: "active" as const,
      createdAt: "2024-01-15T10:00:00Z",
      embeddings: { "amazon.titan-embed-text-v2:0": [0.1, -0.5, 0.3] },
      matchedRules: matchedRules as Signal["matchedRules"],
    } as Signal;
  }

  function makeArc(): Arc {
    return {
      id: "arc-prop8",
      accountId: TEST_ACCOUNT_ID,
      workflow: "conversation" as Workflow,
      labels: [],
      status: "active",
      summary: "A test email.",
      lastSignalAt: "2024-01-15T10:00:00Z",
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z",
    };
  }

  function makeMessage(): InboundSignalMessage {
    return {
      accountId: TEST_ACCOUNT_ID,
      s3Key: "emails/msg-prop8",
      sesMessageId: "msg-prop8",
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  it.each(PROP8_CASES)("listEnabledRules is NOT called on retry when signal exists in DDB ($label)", async ({ matchedRules, receiveCount }) => {
    const signal = makeSignalWithRules(matchedRules);
    const arc = makeArc();

    const arcDb = {
      ...makeArcDbMock(),
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(arc))),
    } as unknown as ArcDatabase;
    const accountDb = makeAccountDbMock();
    const processingDb = makeProcessingDbMock();

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({
      arcDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: { upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)), findMatch: vi.fn().mockResolvedValue(ok(null)) },
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      sqsDispatcher,
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(), receiveCount);
    expect(accountDb.listEnabledRules).not.toHaveBeenCalled();
  });

  it.each(PROP8_CASES)("dispatched side-effect payload contains the signal's persisted matchedRules ($label)", async ({ matchedRules, receiveCount }) => {
    const signal = makeSignalWithRules(matchedRules);
    const arc = makeArc();

    const arcDb = {
      ...makeArcDbMock(),
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(arc))),
    } as unknown as ArcDatabase;
    const accountDb = makeAccountDbMock();
    const processingDb = makeProcessingDbMock();

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({
      arcDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: { upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)), findMatch: vi.fn().mockResolvedValue(ok(null)) },
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      sqsDispatcher,
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "mock-reply-id" }) },
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });

    await processor.processRecord(makeMessage(), receiveCount);

    expect(sqsDispatcher.sendMessage).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
    expect(payload.signal.matchedRules).toEqual(signal.matchedRules);
  });
});
