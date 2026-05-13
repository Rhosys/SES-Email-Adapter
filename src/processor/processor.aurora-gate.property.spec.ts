import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { okAsync, errAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
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
  const cluster = Object.freeze({
    clusterId: "cluster-a",
    clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-a",
    secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-a",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([cluster]),
    getActiveClusters: () => [cluster],
    getClusterById: (id: string) => (id === "cluster-a" ? cluster : null),
    getReadCluster: () => cluster,
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
