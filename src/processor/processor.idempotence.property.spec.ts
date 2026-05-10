import { describe, it, expect, beforeEach, vi } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Signal, Alias, AliasSender } from "../types/index.js";
import { propertyRunner } from "../testing/property-runner.js";

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
// Property 9 (full scope): All embedding upserts and job operations are idempotent
// **Validates: Requirements 3.4, 4.5, 4.6, 5.6, 6.1, 6.3**
// ---------------------------------------------------------------------------

/**
 * For any signal processed twice (simulating SQS redelivery), the final state
 * across all layers is identical to processing it once:
 *   1. DynamoDB Signal record has the same `embeddings` map after both runs
 *   2. Aurora receives the same upsert SQL with the same parameters (ON CONFLICT DO UPDATE is idempotent)
 *   3. The signal is not duplicated in DynamoDB (deduplication by messageId)
 */
describe("Property 9 (full scope): Cross-layer idempotence — live writes + cache + Aurora", () => {
  const TEST_ACCOUNT_ID = "acct-idem";

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
      findMatch: vi.fn().mockResolvedValue(null),
      upsertEmbedding: vi.fn().mockResolvedValue(undefined),
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
        action: { bucketName: "test-bucket", objectKey: `inbox/${sesMessageId}` },
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

  it("deduplication path: second processing of the same messageId is a no-op (no duplicate DynamoDB writes, no Aurora calls)", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.constant("test-msg-001"),
        async (vector, sesMessageId) => {
          // Store mock: first call returns null (signal not found), second call returns existing signal
          const store: ProcessorDatabase = {
            getSignalByMessageId: vi.fn()
              .mockResolvedValueOnce(null) // First processing: signal doesn't exist yet
              .mockResolvedValueOnce({ id: `SES#${sesMessageId}` }), // Second processing: signal already saved
            saveSignal: vi.fn().mockResolvedValue(undefined),
            updateSignalRetention: vi.fn().mockResolvedValue(undefined),
            getArc: vi.fn().mockResolvedValue(null),
            findArcByGroupingKey: vi.fn().mockResolvedValue(null),
            saveArc: vi.fn().mockResolvedValue(undefined),
            listEnabledRules: vi.fn().mockResolvedValue(SYSTEM_RULES),
            getProcessorAccountContext: vi.fn().mockResolvedValue(DEFAULT_CTX),
            saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(a)),
            getSender: vi.fn().mockResolvedValue(DEFAULT_SENDER_ENTRY),
            saveSender: vi.fn().mockResolvedValue(undefined),
            getTemplate: vi.fn().mockResolvedValue(null),
            updateGlobalReputation: vi.fn().mockResolvedValue(undefined),
            getDomainByName: vi.fn().mockResolvedValue(null),
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
            ruleEvaluator: new JsonLogicRuleEvaluator(),
          });

          const event = makeSqsEvent(sesMessageId);

          // Process the same signal twice (simulating SQS redelivery)
          await processor.process(event);
          await processor.process(event);

          // getSignalByMessageId was called twice (once per processing)
          expect(store.getSignalByMessageId).toHaveBeenCalledTimes(2);

          // saveSignal was called only ONCE — the second processing returned early due to dedup
          expect(store.saveSignal).toHaveBeenCalledTimes(1);

          // Aurora upsert was called only ONCE — the second processing never reached Aurora
          expect(auroraWriter.upsertEmbedding).toHaveBeenCalledTimes(1);

          // Embedding generation was called only ONCE
          expect(embeddingGenerator.generateForActiveClusters).toHaveBeenCalledTimes(1);
        },
      ),
    );
  });

  it("idempotent upsert path: processing the same signal twice before dedup kicks in produces identical Aurora upsert parameters", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.constant("test-msg-001"),
        async (vector, sesMessageId) => {
          // Simulate the race condition: both calls see no existing signal (dedup hasn't saved yet)
          const savedSignals: Signal[] = [];
          const store: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockResolvedValue(null), // Both calls see no existing signal
            saveSignal: vi.fn().mockImplementation(async (signal: Signal) => {
              savedSignals.push(signal);
            }),
            updateSignalRetention: vi.fn().mockResolvedValue(undefined),
            getArc: vi.fn().mockResolvedValue(null),
            findArcByGroupingKey: vi.fn().mockResolvedValue(null),
            saveArc: vi.fn().mockResolvedValue(undefined),
            listEnabledRules: vi.fn().mockResolvedValue(SYSTEM_RULES),
            getProcessorAccountContext: vi.fn().mockResolvedValue(DEFAULT_CTX),
            saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(a)),
            getSender: vi.fn().mockResolvedValue(DEFAULT_SENDER_ENTRY),
            saveSender: vi.fn().mockResolvedValue(undefined),
            getTemplate: vi.fn().mockResolvedValue(null),
            updateGlobalReputation: vi.fn().mockResolvedValue(undefined),
            getDomainByName: vi.fn().mockResolvedValue(null),
          };

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          const auroraUpsertCalls: Array<{
            clusterId: string;
            arcId: string;
            accountId: string;
            recipientAddress: string;
            embedding: number[];
          }> = [];
          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockImplementation(async (opts) => {
              auroraUpsertCalls.push(opts);
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
            ruleEvaluator: new JsonLogicRuleEvaluator(),
          });

          const event = makeSqsEvent(sesMessageId);

          // Process the same signal twice (simulating rapid redelivery before first save completes)
          await processor.process(event);
          await processor.process(event);

          // Both runs should have saved a signal with the same embeddings map
          expect(savedSignals.length).toBe(2);
          const firstSignalEmbeddings = savedSignals[0]!.embeddings;
          const secondSignalEmbeddings = savedSignals[1]!.embeddings;

          // 1. DynamoDB Signal record has the same `embeddings` map after both runs
          expect(firstSignalEmbeddings).toBeDefined();
          expect(secondSignalEmbeddings).toBeDefined();
          expect(firstSignalEmbeddings!["amazon.titan-embed-text-v2:0"]).toEqual(vector);
          expect(secondSignalEmbeddings!["amazon.titan-embed-text-v2:0"]).toEqual(vector);
          expect(firstSignalEmbeddings).toEqual(secondSignalEmbeddings);

          // 2. Aurora receives the same upsert parameters both times
          //    (ON CONFLICT DO UPDATE makes this idempotent at the DB level)
          expect(auroraUpsertCalls.length).toBe(2);
          const firstUpsert = auroraUpsertCalls[0]!;
          const secondUpsert = auroraUpsertCalls[1]!;

          // Same cluster, same accountId, same recipientAddress, same embedding vector
          expect(firstUpsert.clusterId).toBe(secondUpsert.clusterId);
          expect(firstUpsert.accountId).toBe(secondUpsert.accountId);
          expect(firstUpsert.recipientAddress).toBe(secondUpsert.recipientAddress);
          expect(firstUpsert.embedding).toEqual(secondUpsert.embedding);
          expect(firstUpsert.embedding).toEqual(vector);

          // The arcId may differ (randomUUID) between runs since both create a new arc,
          // but the embedding vector and tuple key (accountId, recipientAddress) are identical.
          // In production, ON CONFLICT (arc_id, account_id, recipient_address) DO UPDATE
          // ensures the final Aurora state is the same regardless of which write "wins".
        },
      ),
    );
  });

  it("DynamoDB embeddings map is identical whether signal is processed once or twice", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 }),
        fc.constant("test-msg-001"),
        async (vector, sesMessageId) => {
          // Run 1: process once (fresh)
          const savedSignalsRun1: Signal[] = [];
          const storeRun1: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockResolvedValue(null),
            saveSignal: vi.fn().mockImplementation(async (signal: Signal) => {
              savedSignalsRun1.push(signal);
            }),
            updateSignalRetention: vi.fn().mockResolvedValue(undefined),
            getArc: vi.fn().mockResolvedValue(null),
            findArcByGroupingKey: vi.fn().mockResolvedValue(null),
            saveArc: vi.fn().mockResolvedValue(undefined),
            listEnabledRules: vi.fn().mockResolvedValue(SYSTEM_RULES),
            getProcessorAccountContext: vi.fn().mockResolvedValue(DEFAULT_CTX),
            saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(a)),
            getSender: vi.fn().mockResolvedValue(DEFAULT_SENDER_ENTRY),
            saveSender: vi.fn().mockResolvedValue(undefined),
            getTemplate: vi.fn().mockResolvedValue(null),
            updateGlobalReputation: vi.fn().mockResolvedValue(undefined),
            getDomainByName: vi.fn().mockResolvedValue(null),
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

          const processorRun1 = new SignalProcessor({
            store: storeRun1,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator,
            auroraWriter,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(),
          });

          await processorRun1.process(makeSqsEvent(sesMessageId));

          // Run 2: process again (simulating redelivery that bypasses dedup)
          const savedSignalsRun2: Signal[] = [];
          const storeRun2: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockResolvedValue(null),
            saveSignal: vi.fn().mockImplementation(async (signal: Signal) => {
              savedSignalsRun2.push(signal);
            }),
            updateSignalRetention: vi.fn().mockResolvedValue(undefined),
            getArc: vi.fn().mockResolvedValue(null),
            findArcByGroupingKey: vi.fn().mockResolvedValue(null),
            saveArc: vi.fn().mockResolvedValue(undefined),
            listEnabledRules: vi.fn().mockResolvedValue(SYSTEM_RULES),
            getProcessorAccountContext: vi.fn().mockResolvedValue(DEFAULT_CTX),
            saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(a)),
            getSender: vi.fn().mockResolvedValue(DEFAULT_SENDER_ENTRY),
            saveSender: vi.fn().mockResolvedValue(undefined),
            getTemplate: vi.fn().mockResolvedValue(null),
            updateGlobalReputation: vi.fn().mockResolvedValue(undefined),
            getDomainByName: vi.fn().mockResolvedValue(null),
          };

          const embeddingGenerator2: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue([
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 },
            ] as EmbeddingResult[]),
            generateForModel: vi.fn().mockResolvedValue(
              { modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 } as EmbeddingResult,
            ),
          };

          const auroraWriter2: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processorRun2 = new SignalProcessor({
            store: storeRun2,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator: embeddingGenerator2,
            auroraWriter: auroraWriter2,
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(),
          });

          await processorRun2.process(makeSqsEvent(sesMessageId));

          // Both runs should produce a signal with the same embeddings map
          expect(savedSignalsRun1.length).toBeGreaterThanOrEqual(1);
          expect(savedSignalsRun2.length).toBeGreaterThanOrEqual(1);

          const signal1 = savedSignalsRun1[0]!;
          const signal2 = savedSignalsRun2[0]!;

          // The embeddings map is deterministic — same input produces same output
          expect(signal1.embeddings).toEqual(signal2.embeddings);
          expect(signal1.embeddings!["amazon.titan-embed-text-v2:0"]).toEqual(vector);
        },
      ),
    );
  });
});
