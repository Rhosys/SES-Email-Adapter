import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok, err, dbError } from "../errors.js";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import type { InboundSignalMessage } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Signal, Alias, AliasSender } from "../types/index.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

vi.mock("../embedding/cluster-registry.js", () => {
  const clusterA = Object.freeze({
    registryId: "cluster-a",
    clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a",
    secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  const clusterB = Object.freeze({
    registryId: "cluster-b",
    clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-b",
    secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-b",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v3:0",
    dimensions: 1536,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([clusterA, clusterB]),
    getActiveClusters: () => [clusterA, clusterB],
    getRegistryById: (id: string) => {
      if (id === "cluster-a") return clusterA;
      if (id === "cluster-b") return clusterB;
      return null;
    },
    getPrimaryArcMatcherRegistry: () => clusterA,
    getSecondaryClusters: () => [clusterB],
  };
});

describe("Aurora cluster failure preserves the DynamoDB cache entry", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop8";
  const VECTOR_A = [0.1, -0.5, 0.3];
  const VECTOR_B = [0.7, 0.2, -0.9];

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
      parse: vi.fn().mockResolvedValue(ok({
        from: { address: "sender@example.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Test email",
        textBody: "Hello world",
        htmlBody: "<p>Hello world</p>",
        attachments: [],
        headers: {},
        sentAt: "2024-01-15T09:00:00Z",
      })),
    };
  }

  function makeArcMatcher(): ArcMatcher {
    return {
      findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };
  }

  function makeMessage(sesMessageId: string): InboundSignalMessage {
    return {
      accountId: TEST_ACCOUNT_ID,
      s3Key: `emails/${sesMessageId}`,
      sesMessageId,
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  const failureCases = [
    { label: "cluster-a fails", failingClusterId: "cluster-a", succeedingClusterId: "cluster-b" },
    { label: "cluster-b fails", failingClusterId: "cluster-b", succeedingClusterId: "cluster-a" },
  ];

  it.each(failureCases)("$label — DynamoDB cache still contains both models' vectors", async ({ failingClusterId }) => {
    const store = makeStore();
    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: VECTOR_A, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([
        ok({ modelId: "amazon.titan-embed-text-v3:0", vector: VECTOR_B, dimensions: 1536 }),
      ]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockImplementation(async (opts: { registryId: string }) => {
        if (opts.registryId === failingClusterId) {
          return err(dbError(new Error(`Aurora upsert failed for cluster ${failingClusterId}`)));
        }
        return ok(undefined);
      }),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const processor = new SignalProcessor({
      store,
      mimeParser: makeMimeParser(),
      classifier: { classify: vi.fn().mockResolvedValue({ ...validClassification }) },
      embeddingGenerator,
      auroraWriter,
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), notifyBlocked: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "emails/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    });

    await processor.processRecord(makeMessage("test-msg-aurora"), 1);

    const saveSignalCalls = (store.saveSignal as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveSignalCalls.length).toBeGreaterThanOrEqual(1);
    const savedSignal = saveSignalCalls[0]![0] as Signal;

    expect(savedSignal.embeddings).toBeDefined();
    expect(savedSignal.embeddings!["amazon.titan-embed-text-v2:0"]).toEqual(VECTOR_A);
    expect(savedSignal.embeddings!["amazon.titan-embed-text-v3:0"]).toEqual(VECTOR_B);
  });

  it.each(failureCases)("$label — non-failing cluster still receives its upsert", async ({ failingClusterId, succeedingClusterId }) => {
    const store = makeStore();
    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: VECTOR_A, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([
        ok({ modelId: "amazon.titan-embed-text-v3:0", vector: VECTOR_B, dimensions: 1536 }),
      ]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockImplementation(async (opts: { registryId: string }) => {
        if (opts.registryId === failingClusterId) {
          return err(dbError(new Error(`Aurora upsert failed for cluster ${failingClusterId}`)));
        }
        return ok(undefined);
      }),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const processor = new SignalProcessor({
      store,
      mimeParser: makeMimeParser(),
      classifier: { classify: vi.fn().mockResolvedValue({ ...validClassification }) },
      embeddingGenerator,
      auroraWriter,
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), notifyBlocked: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "emails/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    });

    await processor.processRecord(makeMessage("test-msg-aurora"), 1);

    const upsertCalls = (auroraWriter.upsertEmbedding as ReturnType<typeof vi.fn>).mock.calls;
    expect(upsertCalls.length).toBe(2);

    const succeedingCall = upsertCalls.find((call) => call[0].registryId === succeedingClusterId);
    expect(succeedingCall).toBeDefined();
  });
});
