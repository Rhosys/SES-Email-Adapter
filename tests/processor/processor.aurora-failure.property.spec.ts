import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok, err, dbError } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Signal, Alias, AliasSender } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";

vi.mock("../../src/embedding/cluster-registry.js", () => {
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
    getPrimaryThreadMatcherRegistry: () => clusterA,
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

  function makeArcMatcher(): ThreadMatcherPort {
    return {
      findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      deleteEmbeddingsForThread: vi.fn().mockResolvedValue(ok(undefined)),
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

  const failureCases = [
    { label: "cluster-a fails", failingClusterId: "cluster-a", succeedingClusterId: "cluster-b" },
    { label: "cluster-b fails", failingClusterId: "cluster-b", succeedingClusterId: "cluster-a" },
  ];

  it.each(failureCases)("$label — DynamoDB cache still contains both models' vectors", async ({ failingClusterId }) => {
    const { threadDb, accountDb, processingDb } = makeStore();
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

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
threadDb, accountDb, processingDb,
      contentSanitizer: makeContentSanitizer(), emailContentStore: { createReadUrl: vi.fn().mockResolvedValue("https://presigned-get"), getContent: vi.fn().mockResolvedValue(new Uint8Array()), saveRawEmail: vi.fn().mockResolvedValue(undefined), createContentUploadTicket: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { createReadUrl: vi.fn().mockResolvedValue("https://presigned-get"), getContent: vi.fn().mockResolvedValue(new Uint8Array()), saveRawEmail: vi.fn().mockResolvedValue(undefined), createContentUploadTicket: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn().mockResolvedValue(ok({ ...validClassification })) },
      embeddingGenerator,
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "emails/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processInbound(makeMessage("test-msg-aurora"), 1);

    const saveSignalCalls = (threadDb.saveSignal as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveSignalCalls.length).toBeGreaterThanOrEqual(1);
    const savedSignal = saveSignalCalls[0]![0] as Signal;

    expect(savedSignal.data.embeddings).toBeDefined();
    expect(savedSignal.data.embeddings!["amazon.titan-embed-text-v2:0"]).toEqual(VECTOR_A);
    expect(savedSignal.data.embeddings!["amazon.titan-embed-text-v3:0"]).toEqual(VECTOR_B);
  });

  it.each(failureCases)("$label — non-failing cluster still receives its upsert", async ({ failingClusterId, succeedingClusterId }) => {
    const { threadDb, accountDb, processingDb } = makeStore();
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

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
threadDb, accountDb, processingDb,
      contentSanitizer: makeContentSanitizer(), emailContentStore: { createReadUrl: vi.fn().mockResolvedValue("https://presigned-get"), getContent: vi.fn().mockResolvedValue(new Uint8Array()), saveRawEmail: vi.fn().mockResolvedValue(undefined), createContentUploadTicket: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { createReadUrl: vi.fn().mockResolvedValue("https://presigned-get"), getContent: vi.fn().mockResolvedValue(new Uint8Array()), saveRawEmail: vi.fn().mockResolvedValue(undefined), createContentUploadTicket: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn().mockResolvedValue(ok({ ...validClassification })) },
      embeddingGenerator,
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "emails/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processInbound(makeMessage("test-msg-aurora"), 1);

    const upsertCalls = (auroraWriter.upsertEmbedding as ReturnType<typeof vi.fn>).mock.calls;
    expect(upsertCalls.length).toBe(2);

    const succeedingCall = upsertCalls.find((call) => call[0].registryId === succeedingClusterId);
    expect(succeedingCall).toBeDefined();
  });
});
