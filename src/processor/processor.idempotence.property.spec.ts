import { describe, it, expect, vi } from "vitest";
import type { SQSEvent } from "aws-lambda";
import { ok, okAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Signal, Alias, AliasSender } from "../types/index.js";
import { createMockLogger } from "../testing/mock-logger.js";

vi.mock("../embedding/cluster-registry.js", () => {
  const cluster = Object.freeze({
    clusterId: "cluster-a",
    clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a",
    secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a",
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

describe("Cross-layer idempotence — live writes + cache + Aurora", () => {
  const TEST_ACCOUNT_ID = "acct-idem";
  const VECTOR = [0.1, -0.5, 0.3, 0.8, -0.2];

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
    return { classify: vi.fn().mockResolvedValue({ ...validClassification }) };
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
      mail: { messageId: sesMessageId, timestamp: "2024-01-15T10:00:00Z", destination: ["user@example.com"] },
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
        attributes: { ApproximateReceiveCount: "1", SentTimestamp: "1234567890", SenderId: "sender", ApproximateFirstReceiveTimestamp: "1234567890" },
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123:queue",
        awsRegion: "us-east-1",
      }],
    };
  }

  it("dedup path: second processing of same messageId is a no-op", async () => {
    const store: ProcessorDatabase = {
      getSignalByMessageId: vi.fn()
        .mockReturnValueOnce(okAsync(null))
        .mockReturnValueOnce(okAsync({ id: "SES#test-msg-001" })),
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
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: VECTOR, dimensions: 1024 }),
      ]),
      generateForModel: vi.fn().mockResolvedValue(
        { modelId: "amazon.titan-embed-text-v2:0", vector: VECTOR, dimensions: 1024 } as EmbeddingResult,
      ),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(undefined),
      findMatch: vi.fn().mockResolvedValue(null),
    };

    const mockLogger = createMockLogger();
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

    const event = makeSqsEvent("test-msg-001");
    await processor.process(event);
    await processor.process(event);

    expect(store.getSignalByMessageId).toHaveBeenCalledTimes(2);
    expect(store.saveSignal).toHaveBeenCalledTimes(1);
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalledTimes(1);
    expect(embeddingGenerator.generateForActiveClusters).toHaveBeenCalledTimes(1);
  });

  it("race condition: both runs produce identical embeddings and Aurora upsert params", async () => {
    const savedSignals: Signal[] = [];
    const store: ProcessorDatabase = {
      getSignalByMessageId: vi.fn().mockReturnValue(okAsync(null)),
      saveSignal: vi.fn().mockImplementation((signal: Signal) => {
        savedSignals.push(signal);
        return okAsync(undefined);
      }),
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
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: VECTOR, dimensions: 1024 }),
      ]),
      generateForModel: vi.fn().mockResolvedValue(
        { modelId: "amazon.titan-embed-text-v2:0", vector: VECTOR, dimensions: 1024 } as EmbeddingResult,
      ),
    };

    const auroraUpsertCalls: Array<{ clusterId: string; accountId: string; recipientAddress: string; embedding: number[] }> = [];
    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockImplementation(async (opts) => { auroraUpsertCalls.push(opts); }),
      findMatch: vi.fn().mockResolvedValue(null),
    };

    const mockLogger = createMockLogger();
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

    const event = makeSqsEvent("test-msg-001");
    await processor.process(event);
    await processor.process(event);

    expect(savedSignals.length).toBe(2);
    expect(savedSignals[0]!.embeddings).toEqual(savedSignals[1]!.embeddings);
    expect(savedSignals[0]!.embeddings!["amazon.titan-embed-text-v2:0"]).toEqual(VECTOR);

    expect(auroraUpsertCalls.length).toBe(2);
    expect(auroraUpsertCalls[0]!.clusterId).toBe(auroraUpsertCalls[1]!.clusterId);
    expect(auroraUpsertCalls[0]!.accountId).toBe(auroraUpsertCalls[1]!.accountId);
    expect(auroraUpsertCalls[0]!.recipientAddress).toBe(auroraUpsertCalls[1]!.recipientAddress);
    expect(auroraUpsertCalls[0]!.embedding).toEqual(auroraUpsertCalls[1]!.embedding);
  });
});
