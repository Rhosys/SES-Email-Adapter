import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { okAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier } from "../classifier/classifier.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Signal, Arc, Alias, AliasSender, Workflow } from "../types/index.js";
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
  // Arbitraries
  // -------------------------------------------------------------------------

  const WORKFLOWS: Workflow[] = [
    "auth", "conversation", "crm", "package", "travel", "scheduling",
    "payments", "alert", "content", "onboarding", "status", "healthcare",
    "job", "support", "test",
  ];

  const arbWorkflow = fc.constantFrom(...WORKFLOWS);

  const arbEmbedding = fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 10 });

  /** Generate a valid Signal that would exist in DDB on retry */
  const arbSignal = fc.record({
    id: fc.uuid().map((id) => `SES#${id}`),
    arcId: fc.uuid(),
    accountId: fc.constant(TEST_ACCOUNT_ID),
    source: fc.constant("email" as const),
    receivedAt: fc.constant("2024-01-15T10:00:00Z"),
    from: fc.record({ address: fc.emailAddress(), name: fc.string({ minLength: 1, maxLength: 20 }) }),
    to: fc.constant([{ address: "user@example.com" }]),
    cc: fc.constant([]),
    subject: fc.string({ minLength: 1, maxLength: 50 }),
    textBody: fc.string({ minLength: 1, maxLength: 100 }),
    attachments: fc.constant([]),
    headers: fc.constant({}),
    recipientAddress: fc.constant("user@example.com"),
    workflow: arbWorkflow,
    workflowData: fc.constant({ workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const),
    spamScore: fc.double({ min: 0, max: 1, noNaN: true }),
    summary: fc.string({ minLength: 1, maxLength: 50 }),
    classificationModelId: fc.constant("us.anthropic.claude-opus-4-5-20251101-v1:0"),
    s3Key: fc.uuid().map((id) => `emails/${id}`),
    status: fc.constant("active" as const),
    createdAt: fc.constant("2024-01-15T10:00:00Z"),
    embeddings: arbEmbedding.map((vec) => ({ "amazon.titan-embed-text-v2:0": vec })),
    matchedRules: fc.constant([]),
  }) as fc.Arbitrary<Signal>;

  /** Generate an Arc that matches the signal's arcId */
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

  /** Receive count > 1 (retry) */
  const arbReceiveCount = fc.integer({ min: 2, max: 10 });

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
  // Tests
  // -------------------------------------------------------------------------

  it("MIME parser is NOT called on retry when signal exists in DDB", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        arbSignal,
        arbReceiveCount,
        async (signal, receiveCount) => {
          const arc = arbArcForSignal(signal);
          const sesMessageId = signal.id.replace("SES#", "");

          const mimeParser: MimeParser = { parse: vi.fn() };

          const store: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockReturnValue(okAsync(signal)),
            saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
            updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
            getArc: vi.fn().mockReturnValue(okAsync(arc)),
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

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser,
            classifier: { classify: vi.fn() },
            embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
            auroraWriter,
            arcMatcher: { findMatch: vi.fn().mockReturnValue(okAsync(null)), upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)) },
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          await processor.process(makeSqsEvent(sesMessageId, receiveCount));

          // MIME parser must NOT be called — no re-parsing on retry
          expect(mimeParser.parse).not.toHaveBeenCalled();
        },
      ),
    );
  });

  it("classifier is NOT called on retry when signal exists in DDB", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        arbSignal,
        arbReceiveCount,
        async (signal, receiveCount) => {
          const arc = arbArcForSignal(signal);
          const sesMessageId = signal.id.replace("SES#", "");

          const classifier: Pick<SignalClassifier, "classify"> = { classify: vi.fn() };

          const store: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockReturnValue(okAsync(signal)),
            saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
            updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
            getArc: vi.fn().mockReturnValue(okAsync(arc)),
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

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: { parse: vi.fn() },
            classifier,
            embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
            auroraWriter,
            arcMatcher: { findMatch: vi.fn().mockReturnValue(okAsync(null)), upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)) },
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          await processor.process(makeSqsEvent(sesMessageId, receiveCount));

          // Classifier must NOT be called — no re-classifying on retry
          expect(classifier.classify).not.toHaveBeenCalled();
        },
      ),
    );
  });

  it("rule evaluation is NOT called on retry when signal exists in DDB", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        arbSignal,
        arbReceiveCount,
        async (signal, receiveCount) => {
          const arc = arbArcForSignal(signal);
          const sesMessageId = signal.id.replace("SES#", "");

          const ruleEvaluator = new JsonLogicRuleEvaluator(mockLogger);
          const evaluateSpy = vi.spyOn(ruleEvaluator, "evaluate");

          const store: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockReturnValue(okAsync(signal)),
            saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
            updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
            getArc: vi.fn().mockReturnValue(okAsync(arc)),
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

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: { parse: vi.fn() },
            classifier: { classify: vi.fn() },
            embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
            auroraWriter,
            arcMatcher: { findMatch: vi.fn().mockReturnValue(okAsync(null)), upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)) },
            ruleEvaluator,
            logger: mockLogger,
          });

          await processor.process(makeSqsEvent(sesMessageId, receiveCount));

          // Rule evaluator must NOT be called — no re-evaluating rules on retry
          expect(evaluateSpy).not.toHaveBeenCalled();
        },
      ),
    );
  });

  it("Aurora upserts ARE called with the signal's cached embeddings on retry", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        arbSignal,
        arbReceiveCount,
        async (signal, receiveCount) => {
          const arc = arbArcForSignal(signal);
          const sesMessageId = signal.id.replace("SES#", "");

          const store: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockReturnValue(okAsync(signal)),
            saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
            updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
            getArc: vi.fn().mockReturnValue(okAsync(arc)),
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

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: { parse: vi.fn() },
            classifier: { classify: vi.fn() },
            embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
            auroraWriter,
            arcMatcher: { findMatch: vi.fn().mockReturnValue(okAsync(null)), upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)) },
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          await processor.process(makeSqsEvent(sesMessageId, receiveCount));

          // Aurora upsert must be called with the cached embedding from the signal
          expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();
          const call = vi.mocked(auroraWriter.upsertEmbedding).mock.calls[0]!;
          expect(call[0]).toMatchObject({
            arcId: arc.id,
            accountId: signal.accountId,
            embedding: signal.embeddings!["amazon.titan-embed-text-v2:0"],
          });
        },
      ),
    );
  });

  it("result is NOT a batchItemFailure on retry when signal exists in DDB", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        arbSignal,
        arbReceiveCount,
        async (signal, receiveCount) => {
          const arc = arbArcForSignal(signal);
          const sesMessageId = signal.id.replace("SES#", "");

          const store: ProcessorDatabase = {
            getSignalByMessageId: vi.fn().mockReturnValue(okAsync(signal)),
            saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
            updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
            getArc: vi.fn().mockReturnValue(okAsync(arc)),
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

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser: { parse: vi.fn() },
            classifier: { classify: vi.fn() },
            embeddingGenerator: { generateForActiveClusters: vi.fn(), generateForModel: vi.fn() },
            auroraWriter,
            arcMatcher: { findMatch: vi.fn().mockReturnValue(okAsync(null)), upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)) },
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          const result = await processor.process(makeSqsEvent(sesMessageId, receiveCount));

          // Processing must succeed — no batchItemFailures
          expect(result.batchItemFailures).toEqual([]);
        },
      ),
    );
  });
});
