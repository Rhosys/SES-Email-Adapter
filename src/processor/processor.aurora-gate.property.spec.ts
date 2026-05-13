import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { okAsync, errAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher, SqsDispatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Alias, AliasSender } from "../types/index.js";
import { dbError } from "../errors.js";
import { propertyRunner } from "../testing/property-runner.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with a single active cluster
// ---------------------------------------------------------------------------

vi.mock("../embedding/cluster-registry.js", () => {
  const clusterA = Object.freeze({
    clusterId: "cluster-a",
    clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-a",
    secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-a",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  const clusterB = Object.freeze({
    clusterId: "cluster-b",
    clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-b",
    secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-b",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v3:0",
    dimensions: 1536,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([clusterA, clusterB]),
    getActiveClusters: () => [clusterA, clusterB],
    getClusterById: (id: string) => {
      if (id === "cluster-a") return clusterA;
      if (id === "cluster-b") return clusterB;
      return null;
    },
    getReadCluster: () => clusterA,
  };
});

// ---------------------------------------------------------------------------
// Property 4: Arc saved before signal (leaf before dependent)
// **Validates: Requirements 2.3, 2.4**
// ---------------------------------------------------------------------------

/**
 * For any signal being processed on first attempt, the processor SHALL save the
 * arc to DDB before saving the signal. If the arc save fails, no signal save,
 * Aurora upsert, or side-effect SHALL execute, and the record SHALL be returned
 * as a batchItemFailure.
 */
describe("Feature: signal-processor-retry-resilience, Property 4: Arc saved before signal (leaf before dependent)", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop4";

  const DEFAULT_EMAIL_CONFIG: Alias = {
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
    emailConfig: DEFAULT_EMAIL_CONFIG,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  const validClassification: ClassificationOutput = {
    workflow: "conversation",
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.05,
    summary: "A test email.",
    labels: [],
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
  };

  function makeMimeParser(): MimeParser {
    return {
      parse: vi.fn().mockResolvedValue({
        from: { address: "sender@external.com", name: "Sender" },
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
    return {
      classify: vi.fn().mockResolvedValue({ ...validClassification }),
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

  it("saveArc is always called before saveSignal on first-attempt processing", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.uuid(),
        async (vector, sesMessageId) => {
          // Track call ordering
          const callOrder: string[] = [];

          const store: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockReturnValue(okAsync(null)),
            saveSignal: vi.fn().mockImplementation(() => {
              callOrder.push("saveSignal");
              return okAsync(undefined);
            }),
            updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
            getArc: vi.fn().mockReturnValue(okAsync(null)),
            findArcByGroupingKey: vi.fn().mockReturnValue(okAsync(null)),
            saveArc: vi.fn().mockImplementation(() => {
              callOrder.push("saveArc");
              return okAsync(undefined);
            }),
            listEnabledRules: vi.fn().mockReturnValue(okAsync(SYSTEM_RULES)),
            getProcessorAccountContext: vi.fn().mockReturnValue(okAsync(DEFAULT_CTX)),
            saveAlias: vi.fn().mockImplementation((a: Alias) => okAsync(a)),
            getSender: vi.fn().mockReturnValue(okAsync(DEFAULT_SENDER_ENTRY)),
            saveSender: vi.fn().mockReturnValue(okAsync(undefined)),
            getTemplate: vi.fn().mockReturnValue(okAsync(null)),
            updateGlobalReputation: vi.fn().mockReturnValue(okAsync(undefined)),
            getDomainByName: vi.fn().mockReturnValue(okAsync(null)),
          };

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 },
              { modelId: "amazon.titan-embed-text-v3:0", vector, dimensions: 1536 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator,
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          await processor.process(makeSqsEvent(sesMessageId));

          // Assert saveArc was called
          const saveArcIdx = callOrder.indexOf("saveArc");
          const saveSignalIdx = callOrder.indexOf("saveSignal");

          expect(saveArcIdx).toBeGreaterThanOrEqual(0);
          expect(saveSignalIdx).toBeGreaterThanOrEqual(0);
          // Arc must be saved before signal
          expect(saveArcIdx).toBeLessThan(saveSignalIdx);
        },
      ),
    );
  });

  it("when saveArc fails, saveSignal is never called and the record is a batchItemFailure", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.uuid(),
        async (vector, sesMessageId) => {
          let saveSignalCalled = false;

          const store: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockReturnValue(okAsync(null)),
            saveSignal: vi.fn().mockImplementation(() => {
              saveSignalCalled = true;
              return okAsync(undefined);
            }),
            updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
            getArc: vi.fn().mockReturnValue(okAsync(null)),
            findArcByGroupingKey: vi.fn().mockReturnValue(okAsync(null)),
            saveArc: vi.fn().mockReturnValue(errAsync(dbError(new Error("DDB write failed")))),
            listEnabledRules: vi.fn().mockReturnValue(okAsync(SYSTEM_RULES)),
            getProcessorAccountContext: vi.fn().mockReturnValue(okAsync(DEFAULT_CTX)),
            saveAlias: vi.fn().mockImplementation((a: Alias) => okAsync(a)),
            getSender: vi.fn().mockReturnValue(okAsync(DEFAULT_SENDER_ENTRY)),
            saveSender: vi.fn().mockReturnValue(okAsync(undefined)),
            getTemplate: vi.fn().mockReturnValue(okAsync(null)),
            updateGlobalReputation: vi.fn().mockReturnValue(okAsync(undefined)),
            getDomainByName: vi.fn().mockReturnValue(okAsync(null)),
          };

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 },
              { modelId: "amazon.titan-embed-text-v3:0", vector, dimensions: 1536 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator,
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          const result = await processor.process(makeSqsEvent(sesMessageId));

          // saveSignal must NOT have been called
          expect(saveSignalCalled).toBe(false);

          // Aurora upsert must NOT have been called
          expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();

          // The record must be returned as a batchItemFailure
          expect(result.batchItemFailures).toHaveLength(1);
          expect(result.batchItemFailures[0]!.itemIdentifier).toBe("sqs-1");
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Aurora failure returns batchItemFailure with appropriate log level
// **Validates: Requirements 3.1, 3.2**
// ---------------------------------------------------------------------------

/**
 * For any Aurora upsert failure, the processor SHALL return the record as a
 * batchItemFailure. The log level SHALL be ERROR when the failing cluster is
 * the primary cluster, and WARN when the failing cluster is a non-primary
 * cluster. Both log entries SHALL include the cluster identifier and error message.
 */
describe("Feature: signal-processor-retry-resilience, Property 6: Aurora failure returns batchItemFailure with appropriate log level", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop6";

  const DEFAULT_EMAIL_CONFIG: Alias = {
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
    emailConfig: DEFAULT_EMAIL_CONFIG,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  const validClassification: ClassificationOutput = {
    workflow: "conversation",
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.05,
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
        from: { address: "sender@external.com", name: "Sender" },
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
    return {
      classify: vi.fn().mockResolvedValue({ ...validClassification }),
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

  it("primary cluster failure logs at ERROR level with cluster ID and error message, and returns batchItemFailure", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.uuid(),
        async (vectorA, vectorB, sesMessageId) => {
          mockLogger.calls.length = 0;

          const store = makeStore();

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 },
              { modelId: "amazon.titan-embed-text-v3:0", vector: vectorB, dimensions: 1536 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          // Primary cluster (cluster-a) fails
          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockImplementation(async (opts: { clusterId: string }) => {
              if (opts.clusterId === "cluster-a") {
                throw new Error("Connection timeout on primary");
              }
            }),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator,
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          const result = await processor.process(makeSqsEvent(sesMessageId));

          // Must return batchItemFailure
          expect(result.batchItemFailures).toHaveLength(1);
          expect(result.batchItemFailures[0]!.itemIdentifier).toBe("sqs-1");

          // Must log at ERROR level for primary cluster failure
          const errorLogs = mockLogger.calls.filter((c) => c.method === "error");
          const auroraErrorLog = errorLogs.find((c) => c.context?.clusterId === "cluster-a");
          expect(auroraErrorLog).toBeDefined();
          expect(auroraErrorLog!.context!.clusterId).toBe("cluster-a");
          expect(auroraErrorLog!.context!.error).toBeDefined();
          expect(String(auroraErrorLog!.context!.error)).toContain("Connection timeout on primary");
        },
      ),
    );
  });

  it("non-primary cluster failure logs at WARN level with cluster ID and error message, and returns batchItemFailure", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.uuid(),
        async (vectorA, vectorB, sesMessageId) => {
          mockLogger.calls.length = 0;

          const store = makeStore();

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 },
              { modelId: "amazon.titan-embed-text-v3:0", vector: vectorB, dimensions: 1536 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          // Non-primary cluster (cluster-b) fails, primary succeeds
          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockImplementation(async (opts: { clusterId: string }) => {
              if (opts.clusterId === "cluster-b") {
                throw new Error("Throttled on secondary");
              }
            }),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator,
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          const result = await processor.process(makeSqsEvent(sesMessageId));

          // Must return batchItemFailure
          expect(result.batchItemFailures).toHaveLength(1);
          expect(result.batchItemFailures[0]!.itemIdentifier).toBe("sqs-1");

          // Must log at WARN level (not ERROR) for non-primary cluster failure
          const warnLogs = mockLogger.calls.filter((c) => c.method === "warn");
          const auroraWarnLog = warnLogs.find((c) => c.context?.clusterId === "cluster-b");
          expect(auroraWarnLog).toBeDefined();
          expect(auroraWarnLog!.context!.clusterId).toBe("cluster-b");
          expect(auroraWarnLog!.context!.error).toBeDefined();
          expect(String(auroraWarnLog!.context!.error)).toContain("Throttled on secondary");

          // Must NOT log at ERROR level for this failure (it's non-primary)
          const errorLogs = mockLogger.calls.filter((c) => c.method === "error");
          const auroraErrorLog = errorLogs.find((c) => c.context?.clusterId === "cluster-b");
          expect(auroraErrorLog).toBeUndefined();
        },
      ),
    );
  });
});


// ---------------------------------------------------------------------------
// Property 5: Side-effects dispatch if and only if all Aurora upserts succeed
// **Validates: Requirements 2.1, 2.2, 3.3, 4.2, 4.3**
// ---------------------------------------------------------------------------

/**
 * For any signal with side-effects indicated by its outcome, the side-effect SQS
 * message SHALL be dispatched only after all active Aurora cluster upserts succeed.
 * If any Aurora upsert fails, no side-effect message SHALL be dispatched for that record.
 */
describe("Feature: signal-processor-retry-resilience, Property 5: Side-effects dispatch iff all Aurora upserts succeed", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop5";

  const DEFAULT_EMAIL_CONFIG: Alias = {
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
    emailConfig: DEFAULT_EMAIL_CONFIG,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  const validClassification: ClassificationOutput = {
    workflow: "conversation",
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.05,
    summary: "A test email.",
    labels: [],
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
  };

  function makeMimeParser(): MimeParser {
    return {
      parse: vi.fn().mockResolvedValue({
        from: { address: "sender@external.com", name: "Sender" },
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
    return {
      classify: vi.fn().mockResolvedValue({ ...validClassification }),
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

  it("when all Aurora upserts succeed, sqsDispatcher.sendMessage is called", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.uuid(),
        async (vector, sesMessageId) => {
          const store = makeStore();

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const sqsDispatcher: SqsDispatcher = {
            sendMessage: vi.fn().mockReturnValue(okAsync(undefined)),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator,
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
            sqsDispatcher,
          });

          const result = await processor.process(makeSqsEvent(sesMessageId));

          // No batch item failures — processing succeeded
          expect(result.batchItemFailures).toHaveLength(0);

          // sqsDispatcher.sendMessage must have been called
          expect(sqsDispatcher.sendMessage).toHaveBeenCalled();

          // Verify the payload contains signal and arc
          const call = (sqsDispatcher.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
          const payload = call[0] as { signal: unknown; arc: unknown };
          expect(payload.signal).toBeDefined();
          expect(payload.arc).toBeDefined();
        },
      ),
    );
  });

  it("when any Aurora upsert fails, sqsDispatcher.sendMessage is NOT called and record is a batchItemFailure", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.uuid(),
        async (vector, sesMessageId) => {
          const store = makeStore();

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockRejectedValue(new Error("Aurora cluster unavailable")),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const sqsDispatcher: SqsDispatcher = {
            sendMessage: vi.fn().mockReturnValue(okAsync(undefined)),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator,
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
            sqsDispatcher,
          });

          const result = await processor.process(makeSqsEvent(sesMessageId));

          // sqsDispatcher.sendMessage must NOT have been called
          expect(sqsDispatcher.sendMessage).not.toHaveBeenCalled();

          // The record must be returned as a batchItemFailure
          expect(result.batchItemFailures).toHaveLength(1);
          expect(result.batchItemFailures[0]!.itemIdentifier).toBe("sqs-1");
        },
      ),
    );
  });
});


