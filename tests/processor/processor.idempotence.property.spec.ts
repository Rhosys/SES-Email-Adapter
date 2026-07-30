import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { describe, it, expect, vi } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Signal, Alias, AliasSender } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";

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
    getPrimaryThreadMatcherRegistry: () => cluster,
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

  it("dedup path: second processing of same messageId is a no-op", async () => {
    const threadDb = {
      ...makeThreadDbMock(),
      getSignalByMessageId: vi.fn()
        .mockReturnValueOnce(Promise.resolve(ok(null)))
        .mockReturnValueOnce(Promise.resolve(ok({ id: "SES#test-msg-001" }))),
    } as unknown as ThreadDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    vi.mocked(accountDb.getSender).mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY)));
    const processingDb = makeProcessingDbMock();

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

    const message = makeMessage("test-msg-001");
    await processor.processRecord(message, 1);
    await processor.processRecord(message, 1);

    expect(threadDb.getSignalByMessageId).toHaveBeenCalledTimes(2);
    expect(threadDb.saveSignal).toHaveBeenCalledTimes(1);
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalledTimes(1);
    expect(embeddingGenerator.generateForModel).toHaveBeenCalledTimes(1);
  });

  it("race condition: both runs produce identical embeddings and Aurora upsert params", async () => {
    const savedSignals: Signal[] = [];
    const threadDb = {
      ...makeThreadDbMock(),
      saveSignal: vi.fn().mockImplementation((signal: Signal) => {
        savedSignals.push(signal);
        return Promise.resolve(ok(undefined));
      }),
    } as unknown as ThreadDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    vi.mocked(accountDb.getSender).mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY)));
    const processingDb = makeProcessingDbMock();

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

    const message = makeMessage("test-msg-001");
    await processor.processRecord(message, 1);
    await processor.processRecord(message, 1);

    expect(savedSignals.length).toBe(2);
    expect(savedSignals[0]!.data.embeddings).toEqual(savedSignals[1]!.data.embeddings);
    expect(savedSignals[0]!.data.embeddings!["amazon.titan-embed-text-v2:0"]).toEqual(VECTOR);

    expect(auroraUpsertCalls.length).toBe(2);
    expect(auroraUpsertCalls[0]!.registryId).toBe(auroraUpsertCalls[1]!.registryId);
    expect(auroraUpsertCalls[0]!.accountId).toBe(auroraUpsertCalls[1]!.accountId);
    expect(auroraUpsertCalls[0]!.recipientAddress).toBe(auroraUpsertCalls[1]!.recipientAddress);
    expect(auroraUpsertCalls[0]!.embedding).toEqual(auroraUpsertCalls[1]!.embedding);
  });
});
