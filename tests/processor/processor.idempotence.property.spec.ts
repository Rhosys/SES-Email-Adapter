import { describe, it, expect, vi } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import type { InboundSignalMessage, ProcessorDatabase, ArcMatcher } from "../../src/processor/processor.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/multi-cluster-aurora-writer.js";
import type { Signal, Alias, AliasSender } from "../../src/types/index.js";
import { createMockLogger } from "../helpers/mock-logger.js";

vi.mock("../../src/embedding/cluster-registry.js", () => {
  const cluster = Object.freeze({
    registryId: "cluster-a",
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
    getRegistryById: (id: string) => (id === "cluster-a" ? cluster : null),
    getPrimaryArcMatcherRegistry: () => cluster,
    getSecondaryClusters: () => [],
  };
});

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

describe("Cross-layer idempotence — live writes + cache + Aurora", () => {
  const TEST_ACCOUNT_ID = "acct-idem";
  const VECTOR = [0.1, -0.5, 0.3, 0.8, -0.2];

  const DEFAULT_EMAIL_CONFIG: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    unknownSenderPolicy: "quarantine_visible",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    policy: "allow",
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

  function makeContentSanitizer(): ContentSanitizerClient {
    return {
      invoke: vi.fn().mockReturnValue(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: "sender@external.com", name: "Sender" },
          to: [{ address: "user@example.com" }],
          cc: [],
          subject: "Test email",
          textBody: "Hello world",
          htmlBody: "<p>Hello world</p>",
          attachments: [],
          headers: { "authentication-results": "spf=pass dkim=pass" },
          sentAt: "2024-01-15T09:00:00Z",
        },
        urlMapping: {},
      }))),
    };
  }

  function makeClassifier(): Pick<SignalClassifier, "classify"> {
    return { classify: vi.fn().mockResolvedValue({ ...validClassification }) };
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

  it("dedup path: second processing of same messageId is a no-op", async () => {
    const store: ProcessorDatabase = {
      getSignalByMessageId: vi.fn()
        .mockReturnValueOnce(Promise.resolve(ok(null)))
        .mockReturnValueOnce(Promise.resolve(ok({ id: "SES#test-msg-001" }))),
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
      incrementStats: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      annotateTemplateError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: VECTOR, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const mockLogger = createMockLogger();
    const processor = new SignalProcessor({
      store,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: makeClassifier(),
      embeddingGenerator,
      auroraWriter,
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    });

    const message = makeMessage("test-msg-001");
    await processor.processRecord(message, 1);
    await processor.processRecord(message, 1);

    expect(store.getSignalByMessageId).toHaveBeenCalledTimes(2);
    expect(store.saveSignal).toHaveBeenCalledTimes(1);
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalledTimes(1);
    expect(embeddingGenerator.generateForModel).toHaveBeenCalledTimes(1);
  });

  it("race condition: both runs produce identical embeddings and Aurora upsert params", async () => {
    const savedSignals: Signal[] = [];
    const store: ProcessorDatabase = {
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      saveSignal: vi.fn().mockImplementation((signal: Signal) => {
        savedSignals.push(signal);
        return Promise.resolve(ok(undefined));
      }),
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
      incrementStats: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      annotateTemplateError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: VECTOR, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };

    const auroraUpsertCalls: Array<{ registryId: string; accountId: string; recipientAddress: string; embedding: number[] }> = [];
    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockImplementation(async (opts) => { auroraUpsertCalls.push(opts); return ok(undefined); }),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const mockLogger = createMockLogger();
    const processor = new SignalProcessor({
      store,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: makeClassifier(),
      embeddingGenerator,
      auroraWriter,
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    });

    const message = makeMessage("test-msg-001");
    await processor.processRecord(message, 1);
    await processor.processRecord(message, 1);

    expect(savedSignals.length).toBe(2);
    expect(savedSignals[0]!.embeddings).toEqual(savedSignals[1]!.embeddings);
    expect(savedSignals[0]!.embeddings!["amazon.titan-embed-text-v2:0"]).toEqual(VECTOR);

    expect(auroraUpsertCalls.length).toBe(2);
    expect(auroraUpsertCalls[0]!.registryId).toBe(auroraUpsertCalls[1]!.registryId);
    expect(auroraUpsertCalls[0]!.accountId).toBe(auroraUpsertCalls[1]!.accountId);
    expect(auroraUpsertCalls[0]!.recipientAddress).toBe(auroraUpsertCalls[1]!.recipientAddress);
    expect(auroraUpsertCalls[0]!.embedding).toEqual(auroraUpsertCalls[1]!.embedding);
  });
});
