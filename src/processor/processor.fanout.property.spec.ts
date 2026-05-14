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

// Use vi.hoisted to create mutable state that the hoisted vi.mock can reference
const mockState = vi.hoisted(() => ({
  clusters: [
    {
      clusterId: "cluster-default",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-default",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-default",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    },
  ] as Array<{
    clusterId: string;
    clusterArn: string;
    secretArn: string;
    databaseName: string;
    modelId: string;
    dimensions: number;
    active: boolean;
  }>,
}));

vi.mock("../embedding/cluster-registry.js", () => ({
  get CLUSTER_REGISTRY() {
    return Object.freeze(mockState.clusters);
  },
  getActiveClusters: () => mockState.clusters.filter((c) => c.active),
  getClusterById: (id: string) => mockState.clusters.find((c) => c.clusterId === id) ?? null,
  getReadCluster: () => mockState.clusters.find((c) => c.active) ?? mockState.clusters[0],
}));

describe("Multi-cluster fanout writes vectors to every active target", () => {
  const TEST_ACCOUNT_ID = "acct-prop6";

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
        action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
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

  const clusterConfigs = [
    {
      label: "single cluster",
      clusters: [
        { clusterId: "cluster-alpha-0", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-alpha-0", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-alpha-0", databaseName: "signals", modelId: "model-alpha", dimensions: 512, active: true },
      ],
    },
    {
      label: "two clusters with different dimensions",
      clusters: [
        { clusterId: "cluster-alpha-0", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-alpha-0", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-alpha-0", databaseName: "signals", modelId: "model-alpha", dimensions: 512, active: true },
        { clusterId: "cluster-beta-1", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-beta-1", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-beta-1", databaseName: "signals", modelId: "model-beta", dimensions: 1024, active: true },
      ],
    },
    {
      label: "three clusters",
      clusters: [
        { clusterId: "cluster-alpha-0", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-alpha-0", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-alpha-0", databaseName: "signals", modelId: "model-alpha", dimensions: 256, active: true },
        { clusterId: "cluster-beta-1", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-beta-1", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-beta-1", databaseName: "signals", modelId: "model-beta", dimensions: 512, active: true },
        { clusterId: "cluster-gamma-2", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-gamma-2", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-gamma-2", databaseName: "signals", modelId: "model-gamma", dimensions: 1024, active: true },
      ],
    },
  ];

  it.each(clusterConfigs)("$label — DynamoDB embeddings map has one entry per active cluster", async ({ clusters }) => {
    mockState.clusters = clusters;

    const store = makeStore();
    const embeddingResults: EmbeddingResult[] = clusters.map((cluster) => ({
      modelId: cluster.modelId,
      vector: Array.from({ length: cluster.dimensions }, (_, i) => (i + 1) / cluster.dimensions),
      dimensions: cluster.dimensions,
    }));

    const embeddingGenerator: EmbeddingGenerator = {
      generateForActiveClusters: vi.fn().mockResolvedValue(embeddingResults.map((r) => ok(r))),
      generateForModel: vi.fn().mockImplementation(async (_: string, modelId: string) => {
        const result = embeddingResults.find((r) => r.modelId === modelId);
        if (!result) throw new Error(`Model ${modelId} not found`);
        return result;
      }),
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

    await processor.process(makeSqsEvent("ses-fanout-test"));

    const saveSignalCalls = (store.saveSignal as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveSignalCalls.length).toBeGreaterThanOrEqual(1);
    const savedSignal = saveSignalCalls[0]![0] as Signal;

    expect(savedSignal.embeddings).toBeDefined();
    expect(Object.keys(savedSignal.embeddings!)).toHaveLength(clusters.length);
    for (const cluster of clusters) {
      expect(savedSignal.embeddings![cluster.modelId]).toBeDefined();
      expect(savedSignal.embeddings![cluster.modelId]).toHaveLength(cluster.dimensions);
    }
  });

  it.each(clusterConfigs)("$label — each Aurora cluster receives exactly one upsert", async ({ clusters }) => {
    mockState.clusters = clusters;

    const store = makeStore();
    const embeddingResults: EmbeddingResult[] = clusters.map((cluster) => ({
      modelId: cluster.modelId,
      vector: Array.from({ length: cluster.dimensions }, (_, i) => (i + 1) / cluster.dimensions),
      dimensions: cluster.dimensions,
    }));

    const embeddingGenerator: EmbeddingGenerator = {
      generateForActiveClusters: vi.fn().mockResolvedValue(embeddingResults.map((r) => ok(r))),
      generateForModel: vi.fn().mockImplementation(async (_: string, modelId: string) => {
        const result = embeddingResults.find((r) => r.modelId === modelId);
        if (!result) throw new Error(`Model ${modelId} not found`);
        return result;
      }),
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

    await processor.process(makeSqsEvent("ses-fanout-test"));

    const upsertCalls = (auroraWriter.upsertEmbedding as ReturnType<typeof vi.fn>).mock.calls;
    expect(upsertCalls).toHaveLength(clusters.length);

    for (const cluster of clusters) {
      const matchingCall = upsertCalls.find(
        (call: Array<{ clusterId: string }>) => call[0]?.clusterId === cluster.clusterId,
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![0].accountId).toBe(TEST_ACCOUNT_ID);
      expect(matchingCall![0].recipientAddress).toBe("user@example.com");
    }
  });

  it.each(clusterConfigs)("$label — embeddings map keys match cluster modelIds exactly", async ({ clusters }) => {
    mockState.clusters = clusters;

    const store = makeStore();
    const embeddingResults: EmbeddingResult[] = clusters.map((cluster) => ({
      modelId: cluster.modelId,
      vector: new Array(cluster.dimensions).fill(0.1),
      dimensions: cluster.dimensions,
    }));

    const embeddingGenerator: EmbeddingGenerator = {
      generateForActiveClusters: vi.fn().mockResolvedValue(embeddingResults.map((r) => ok(r))),
      generateForModel: vi.fn().mockResolvedValue(embeddingResults[0]!),
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

    await processor.process(makeSqsEvent("ses-fanout-test"));

    const saveSignalCalls = (store.saveSignal as ReturnType<typeof vi.fn>).mock.calls;
    const savedSignal = saveSignalCalls[0]![0] as Signal;

    const embeddingsKeys = Object.keys(savedSignal.embeddings!).sort();
    const expectedKeys = clusters.map((c) => c.modelId).sort();
    expect(embeddingsKeys).toEqual(expectedKeys);
  });
});
