import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { okAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { S3RetentionService } from "../embedding/s3-retention-service.js";
import type { Alias, AliasSender } from "../types/index.js";
import { propertyRunner } from "../testing/property-runner.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with a single active cluster
// ---------------------------------------------------------------------------

vi.mock("../embedding/cluster-registry.js", () => {
  const cluster = Object.freeze({
    clusterId: "cluster-primary",
    clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-primary",
    secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-primary",
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
      generateForActiveClusters: vi.fn().mockResolvedValue([
        { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(10).fill(0.1), dimensions: 1024 },
      ] as EmbeddingResult[]),
      generateForModel: vi.fn().mockResolvedValue(
        { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(10).fill(0.1), dimensions: 1024 } as EmbeddingResult,
      ),
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

  // Arbitrary S3 failure modes: thrown errors and rejected promises
  const arbS3Error = fc.oneof(
    fc.string({ minLength: 1, maxLength: 50 }).map((msg) => new Error(`S3 error: ${msg}`)),
    fc.string({ minLength: 1, maxLength: 50 }).map((msg) => new Error(`AccessDenied: ${msg}`)),
    fc.string({ minLength: 1, maxLength: 50 }).map((msg) => new Error(`NoSuchKey: ${msg}`)),
  );

  it("S3 retention failure does not produce a batchItemFailure", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        arbS3Error,
        fc.constant("test-msg-s3-isolation"),
        async (s3Error, sesMessageId) => {
          const store = makeStore();
          const auroraWriter = makeAuroraWriter();

          const retentionService: S3RetentionService = {
            applyPlanRetention: vi.fn().mockRejectedValue(s3Error),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator: makeEmbeddingGenerator(),
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
            retentionService,
          });

          const result = await processor.process(makeSqsEvent(sesMessageId));

          // S3 failure must NOT produce a batchItemFailure
          expect(result.batchItemFailures).toEqual([]);
        },
      ),
    );
  });

  it("Aurora upserts still execute when S3 retention fails", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        arbS3Error,
        fc.constant("test-msg-s3-aurora"),
        async (s3Error, sesMessageId) => {
          const store = makeStore();
          const auroraWriter = makeAuroraWriter();

          const retentionService: S3RetentionService = {
            applyPlanRetention: vi.fn().mockRejectedValue(s3Error),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator: makeEmbeddingGenerator(),
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
            retentionService,
          });

          await processor.process(makeSqsEvent(sesMessageId));

          // Aurora upsert must still be called despite S3 failure
          expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();
        },
      ),
    );
  });

  it("warn-level log is emitted when S3 retention fails", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        arbS3Error,
        fc.constant("test-msg-s3-warn"),
        async (s3Error, sesMessageId) => {
          mockLogger = createMockLogger();

          const retentionService: S3RetentionService = {
            applyPlanRetention: vi.fn().mockRejectedValue(s3Error),
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

          await processor.process(makeSqsEvent(sesMessageId));

          // A warn-level log must be emitted for the S3 failure
          const warnCalls = mockLogger.calls.filter((c) => c.method === "warn");
          expect(warnCalls.length).toBeGreaterThanOrEqual(1);

          // At least one warn call should relate to S3 retention
          const s3WarnCall = warnCalls.find((c) =>
            c.message.toLowerCase().includes("s3") || c.message.toLowerCase().includes("retention"),
          );
          expect(s3WarnCall).toBeDefined();
        },
      ),
    );
  });

  it("processing outcome is identical with and without S3 failure", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        arbS3Error,
        fc.constant("test-msg-s3-outcome"),
        async (s3Error, sesMessageId) => {
          // Run 1: with S3 failure
          const store1 = makeStore();
          const auroraWriter1 = makeAuroraWriter();
          const failingRetention: S3RetentionService = {
            applyPlanRetention: vi.fn().mockRejectedValue(s3Error),
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

          const result1 = await processor1.process(makeSqsEvent(sesMessageId));

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

          const result2 = await processor2.process(makeSqsEvent(sesMessageId));

          // Both runs must produce the same batchItemFailures result
          expect(result1.batchItemFailures).toEqual(result2.batchItemFailures);

          // Both runs must call saveSignal (signal was persisted)
          expect(store1.saveSignal).toHaveBeenCalled();
          expect(store2.saveSignal).toHaveBeenCalled();

          // Both runs must call Aurora upsert
          expect(auroraWriter1.upsertEmbedding).toHaveBeenCalled();
          expect(auroraWriter2.upsertEmbedding).toHaveBeenCalled();
        },
      ),
    );
  });
});
