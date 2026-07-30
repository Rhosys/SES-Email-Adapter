import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { describe, it, expect, vi } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Signal, Alias, AliasSender } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";

// Use vi.hoisted to create mutable state that the hoisted vi.mock can reference
const mockState = vi.hoisted(() => ({
  clusters: [
    {
      registryId: "cluster-default",
      clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-default",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-default",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    },
  ] as Array<{
    registryId: string;
    clusterArn: string;
    secretArn: string;
    databaseName: string;
    modelId: string;
    dimensions: number;
    active: boolean;
  }>,
}));

vi.mock("../../src/embedding/cluster-registry.js", () => ({
  get CLUSTER_REGISTRY() {
    return Object.freeze(mockState.clusters);
  },
  getActiveClusters: () => mockState.clusters.filter((c) => c.active),
  getRegistryById: (id: string) => mockState.clusters.find((c) => c.registryId === id) ?? null,
  getPrimaryThreadMatcherRegistry: () => mockState.clusters.find((c) => c.active) ?? mockState.clusters[0],
  getSecondaryClusters: () => {
    const primary = mockState.clusters.find((c) => c.active) ?? mockState.clusters[0];
    return mockState.clusters.filter((c) => c.active && c.registryId !== primary!.registryId);
  },
}));

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

