import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SQSEvent } from "aws-lambda";
import { ok, okAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { S3RetentionService } from "../embedding/s3-retention-service.js";
import type { Alias, AliasSender } from "../types/index.js";
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
    getSecondaryClusters: () => [],
  };
});

// ---------------------------------------------------------------------------
// Property 9: S3 retention failure is isolated and non-fatal
// **Validates: Requirements 5.1, 5.3**
// ---------------------------------------------------------------------------

/**
 * For any S3 retention operation that fails, the processor SHALL log at warn
 * level, continue processing (Aurora upserts and side-effect dispatch), and
 * SHALL NOT return a batchItemFailure due to the S3 error. The processing
 * outcome SHALL be identical to what it would be without the S3 failure.
 */
describe("Property 9: S3 retention failure is isolated and non-fatal", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop9";

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

  const validClassification: ClassificationOutput = {
    workflow: "conversation",
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.01,
    summary: "A test email.",
    labels: [],
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
  };

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
      getSender: vi.fn().mockReturnValue(okAsync(DEFAULT_SENDER_ENTRY)),
      saveSender: vi.fn().mockReturnValue(okAsync(undefined)),
      getTemplate: vi.fn().mockReturnValue(okAsync(null)),
      updateGlobalReputation: vi.fn().mockReturnValue(okAsync(undefined)),
      getDomainByName: vi.fn().mockReturnValue(okAsync(null)),
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
      findMatch: vi.fn().mockReturnValue(okAsync(null)),
      upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)),
    };
  }

  function makeSqsEvent(sesMessageId: string): SQSEvent {
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
          ApproximateReceiveCount: "1",
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
  // Edge-case inputs: S3 failure modes
  // The code has TWO distinct error paths:
  // 1. ResultAsync error: applyPlanRetention rejects → caught by ResultAsync.fromPromise → logs "processor.s3_retention_failed"
  // 2. Thrown exception: code outside ResultAsync throws → caught by outer try/catch → logs "processor.s3_retention_unexpected"
  // -------------------------------------------------------------------------

  const S3_RESULT_ASYNC_ERROR_CASES = [
    { label: "rejected promise (ResultAsync error path — S3 connection reset)", error: new Error("S3 error: connection reset") },
    { label: "rejected promise (ResultAsync error path — access denied)", error: new Error("AccessDenied: insufficient permissions") },
    { label: "rejected promise (ResultAsync error path — no such key)", error: new Error("NoSuchKey: object not found") },
  ] as const;

  it.each(S3_RESULT_ASYNC_ERROR_CASES)("S3 retention failure does not produce a batchItemFailure ($label)", async ({ error }) => {
    const retentionService: S3RetentionService = {
      applyPlanRetention: vi.fn().mockRejectedValue(error),
    };

    const processor = new SignalProcessor({
      store: makeStore(),
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      retentionService,
    });

    const result = await processor.process(makeSqsEvent("test-msg-s3-isolation"));
    expect(result.batchItemFailures).toEqual([]);
  });

  it.each(S3_RESULT_ASYNC_ERROR_CASES)("Aurora upserts still execute when S3 retention fails ($label)", async ({ error }) => {
    const auroraWriter = makeAuroraWriter();

    const retentionService: S3RetentionService = {
      applyPlanRetention: vi.fn().mockRejectedValue(error),
    };

    const processor = new SignalProcessor({
      store: makeStore(),
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter,
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      retentionService,
    });

    await processor.process(makeSqsEvent("test-msg-s3-aurora"));
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();
  });

  it.each(S3_RESULT_ASYNC_ERROR_CASES)("warn-level log is emitted when S3 retention fails ($label)", async ({ error }) => {
    mockLogger = createMockLogger();

    const retentionService: S3RetentionService = {
      applyPlanRetention: vi.fn().mockRejectedValue(error),
    };

    const processor = new SignalProcessor({
      store: makeStore(),
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      retentionService,
    });

    await processor.process(makeSqsEvent("test-msg-s3-warn"));

    const warnCalls = mockLogger.calls.filter((c) => c.method === "warn");
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);

    const s3WarnCall = warnCalls.find((c) =>
      c.message.toLowerCase().includes("s3") || c.message.toLowerCase().includes("retention"),
    );
    expect(s3WarnCall).toBeDefined();
  });

  it.each(S3_RESULT_ASYNC_ERROR_CASES)("processing outcome is identical with and without S3 failure ($label)", async ({ error }) => {
    // Run 1: with S3 failure
    const store1 = makeStore();
    const auroraWriter1 = makeAuroraWriter();
    const failingRetention: S3RetentionService = {
      applyPlanRetention: vi.fn().mockRejectedValue(error),
    };
    const logger1 = createMockLogger();

    const processor1 = new SignalProcessor({
      store: store1,
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: auroraWriter1,
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(logger1),
      logger: logger1,
      retentionService: failingRetention,
    });

    const result1 = await processor1.process(makeSqsEvent("test-msg-s3-outcome"));

    // Run 2: without S3 retention service (no retention at all)
    const store2 = makeStore();
    const auroraWriter2 = makeAuroraWriter();
    const logger2 = createMockLogger();

    const processor2 = new SignalProcessor({
      store: store2,
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: auroraWriter2,
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(logger2),
      logger: logger2,
      // No retentionService — S3 retention is skipped entirely
    });

    const result2 = await processor2.process(makeSqsEvent("test-msg-s3-outcome"));

    // Both runs must produce the same batchItemFailures result
    expect(result1.batchItemFailures).toEqual(result2.batchItemFailures);

    // Both runs must call saveSignal (signal was persisted)
    expect(store1.saveSignal).toHaveBeenCalled();
    expect(store2.saveSignal).toHaveBeenCalled();

    // Both runs must call Aurora upsert
    expect(auroraWriter1.upsertEmbedding).toHaveBeenCalled();
    expect(auroraWriter2.upsertEmbedding).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Boundary: retentionService undefined (no S3 retention configured)
  // The code does `if (!this.retentionService) return;` — early exit, no error
  // -------------------------------------------------------------------------

  it("no retentionService configured — processing succeeds without any S3 interaction", async () => {
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({
      store: makeStore(),
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter,
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      // No retentionService — S3 retention is skipped entirely
    });

    const result = await processor.process(makeSqsEvent("test-msg-no-retention-svc"));

    expect(result.batchItemFailures).toEqual([]);
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Boundary: applyPlanRetention resolves successfully but returns a value
  // that triggers the outer try/catch (e.g., getRetentionForPlan throws)
  // This exercises the "processor.s3_retention_unexpected" log path
  // -------------------------------------------------------------------------

  it("outer try/catch path — non-promise error in retention flow logs warn and continues", async () => {
    mockLogger = createMockLogger();
    const auroraWriter = makeAuroraWriter();

    // applyPlanRetention resolves, but we'll make the retention service throw
    // synchronously before the promise is awaited by using a getter that throws
    const retentionService: S3RetentionService = {
      applyPlanRetention: vi.fn().mockImplementation(() => {
        throw new Error("Unexpected sync error in retention");
      }),
    };

    const processor = new SignalProcessor({
      store: makeStore(),
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter,
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      retentionService,
    });

    const result = await processor.process(makeSqsEvent("test-msg-s3-sync-throw"));

    // Processing continues — no batchItemFailure
    expect(result.batchItemFailures).toEqual([]);
    // Aurora upserts still execute
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();

    // Warn log emitted for the unexpected error
    const warnCalls = mockLogger.calls.filter((c) => c.method === "warn");
    const unexpectedWarn = warnCalls.find((c) =>
      c.message.toLowerCase().includes("unexpected") || c.message.toLowerCase().includes("s3") || c.message.toLowerCase().includes("retention"),
    );
    expect(unexpectedWarn).toBeDefined();
  });
});
