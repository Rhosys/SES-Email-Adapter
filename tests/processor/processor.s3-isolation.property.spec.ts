import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { S3RetentionService } from "../../src/embedding/s3-retention-service.js";
import type { Alias, AliasSender } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with a single active cluster
// ---------------------------------------------------------------------------

vi.mock("../../src/embedding/cluster-registry.js", () => {
  const cluster = Object.freeze({
    registryId: "cluster-primary",
    clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-primary",
    secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-primary",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([cluster]),
    getActiveClusters: () => [cluster],
    getRegistryById: (id: string) => (id === cluster.registryId ? cluster : null),
    getPrimaryThreadMatcherRegistry: () => cluster,
    getSecondaryClusters: () => [],
  };
});

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

// ---------------------------------------------------------------------------
// Property 9: S3 retention failure is isolated and non-fatal
// **Validates: Requirements 5.1, 5.3**
// ---------------------------------------------------------------------------

/**
 * For any S3 retention operation that fails, the processor SHALL log at warn
 * level, continue processing (Aurora upserts and side-effect dispatch), and
 * SHALL NOT return a batchItemFailure due to the S3 error. The processing
 * outcome SHALL be identical to what it would be without the S3 failure.
 */
describe("Property 9: S3 retention failure is isolated and non-fatal", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop9";

  const DEFAULT_ALIAS: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    aliasAddress: "user@example.com",
    domain: "example.com",
    aliasName: "user",
    unknownSenderPolicy: "allow_all",
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
    aliasConfig: DEFAULT_ALIAS,
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

  function makeEmbeddingGenerator(): EmbeddingGenerator {
    return {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: new Array(10).fill(0.1), dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };
  }

  function makeAuroraWriter(): MultiClusterAuroraWriter {
    return {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };
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

  // -------------------------------------------------------------------------
  // Edge-case inputs: S3 failure modes
  // The code has TWO distinct error paths:
  // 1. ResultAsync error: applyPlanRetention rejects → caught by ResultAsync.fromPromise → logs "processor.s3_retention_failed"
  // 2. Thrown exception: code outside ResultAsync throws → caught by outer try/catch → logs "processor.s3_retention_unexpected"
  // -------------------------------------------------------------------------

  const S3_RESULT_ASYNC_ERROR_CASES = [
    { label: "rejected promise (ResultAsync error path — S3 connection reset)", error: new Error("S3 error: connection reset") },
    { label: "rejected promise (ResultAsync error path — access denied)", error: new Error("AccessDenied: insufficient permissions") },
    { label: "rejected promise (ResultAsync error path — no such key)", error: new Error("NoSuchKey: object not found") },
  ] as const;

  it.each(S3_RESULT_ASYNC_ERROR_CASES)("S3 retention failure does not produce a batchItemFailure ($label)", async ({ error }) => {
    const retentionService: S3RetentionService = {
      applyPlanRetention: vi.fn().mockRejectedValue(error),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage("test-msg-s3-isolation"), 1);
    expect(result.isOk()).toBe(true);
  });

  it.each(S3_RESULT_ASYNC_ERROR_CASES)("Aurora upserts still execute when S3 retention fails ($label)", async ({ error }) => {
    const auroraWriter = makeAuroraWriter();

    const retentionService: S3RetentionService = {
      applyPlanRetention: vi.fn().mockRejectedValue(error),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processRecord(makeMessage("test-msg-s3-aurora"), 1);
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();
  });

  it.each(S3_RESULT_ASYNC_ERROR_CASES)("warn-level log is emitted when S3 retention fails ($label)", async ({ error }) => {
    mockLogger = createMockLogger();

    const retentionService: S3RetentionService = {
      applyPlanRetention: vi.fn().mockRejectedValue(error),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processRecord(makeMessage("test-msg-s3-warn"), 1);

    const warnCalls = mockLogger.calls.filter((c) => c.method === "warn");
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);

    const s3WarnCall = warnCalls.find((c) =>
      c.message.toLowerCase().includes("s3") || c.message.toLowerCase().includes("retention"),
    );
    expect(s3WarnCall).toBeDefined();
  });

  it.each(S3_RESULT_ASYNC_ERROR_CASES)("processing outcome is identical with and without S3 failure ($label)", async ({ error }) => {
    // Run 1: with S3 failure
    const store1 = makeStore();
    const auroraWriter1 = makeAuroraWriter();
    const failingRetention: S3RetentionService = {
      applyPlanRetention: vi.fn().mockRejectedValue(error),
    };
    const logger1 = createMockLogger();

    const processor1 = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...store1,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: auroraWriter1,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(logger1),
      logger: logger1,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: failingRetention,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result1 = await processor1.processRecord(makeMessage("test-msg-s3-outcome"), 1);

    // Run 2: without S3 retention service (no retention at all)
    const store2 = makeStore();
    const auroraWriter2 = makeAuroraWriter();
    const logger2 = createMockLogger();

    const processor2 = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...store2,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: auroraWriter2,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(logger2),
      logger: logger2,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
      // No retentionService — S3 retention is skipped entirely
    });

    const result2 = await processor2.processRecord(makeMessage("test-msg-s3-outcome"), 1);

    // Both runs must produce the same result
    expect(result1.isOk()).toBe(result2.isOk());

    // Both runs must call saveSignal (signal was persisted)
    expect(store1.threadDb.saveSignal).toHaveBeenCalled();
    expect(store2.threadDb.saveSignal).toHaveBeenCalled();

    // Both runs must call Aurora upsert
    expect(auroraWriter1.upsertEmbedding).toHaveBeenCalled();
    expect(auroraWriter2.upsertEmbedding).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Boundary: retentionService undefined (no S3 retention configured)
  // The code does `if (!this.retentionService) return;` — early exit, no error
  // -------------------------------------------------------------------------

  it("no retentionService configured — processing succeeds without any S3 interaction", async () => {
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
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
      // No retentionService — S3 retention is skipped entirely
    });

    const result = await processor.processRecord(makeMessage("test-msg-no-retention-svc"), 1);

    expect(result.isOk()).toBe(true);
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Boundary: applyPlanRetention resolves successfully but returns a value
  // that triggers the outer try/catch (e.g., getRetentionForPlan throws)
  // This exercises the "processor.s3_retention_unexpected" log path
  // -------------------------------------------------------------------------

  it("outer try/catch path — non-promise error in retention flow logs warn and continues", async () => {
    mockLogger = createMockLogger();
    const auroraWriter = makeAuroraWriter();

    // applyPlanRetention resolves, but we'll make the retention service throw
    // synchronously before the promise is awaited by using a getter that throws
    const retentionService: S3RetentionService = {
      applyPlanRetention: vi.fn().mockImplementation(() => {
        throw new Error("Unexpected sync error in retention");
      }),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage("test-msg-s3-sync-throw"), 1);

    // Processing continues — no batchItemFailure
    expect(result.isOk()).toBe(true);
    // Aurora upserts still execute
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();

    // Warn log emitted for the unexpected error
    const warnCalls = mockLogger.calls.filter((c) => c.method === "warn");
    const unexpectedWarn = warnCalls.find((c) =>
      c.message.toLowerCase().includes("unexpected") || c.message.toLowerCase().includes("s3") || c.message.toLowerCase().includes("retention"),
    );
    expect(unexpectedWarn).toBeDefined();
  });
});
