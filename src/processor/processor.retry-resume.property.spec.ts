import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SQSEvent } from "aws-lambda";
import { ok, err } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher, SqsDispatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier } from "../classifier/classifier.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Signal, Arc, Alias, AliasSender, Workflow } from "../types/index.js";
import { dbError } from "../errors.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with a single active cluster
// ---------------------------------------------------------------------------

vi.mock("../embedding/cluster-registry.js", () => {
  const cluster = Object.freeze({
    clusterId: "cluster-primary",
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
    getClusterById: (id: string) => (id === cluster.clusterId ? cluster : null),
    getReadCluster: () => cluster,
  };
});

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
    filterMode: "allow_all",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    mode: "allow",
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
        id: "SES#msg-valid-emb",
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
        id: "SES#msg-no-emb",
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
        id: "SES#msg-wrong-model",
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

  function makeSqsEvent(sesMessageId: string, receiveCount: number): SQSEvent {
    const notification = {
      accountId: TEST_ACCOUNT_ID,
      mail: {
        messageId: sesMessageId,
        timestamp: "2024-01-15T10:00:00Z",
        destination: ["user@example.com"],
      },
      receipt: {
        recipients: ["user@example.com"],
        dkimVerdict: { status: "PASS" },
        dmarcVerdict: { status: "PASS" },
        action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
      },
    };
    return {
      Records: [{
        messageId: "sqs-1",
        receiptHandle: "handle",
        body: JSON.stringify({ Message: JSON.stringify(notification) }),
        attributes: {
          ApproximateReceiveCount: String(receiveCount),
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

  function makeStore(signal: Signal, arc: Arc): ProcessorDatabase {
    return {
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(arc))),
      findArcByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      saveArc: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok(SYSTEM_RULES))),
      getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_CTX))),
      saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a))),
      getSender: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY))),
      saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    };
  }

  function makeAuroraWriter(): MultiClusterAuroraWriter {
    return {
      upsertEmbedding: vi.fn().mockResolvedValue(undefined),
      findMatch: vi.fn().mockResolvedValue(null),
    };
  }

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  it.each(RETRY_CASES)("MIME parser is NOT called on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.id.replace("SES#", "");
    const mimeParser: MimeParser = { parse: vi.fn() };

    const processor = new SignalProcessor({
      store: makeStore(signal, arc),
      mimeParser,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(sesMessageId, receiveCount));
    expect(mimeParser.parse).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES)("classifier is NOT called on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.id.replace("SES#", "");
    const classifier: Pick<SignalClassifier, "classify"> = { classify: vi.fn() };

    const processor = new SignalProcessor({
      store: makeStore(signal, arc),
      mimeParser: { parse: vi.fn() },
      classifier,
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(sesMessageId, receiveCount));
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES)("rule evaluation is NOT called on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.id.replace("SES#", "");
    const ruleEvaluator = new JsonLogicRuleEvaluator(mockLogger);
    const evaluateSpy = vi.spyOn(ruleEvaluator, "evaluate");

    const processor = new SignalProcessor({
      store: makeStore(signal, arc),
      mimeParser: { parse: vi.fn() },
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator,
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(sesMessageId, receiveCount));
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES.filter(c => c.signal.embeddings?.["amazon.titan-embed-text-v2:0"]))("Aurora upserts ARE called with the signal's cached embeddings on retry ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.id.replace("SES#", "");
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      store: makeStore(signal, arc),
      mimeParser: { parse: vi.fn() },
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(sesMessageId, receiveCount));

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
    const sesMessageId = signal.id.replace("SES#", "");
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      store: makeStore(signal, arc),
      mimeParser: { parse: vi.fn() },
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(sesMessageId, receiveCount));

    // Aurora upsert is NOT called when embedding is missing for the cluster's model
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES)("result is NOT a batchItemFailure on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const sesMessageId = signal.id.replace("SES#", "");

    const processor = new SignalProcessor({
      store: makeStore(signal, arc),
      mimeParser: { parse: vi.fn() },
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    const result = await processor.process(makeSqsEvent(sesMessageId, receiveCount));
    expect(result.batchItemFailures).toEqual([]);
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
      id: "SES#msg-no-arc",
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

    const store: ProcessorDatabase = {
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      findArcByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      saveArc: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok(SYSTEM_RULES))),
      getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_CTX))),
      saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a))),
      getSender: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY))),
      saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    };

    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      store,
      mimeParser: { parse: vi.fn() },
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    const result = await processor.process(makeSqsEvent("msg-no-arc", 2));

    expect(result.batchItemFailures).toHaveLength(1);
    // No Aurora upserts should execute when arcId is falsy
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    // No DDB writes should execute
    expect(store.saveSignal).not.toHaveBeenCalled();
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
    filterMode: "allow_all",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    mode: "allow",
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

  function makeRetrySqsEvent(sesMessageId: string, receiveCount: number): SQSEvent {
    const notification = {
      accountId: TEST_ACCOUNT_ID,
      mail: {
        messageId: sesMessageId,
        timestamp: "2024-01-15T10:00:00Z",
        destination: ["user@example.com"],
      },
      receipt: {
        recipients: ["user@example.com"],
        dkimVerdict: { status: "PASS" },
        dmarcVerdict: { status: "PASS" },
        action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
      },
    };
    return {
      Records: [{
        messageId: "sqs-retry-1",
        receiptHandle: "handle",
        body: JSON.stringify({ Message: JSON.stringify(notification) }),
        attributes: {
          ApproximateReceiveCount: String(receiveCount),
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

  function makeExistingSignal(sesMessageId: string): Signal {
    return {
      id: `sig-${sesMessageId}`,
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
      upsertEmbedding: vi.fn().mockResolvedValue(undefined),
      findMatch: vi.fn().mockResolvedValue(null),
    };
  }

  function makeStore(overrides: Partial<ProcessorDatabase> = {}): ProcessorDatabase {
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
      getSender: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY))),
      saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      ...overrides,
    };
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
    const store = makeStore({
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(err(error))),
    });
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      store,
      mimeParser: { parse: vi.fn() },
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    const result = await processor.process(makeRetrySqsEvent(sesMessageId, receiveCount));

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0]!.itemIdentifier).toBe("sqs-retry-1");
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    expect(store.saveSignal).not.toHaveBeenCalled();
    expect(store.saveArc).not.toHaveBeenCalled();
  });

  it.each(ARC_READ_FAILURE_CASES)("arc read failure returns batchItemFailure without Aurora upserts or DDB writes ($label)", async ({ error, receiveCount, sesMessageId }) => {
    const existingSignal = makeExistingSignal(sesMessageId);
    const store = makeStore({
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(existingSignal))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(err(error))),
    });
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      store,
      mimeParser: { parse: vi.fn() },
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    const result = await processor.process(makeRetrySqsEvent(sesMessageId, receiveCount));

    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0]!.itemIdentifier).toBe("sqs-retry-1");
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    expect(store.saveSignal).not.toHaveBeenCalled();
    expect(store.saveArc).not.toHaveBeenCalled();
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
    filterMode: "allow_all",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    mode: "allow",
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

  function makeStore(): ProcessorDatabase {
    return {
      // Signal does NOT exist — triggers fresh processing on retry
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      findArcByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      saveArc: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok(SYSTEM_RULES))),
      getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_CTX))),
      saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a))),
      getSender: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY))),
      saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    };
  }

  function makeMimeParser(): MimeParser {
    return {
      parse: vi.fn().mockResolvedValue({
        from: { address: "sender@example.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Test email",
        textBody: "Hello world",
        htmlBody: "<p>Hello world</p>",
        attachments: [],
        headers: {},
        sentAt: "2024-01-15T09:00:00Z",
      }),
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
      upsertEmbedding: vi.fn().mockResolvedValue(undefined),
      findMatch: vi.fn().mockResolvedValue(null),
    };
  }

  function makeArcMatcher(): ArcMatcher {
    return {
      findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };
  }

  function makeSqsEvent(sesMessageId: string, receiveCount: number): SQSEvent {
    const notification = {
      accountId: TEST_ACCOUNT_ID,
      mail: {
        messageId: sesMessageId,
        timestamp: "2024-01-15T10:00:00Z",
        destination: ["user@example.com"],
      },
      receipt: {
        recipients: ["user@example.com"],
        dkimVerdict: { status: "PASS" },
        dmarcVerdict: { status: "PASS" },
        action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
      },
    };
    return {
      Records: [{
        messageId: "sqs-1",
        receiptHandle: "handle",
        body: JSON.stringify({ Message: JSON.stringify(notification) }),
        attributes: {
          ApproximateReceiveCount: String(receiveCount),
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

  // -------------------------------------------------------------------------
  // Edge-case inputs
  // -------------------------------------------------------------------------

  const MISSING_SIGNAL_CASES = [
    { label: "receiveCount=2 (first retry — enters retry path, falls through to full pipeline)", receiveCount: 2, sesMessageId: "msg-missing-first-retry" },
    { label: "receiveCount=30 (at threshold — still warn level on failure)", receiveCount: 30, sesMessageId: "msg-missing-at-threshold" },
    { label: "receiveCount=31 (exceeds threshold — error level on failure)", receiveCount: 31, sesMessageId: "msg-missing-over-threshold" },
  ] as const;

  it.each(MISSING_SIGNAL_CASES)("MIME parser IS called when signal does not exist on retry ($label)", async ({ receiveCount, sesMessageId }) => {
    const mimeParser = makeMimeParser();

    const processor = new SignalProcessor({
      store: makeStore(),
      mimeParser,
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(sesMessageId, receiveCount));
    expect(mimeParser.parse).toHaveBeenCalled();
  });

  it.each(MISSING_SIGNAL_CASES)("classifier IS called when signal does not exist on retry ($label)", async ({ receiveCount, sesMessageId }) => {
    const classifier = makeClassifier();

    const processor = new SignalProcessor({
      store: makeStore(),
      mimeParser: makeMimeParser(),
      classifier,
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(sesMessageId, receiveCount));
    expect(classifier.classify).toHaveBeenCalled();
  });

  it.each(MISSING_SIGNAL_CASES)("saveArc and saveSignal ARE called when signal does not exist on retry ($label)", async ({ receiveCount, sesMessageId }) => {
    const store = makeStore();

    const processor = new SignalProcessor({
      store,
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(sesMessageId, receiveCount));
    expect(store.saveArc).toHaveBeenCalled();
    expect(store.saveSignal).toHaveBeenCalled();
  });

  it.each(MISSING_SIGNAL_CASES)("result is NOT a batchItemFailure when signal does not exist on retry ($label)", async ({ receiveCount, sesMessageId }) => {
    const processor = new SignalProcessor({
      store: makeStore(),
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    const result = await processor.process(makeSqsEvent(sesMessageId, receiveCount));
    expect(result.batchItemFailures).toEqual([]);
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
    filterMode: "allow_all",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    mode: "allow",
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
      id: "SES#msg-prop8",
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

  function makeSqsEvent(receiveCount: number): SQSEvent {
    const notification = {
      accountId: TEST_ACCOUNT_ID,
      mail: {
        messageId: "msg-prop8",
        timestamp: "2024-01-15T10:00:00Z",
        destination: ["user@example.com"],
      },
      receipt: {
        recipients: ["user@example.com"],
        dkimVerdict: { status: "PASS" },
        dmarcVerdict: { status: "PASS" },
        action: { bucketName: "test-bucket", objectKey: "emails/msg-prop8" },
      },
    };
    return {
      Records: [{
        messageId: "sqs-1",
        receiptHandle: "handle",
        body: JSON.stringify({ Message: JSON.stringify(notification) }),
        attributes: {
          ApproximateReceiveCount: String(receiveCount),
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

  it.each(PROP8_CASES)("listEnabledRules is NOT called on retry when signal exists in DDB ($label)", async ({ matchedRules, receiveCount }) => {
    const signal = makeSignalWithRules(matchedRules);
    const arc = makeArc();

    const store: ProcessorDatabase = {
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(arc))),
      findArcByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      saveArc: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok(SYSTEM_RULES))),
      getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_CTX))),
      saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a))),
      getSender: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY))),
      saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    };

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({
      store,
      mimeParser: { parse: vi.fn() },
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: { upsertEmbedding: vi.fn().mockResolvedValue(undefined), findMatch: vi.fn().mockResolvedValue(null) },
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      sqsDispatcher,
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(receiveCount));
    expect(store.listEnabledRules).not.toHaveBeenCalled();
  });

  it.each(PROP8_CASES)("dispatched side-effect payload contains the signal's persisted matchedRules ($label)", async ({ matchedRules, receiveCount }) => {
    const signal = makeSignalWithRules(matchedRules);
    const arc = makeArc();

    const store: ProcessorDatabase = {
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(arc))),
      findArcByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      saveArc: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok(SYSTEM_RULES))),
      getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_CTX))),
      saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a))),
      getSender: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY))),
      saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    };

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({
      store,
      mimeParser: { parse: vi.fn() },
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: { upsertEmbedding: vi.fn().mockResolvedValue(undefined), findMatch: vi.fn().mockResolvedValue(null) },
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      sqsDispatcher,
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent(receiveCount));

    expect(sqsDispatcher.sendMessage).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
    expect(payload.signal.matchedRules).toEqual(signal.matchedRules);
  });
});