describe("Multi-cluster fanout writes vectors to every active target", () => {
  const TEST_ACCOUNT_ID = "acct-prop6";

  const DEFAULT_EMAIL_CONFIG: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    aliasName: "user",
    unknownSenderPolicy: "quarantine_visible",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_SENDER_ENTRY: AliasSender = {
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    aliasName: "user",
    senderDomain: "example.com",
    policy: "allow",
    addedAt: "2024-01-01T00:00:00Z",
  };

  const DEFAULT_CTX = {
    retentionDuration: "P3M",
    filtering: null,
    aliasConfig: DEFAULT_EMAIL_CONFIG,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  const validClassification: ClassificationOutput = {
    workflow: "conversation",
    workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
    tags: [],
    summary: "A test email.",
    labels: [],
    actions: [],
  };

  function makeStore() {
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    vi.mocked(accountDb.getSender).mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY)));
    return { threadDb: makeThreadDbMock(), accountDb, processingDb: makeProcessingDbMock() };
  }

  function makeContentSanitizer(): ContentSanitizerClient {
    return {
      invoke: vi.fn().mockReturnValue(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: "sender@example.com", name: "Sender" },
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
    return { classify: vi.fn().mockResolvedValue(ok({ ...validClassification })) };
  }

  function makeArcMatcher(): ThreadMatcherPort {
    return {
      findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };
  }

  function makeMessage(messageId: string): InboundSignalMessage {
    return {
      s3Key: `emails/${messageId}`,
      compositeMailMessageId: `ses-${messageId}`,
      idempotencyKey: "test-idempotency-key",
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  const clusterConfigs = [
    {
      label: "single cluster",
      clusters: [
        { registryId: "cluster-alpha-0", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-alpha-0", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-alpha-0", databaseName: "signals", modelId: "model-alpha", dimensions: 512, active: true },
      ],
    },
    {
      label: "two clusters with different dimensions",
      clusters: [
        { registryId: "cluster-alpha-0", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-alpha-0", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-alpha-0", databaseName: "signals", modelId: "model-alpha", dimensions: 512, active: true },
        { registryId: "cluster-beta-1", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-beta-1", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-beta-1", databaseName: "signals", modelId: "model-beta", dimensions: 1024, active: true },
      ],
    },
    {
      label: "three clusters",
      clusters: [
        { registryId: "cluster-alpha-0", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-alpha-0", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-alpha-0", databaseName: "signals", modelId: "model-alpha", dimensions: 256, active: true },
        { registryId: "cluster-beta-1", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-beta-1", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-beta-1", databaseName: "signals", modelId: "model-beta", dimensions: 512, active: true },
        { registryId: "cluster-gamma-2", clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-gamma-2", secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-gamma-2", databaseName: "signals", modelId: "model-gamma", dimensions: 1024, active: true },
      ],
    },
  ];

  it.each(clusterConfigs)("$label — DynamoDB embeddings map has one entry per active cluster", async ({ clusters }) => {
    mockState.clusters = clusters;

    const { threadDb, accountDb, processingDb } = makeStore();
    const embeddingResults: EmbeddingResult[] = clusters.map((cluster) => ({
      modelId: cluster.modelId,
      vector: Array.from({ length: cluster.dimensions }, (_, i) => (i + 1) / cluster.dimensions),
      dimensions: cluster.dimensions,
    }));

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockImplementation(async (_: string, modelId: string) => {
        const result = embeddingResults.find((r) => r.modelId === modelId);
        if (!result) return ok(embeddingResults[0]!);
        return ok(result);
      }),
      generateForSecondaryClusters: vi.fn().mockImplementation(async () => {
        const primary = clusters[0]!;
        return embeddingResults.filter((r) => r.modelId !== primary.modelId).map((r) => ok(r));
      }),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const mockLogger = createMockLogger();
    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
threadDb, accountDb, processingDb,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator,
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processRecord(makeMessage("ses-fanout-test"), 1);

    const saveSignalCalls = (threadDb.saveSignal as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveSignalCalls.length).toBeGreaterThanOrEqual(1);
    const savedSignal = saveSignalCalls[0]![0] as Signal;

    expect(savedSignal.data.embeddings).toBeDefined();
    expect(Object.keys(savedSignal.data.embeddings!)).toHaveLength(clusters.length);
    for (const cluster of clusters) {
      expect(savedSignal.data.embeddings![cluster.modelId]).toBeDefined();
      expect(savedSignal.data.embeddings![cluster.modelId]).toHaveLength(cluster.dimensions);
    }
  });

  it.each(clusterConfigs)("$label — each Aurora cluster receives exactly one upsert", async ({ clusters }) => {
    mockState.clusters = clusters;

    const { threadDb, accountDb, processingDb } = makeStore();
    const embeddingResults: EmbeddingResult[] = clusters.map((cluster) => ({
      modelId: cluster.modelId,
      vector: Array.from({ length: cluster.dimensions }, (_, i) => (i + 1) / cluster.dimensions),
      dimensions: cluster.dimensions,
    }));

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockImplementation(async (_: string, modelId: string) => {
        const result = embeddingResults.find((r) => r.modelId === modelId);
        if (!result) return ok(embeddingResults[0]!);
        return ok(result);
      }),
      generateForSecondaryClusters: vi.fn().mockImplementation(async () => {
        const primary = clusters[0]!;
        return embeddingResults.filter((r) => r.modelId !== primary.modelId).map((r) => ok(r));
      }),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const mockLogger = createMockLogger();
    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
threadDb, accountDb, processingDb,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator,
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processRecord(makeMessage("ses-fanout-test"), 1);

    const upsertCalls = (auroraWriter.upsertEmbedding as ReturnType<typeof vi.fn>).mock.calls;
    expect(upsertCalls).toHaveLength(clusters.length);

    for (const cluster of clusters) {
      const matchingCall = upsertCalls.find(
        (call: Array<{ registryId: string }>) => call[0]?.registryId === cluster.registryId,
      );
      expect(matchingCall).toBeDefined();
      expect(matchingCall![0].accountId).toBe(TEST_ACCOUNT_ID);
      expect(matchingCall![0].recipientAddress).toBe("user@example.com");
    }
  });

  it.each(clusterConfigs)("$label — embeddings map keys match cluster modelIds exactly", async ({ clusters }) => {
    mockState.clusters = clusters;

    const { threadDb, accountDb, processingDb } = makeStore();
    const embeddingResults: EmbeddingResult[] = clusters.map((cluster) => ({
      modelId: cluster.modelId,
      vector: new Array(cluster.dimensions).fill(0.1),
      dimensions: cluster.dimensions,
    }));

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockImplementation(async (_: string, modelId: string) => {
        const result = embeddingResults.find((r) => r.modelId === modelId);
        if (!result) return ok(embeddingResults[0]!);
        return ok(result);
      }),
      generateForSecondaryClusters: vi.fn().mockImplementation(async () => {
        const primary = clusters[0]!;
        return embeddingResults.filter((r) => r.modelId !== primary.modelId).map((r) => ok(r));
      }),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const mockLogger = createMockLogger();
    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
threadDb, accountDb, processingDb,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator,
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processRecord(makeMessage("ses-fanout-test"), 1);

    const saveSignalCalls = (threadDb.saveSignal as ReturnType<typeof vi.fn>).mock.calls;
    const savedSignal = saveSignalCalls[0]![0] as Signal;

    const embeddingsKeys = Object.keys(savedSignal.data.embeddings!).sort();
    const expectedKeys = clusters.map((c) => c.modelId).sort();
    expect(embeddingsKeys).toEqual(expectedKeys);
  });
});
