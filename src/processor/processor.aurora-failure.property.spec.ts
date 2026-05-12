import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { okAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher, Notifier } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Signal, Alias, AliasSender } from "../types/index.js";
import { propertyRunner } from "../testing/property-runner.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with two active clusters
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
// Property 8: Aurora cluster failure preserves the DynamoDB cache entry
// **Validates: Requirements 3.6**
// ---------------------------------------------------------------------------

/**
 * For any signal processed against a registry where the Aurora upsert fails for one cluster
 * after retries, the DynamoDB Signal record's `embeddings` map still contains that model's
 * vector. The cache is the recovery mechanism — a subsequent reindex restores the missing
 * Aurora row.
 */
describe("Property 8: Aurora cluster failure preserves the DynamoDB cache entry", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop8";

  const DEFAULT_EMAIL_CONFIG: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    filterMode: "quarantine_visible",
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

  it("DynamoDB signal embeddings map contains the failing cluster's model vector even when Aurora upsert throws", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        // Generate arbitrary vectors for two models
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        // Which cluster fails: 0 = cluster-a, 1 = cluster-b
        fc.integer({ min: 0, max: 1 }),
        // Arbitrary session message ID
        fc.constant("test-msg-aurora"),
        async (vectorA, vectorB, failingClusterIdx, sesMessageId) => {
          const store = makeStore();
          const mimeParser = makeMimeParser();
          const classifier = makeClassifier();
          const arcMatcher = makeArcMatcher();

          const failingClusterId = failingClusterIdx === 0 ? "cluster-a" : "cluster-b";

          // Embedding generator returns results for both models
          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 },
              { modelId: "amazon.titan-embed-text-v3:0", vector: vectorB, dimensions: 1536 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          // Aurora writer: throws for the failing cluster, succeeds for the other
          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockImplementation(async (opts: { clusterId: string }) => {
              if (opts.clusterId === failingClusterId) {
                throw new Error(`Aurora upsert failed for cluster ${failingClusterId} after retries`);
              }
            }),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser,
            classifier,
            embeddingGenerator,
            auroraWriter,
            arcMatcher,
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          await processor.process(makeSqsEvent(sesMessageId));

          // Verify saveSignal was called
          const saveSignalCalls = (store.saveSignal as ReturnType<typeof vi.fn>).mock.calls;
          expect(saveSignalCalls.length).toBeGreaterThanOrEqual(1);

          // Find the main signal save (not calendar synthetic signals)
          const savedSignal = saveSignalCalls[0]![0] as Signal;

          // The DynamoDB cache entry MUST contain BOTH models' vectors,
          // regardless of which Aurora cluster failed
          expect(savedSignal.embeddings).toBeDefined();
          expect(savedSignal.embeddings!["amazon.titan-embed-text-v2:0"]).toEqual(vectorA);
          expect(savedSignal.embeddings!["amazon.titan-embed-text-v3:0"]).toEqual(vectorB);
        },
      ),
    );
  });

  it("Aurora upsert is still attempted for the non-failing cluster", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.integer({ min: 0, max: 1 }),
        fc.constant("test-msg-aurora"),
        async (vectorA, vectorB, failingClusterIdx, sesMessageId) => {
          const store = makeStore();
          const mimeParser = makeMimeParser();
          const classifier = makeClassifier();
          const arcMatcher = makeArcMatcher();

          const failingClusterId = failingClusterIdx === 0 ? "cluster-a" : "cluster-b";
          const succeedingClusterId = failingClusterIdx === 0 ? "cluster-b" : "cluster-a";

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 },
              { modelId: "amazon.titan-embed-text-v3:0", vector: vectorB, dimensions: 1536 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockImplementation(async (opts: { clusterId: string }) => {
              if (opts.clusterId === failingClusterId) {
                throw new Error(`Aurora upsert failed for cluster ${failingClusterId}`);
              }
            }),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser,
            classifier,
            embeddingGenerator,
            auroraWriter,
            arcMatcher,
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          await processor.process(makeSqsEvent(sesMessageId));

          // Verify the Aurora writer was called for both clusters
          const upsertCalls = (auroraWriter.upsertEmbedding as ReturnType<typeof vi.fn>).mock.calls;
          expect(upsertCalls.length).toBe(2);

          // Verify the succeeding cluster received its upsert call
          const succeedingCall = upsertCalls.find(
            (call) => call[0].clusterId === succeedingClusterId,
          );
          expect(succeedingCall).toBeDefined();
        },
      ),
    );
  });
});