// ---------------------------------------------------------------------------
// Property 7: Partial Aurora success preserves primary write
// **Validates: Requirements 3.4**
// ---------------------------------------------------------------------------

/**
 * For any signal where the primary cluster upsert succeeds but a non-primary
 * cluster upsert fails, the primary cluster's write SHALL NOT be rolled back.
 * The record SHALL be returned as a batchItemFailure so that the retry re-runs
 * all upserts (idempotent) until all clusters succeed.
 */
describe("Feature: signal-processor-retry-resilience, Property 7: Partial Aurora success preserves primary write", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop7";

  const DEFAULT_EMAIL_CONFIG: Alias = {
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
    emailConfig: DEFAULT_EMAIL_CONFIG,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  const validClassification: ClassificationOutput = {
    workflow: "conversation",
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.05,
    summary: "A test email.",
    labels: [],
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
  };

  function makeMimeParser(): MimeParser {
    return {
      parse: vi.fn().mockResolvedValue({
        from: { address: "sender@external.com", name: "Sender" },
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
    return {
      classify: vi.fn().mockResolvedValue({ ...validClassification }),
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

  it("primary cluster write is preserved when non-primary cluster fails, record returned as batchItemFailure, no side-effects dispatched", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.uuid(),
        async (vector, sesMessageId) => {
          // Track which clusters had their upsert called and completed
          const completedUpserts: string[] = [];

          const store: ProcessorDatabase = {
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

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 },
              { modelId: "amazon.titan-embed-text-v3:0", vector, dimensions: 1536 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          // Primary cluster (cluster-a) succeeds, non-primary (cluster-b) fails
          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockImplementation((opts: { clusterId: string }) => {
              if (opts.clusterId === "cluster-a") {
                completedUpserts.push("cluster-a");
                return Promise.resolve(undefined);
              }
              // Non-primary cluster fails
              return Promise.reject(new Error("Aurora cluster-b connection timeout"));
            }),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          // Mock SQS dispatcher to track side-effect dispatch attempts
          const sqsDispatcher: SqsDispatcher = {
            sendMessage: vi.fn().mockReturnValue(okAsync(undefined)),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator,
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
            sqsDispatcher,
          });

          const result = await processor.process(makeSqsEvent(sesMessageId));

          // 1. Primary cluster's upsert was called and completed (not rolled back)
          expect(completedUpserts).toContain("cluster-a");

          // 2. Record IS returned as a batchItemFailure (because non-primary failed)
          expect(result.batchItemFailures).toHaveLength(1);
          expect(result.batchItemFailures[0]!.itemIdentifier).toBe("sqs-1");

          // 3. No side-effects are dispatched (Aurora failure gates side-effect dispatch)
          expect(sqsDispatcher.sendMessage).not.toHaveBeenCalled();
        },
      ),
    );
  });
});
