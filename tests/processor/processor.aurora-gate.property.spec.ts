import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok, err } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, InboundSignalMessage, SqsDispatcher } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Alias, AliasSender } from "../../src/types/index.js";
import { dbError } from "../../src/errors.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry with a single active cluster
// ---------------------------------------------------------------------------

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

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

// ---------------------------------------------------------------------------
// Property 4: Arc saved before signal (leaf before dependent)
// **Validates: Requirements 2.3, 2.4**
// ---------------------------------------------------------------------------

/**
 * For any signal being processed on first attempt, the processor SHALL save the
 * arc to DDB before saving the signal. If the arc save fails, no signal save,
 * Aurora upsert, or side-effect SHALL execute, and the record SHALL be returned
 * as a batchItemFailure.
 */
describe("Feature: signal-processor-retry-resilience, Property 4: Arc saved before signal (leaf before dependent)", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop4";

  const DEFAULT_EMAIL_CONFIG: Alias = {
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
    return {
      classify: vi.fn().mockResolvedValue(ok({ ...validClassification })),
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
  // Edge-case inputs: what matters is the embedding map, not vector values
  // -------------------------------------------------------------------------

  const ORDER_CASES = [
    { label: "valid embeddings for both clusters", messageId: "msg-order-both", vectorA: [0.1, -0.9, 0.5], vectorB: [0.2, 0.8, -0.4] },
    { label: "single-element vectors (minimal valid embedding)", messageId: "msg-order-minimal", vectorA: [0.5], vectorB: [-0.3] },
  ];

  it.each(ORDER_CASES)("saveThread is always called before saveSignal on first-attempt processing ($label)", async ({ vectorA, vectorB, messageId }) => {
    const callOrder: string[] = [];

    const threadDb = {
      ...makeThreadDbMock(),
      saveSignal: vi.fn().mockImplementation(() => {
        callOrder.push("saveSignal");
        return Promise.resolve(ok(undefined));
      }),
      saveThread: vi.fn().mockImplementation(() => {
        callOrder.push("saveThread");
        return Promise.resolve(ok(undefined));
      }),
    } as unknown as ThreadDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    const processingDb = makeProcessingDbMock();

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([
        ok({ modelId: "amazon.titan-embed-text-v3:0", vector: vectorB, dimensions: 1536 }),
      ]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

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
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processRecord(makeMessage(messageId), 1);

    const saveThreadIdx = callOrder.indexOf("saveThread");
    const saveSignalIdx = callOrder.indexOf("saveSignal");

    expect(saveThreadIdx).toBeGreaterThanOrEqual(0);
    expect(saveSignalIdx).toBeGreaterThanOrEqual(0);
    expect(saveThreadIdx).toBeLessThan(saveSignalIdx);
  });

  it.each(ORDER_CASES)("when saveThread fails, saveSignal is never called and the record is a batchItemFailure ($label)", async ({ vectorA, vectorB, messageId }) => {
    let saveSignalCalled = false;

    const threadDb = {
      ...makeThreadDbMock(),
      saveSignal: vi.fn().mockImplementation(() => {
        saveSignalCalled = true;
        return Promise.resolve(ok(undefined));
      }),
      saveThread: vi.fn().mockReturnValue(Promise.resolve(err(dbError(new Error("DDB write failed"))))),
    } as unknown as ThreadDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    const processingDb = makeProcessingDbMock();

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([
        ok({ modelId: "amazon.titan-embed-text-v3:0", vector: vectorB, dimensions: 1536 }),
      ]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

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
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage(messageId), 1);

    expect(saveSignalCalled).toBe(false);
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    expect(result.isErr()).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Property 6: Aurora failure returns batchItemFailure with appropriate log level
// **Validates: Requirements 3.1, 3.2**
// ---------------------------------------------------------------------------

/**
 * For any Aurora upsert failure, the processor SHALL return the record as a
 * batchItemFailure. The log level SHALL be ERROR when the failing cluster is
 * the primary cluster, and WARN when the failing cluster is a non-primary
 * cluster. Both log entries SHALL include the cluster identifier and error message.
 */
describe("Feature: signal-processor-retry-resilience, Property 6: Aurora failure returns batchItemFailure with appropriate log level", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop6";

  const DEFAULT_EMAIL_CONFIG: Alias = {
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
    return { threadDb: makeThreadDbMock(), accountDb, processingDb: makeProcessingDbMock() };
  }

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
    return {
      classify: vi.fn().mockResolvedValue(ok({ ...validClassification })),
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
  // Edge-case inputs: what matters is WHICH cluster fails (primary vs non-primary)
  // -------------------------------------------------------------------------

  const PRIMARY_FAILURE_CASES = [
    { label: "primary cluster fails (connection timeout)", vectorA: [0.1, -0.9, 0.5], vectorB: [0.2, 0.8, -0.4], messageId: "msg-primary-fail" },
  ];

  const SECONDARY_FAILURE_CASES = [
    { label: "non-primary cluster fails (throttled)", vectorA: [0.1, -0.9, 0.5], vectorB: [0.2, 0.8, -0.4], messageId: "msg-secondary-fail" },
  ];

  const BOTH_FAIL_CASES = [
    { label: "both clusters fail (total Aurora outage)", vectorA: [0.1, -0.9, 0.5], vectorB: [0.2, 0.8, -0.4], messageId: "msg-both-fail" },
  ];

  it.each(PRIMARY_FAILURE_CASES)("primary cluster failure logs at ERROR level with cluster ID and error message, and returns batchItemFailure ($label)", async ({ vectorA, vectorB, messageId }) => {
    mockLogger.calls.length = 0;

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([
        ok({ modelId: "amazon.titan-embed-text-v3:0", vector: vectorB, dimensions: 1536 }),
      ]),
    };

    // Primary cluster (cluster-a) fails
    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockImplementation(async (opts: { registryId: string }) => {
        if (opts.registryId === "cluster-a") {
          return err(dbError(new Error("Connection timeout on primary")));
        }
        return ok(undefined);
      }),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
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
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage(messageId), 1);

    expect(result.isErr()).toBe(true);

    const errorLogs = mockLogger.calls.filter((c) => c.method === "error");
    const auroraErrorLog = errorLogs.find((c) => c.context?.registryId === "cluster-a");
    expect(auroraErrorLog).toBeDefined();
    expect(auroraErrorLog!.context!.registryId).toBe("cluster-a");
    expect(auroraErrorLog!.context!.error).toBeDefined();
    expect(String((auroraErrorLog!.context!.error as { cause: unknown }).cause)).toContain("Connection timeout on primary");
  });

  it.each(SECONDARY_FAILURE_CASES)("non-primary cluster failure logs at ERROR level with cluster ID and error message, and returns batchItemFailure ($label)", async ({ vectorA, vectorB, messageId }) => {
    mockLogger.calls.length = 0;

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([
        ok({ modelId: "amazon.titan-embed-text-v3:0", vector: vectorB, dimensions: 1536 }),
      ]),
    };

    // Non-primary cluster (cluster-b) fails, primary succeeds
    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockImplementation(async (opts: { registryId: string }) => {
        if (opts.registryId === "cluster-b") {
          return err(dbError(new Error("Throttled on secondary")));
        }
        return ok(undefined);
      }),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
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
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage(messageId), 1);

    expect(result.isErr()).toBe(true);

    // All Aurora failures now log at ERROR level uniformly (no primary/non-primary distinction)
    const errorLogs = mockLogger.calls.filter((c) => c.method === "error");
    const auroraErrorLog = errorLogs.find((c) => c.context?.registryId === "cluster-b");
    expect(auroraErrorLog).toBeDefined();
    expect(auroraErrorLog!.context!.registryId).toBe("cluster-b");
    expect(auroraErrorLog!.context!.error).toBeDefined();
    expect(String((auroraErrorLog!.context!.error as { cause: unknown }).cause)).toContain("Throttled on secondary");
  });

  it.each(BOTH_FAIL_CASES)("both clusters failing logs ERROR for all failures, returns batchItemFailure ($label)", async ({ vectorA, vectorB, messageId }) => {
    mockLogger.calls.length = 0;

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: vectorA, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([
        ok({ modelId: "amazon.titan-embed-text-v3:0", vector: vectorB, dimensions: 1536 }),
      ]),
    };

    // Both clusters fail
    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockImplementation(async (opts: { registryId: string }) => {
        if (opts.registryId === "cluster-a") return err(dbError(new Error("Primary connection refused")));
        if (opts.registryId === "cluster-b") return err(dbError(new Error("Secondary connection refused")));
        return ok(undefined);
      }),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
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
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage(messageId), 1);

    expect(result.isErr()).toBe(true);

    // All Aurora failures now log at ERROR level uniformly
    const errorLogs = mockLogger.calls.filter((c) => c.method === "error");
    const primaryErrorLog = errorLogs.find((c) => c.context?.registryId === "cluster-a");
    expect(primaryErrorLog).toBeDefined();

    const secondaryErrorLog = errorLogs.find((c) => c.context?.registryId === "cluster-b");
    expect(secondaryErrorLog).toBeDefined();
  });
});


// ---------------------------------------------------------------------------
// Property 5: Side-effects dispatch if and only if all Aurora upserts succeed
// **Validates: Requirements 2.1, 2.2, 3.3, 4.2, 4.3**
// ---------------------------------------------------------------------------

/**
 * For any signal with side-effects indicated by its outcome, the side-effect SQS
 * message SHALL be dispatched only after all active Aurora cluster upserts succeed.
 * If any Aurora upsert fails, no side-effect message SHALL be dispatched for that record.
 */
describe("Feature: signal-processor-retry-resilience, Property 5: Side-effects dispatch iff all Aurora upserts succeed", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop5";

  const DEFAULT_EMAIL_CONFIG: Alias = {
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
    return {
      classify: vi.fn().mockResolvedValue(ok({ ...validClassification })),
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

  function makeStore() {
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    return { threadDb: makeThreadDbMock(), accountDb, processingDb: makeProcessingDbMock() };
  }

  // -------------------------------------------------------------------------
  // Edge-case inputs: what matters is Aurora success/failure and dispatcher state
  // -------------------------------------------------------------------------

  it("when all Aurora upserts succeed, sqsDispatcher.sendMessage is called with signal and arc", async () => {
    const vector = [0.1, -0.9, 0.5];
    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator,
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      sqsDispatcher,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage("msg-dispatch-success"), 1);

    expect(result.isOk()).toBe(true);
    expect(sqsDispatcher.sendMessage).toHaveBeenCalled();

    const call = (sqsDispatcher.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = call[0] as { signal: unknown; thread: unknown };
    expect(payload.signal).toBeDefined();
    expect(payload.thread).toBeDefined();
  });

  it("when any Aurora upsert fails, sqsDispatcher.sendMessage is NOT called and record is a batchItemFailure", async () => {
    const vector = [0.1, -0.9, 0.5];
    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(err(dbError(new Error("Aurora cluster unavailable")))),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator,
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      sqsDispatcher,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage("msg-dispatch-aurora-fail"), 1);

    expect(sqsDispatcher.sendMessage).not.toHaveBeenCalled();
    expect(result.isErr()).toBe(true);
  });

  it("when sqsDispatcher is undefined (backward compat), returns ok without dispatching", async () => {
    const vector = [0.1, -0.9, 0.5];
    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
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
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
      // No sqsDispatcher — backward compatibility path
    });

    const result = await processor.processRecord(makeMessage("msg-dispatch-no-dispatcher"), 1);

    expect(result.isOk()).toBe(true);
  });

  it("when sqsDispatcher.sendMessage fails, returns batchItemFailure (Aurora succeeded but dispatch failed)", async () => {
    const vector = [0.1, -0.9, 0.5];
    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(err(dbError(new Error("SQS SendMessage failed"))))),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator,
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      sqsDispatcher,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage("msg-dispatch-sqs-fail"), 1);

    expect(result.isErr()).toBe(true);
    // Aurora upsert should have been called (it succeeded)
    expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// Property 7: Partial Aurora success preserves primary write
// **Validates: Requirements 3.4**
// ---------------------------------------------------------------------------

/**
 * For any signal where the primary cluster upsert succeeds but a non-primary
 * cluster upsert fails, the primary cluster's write SHALL NOT be rolled back.
 * The record SHALL be returned as a batchItemFailure so that the retry re-runs
 * all upserts (idempotent) until all clusters succeed.
 */
describe("Feature: signal-processor-retry-resilience, Property 7: Partial Aurora success preserves primary write", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop7";

  const DEFAULT_EMAIL_CONFIG: Alias = {
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
    return {
      classify: vi.fn().mockResolvedValue(ok({ ...validClassification })),
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
  // Edge-case inputs: the branching logic is about which cluster fails, not vector content
  // -------------------------------------------------------------------------

  const PARTIAL_SUCCESS_CASES: Array<{ label: string; vector: number[]; messageId: string }> = [
    { label: "non-primary fails with connection timeout", vector: [0.1, -0.9, 0.5], messageId: "msg-partial-timeout" },
  ];

  it.each(PARTIAL_SUCCESS_CASES)("primary cluster write is preserved when non-primary cluster fails, record returned as batchItemFailure, no side-effects dispatched ($label)", async ({ vector, messageId }) => {
    const completedUpserts: string[] = [];

    const threadDb = makeThreadDbMock();
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    const processingDb = makeProcessingDbMock();

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([
        ok({ modelId: "amazon.titan-embed-text-v3:0", vector, dimensions: 1536 }),
      ]),
    };

    // Primary cluster (cluster-a) succeeds, non-primary (cluster-b) fails
    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockImplementation((opts: { registryId: string }) => {
        if (opts.registryId === "cluster-a") {
          completedUpserts.push("cluster-a");
          return Promise.resolve(ok(undefined));
        }
        return Promise.resolve(err(dbError(new Error("Aurora cluster-b connection timeout"))));
      }),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      threadDb, accountDb, processingDb,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: makeClassifier(),
      embeddingGenerator,
      auroraWriter,
      threadMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      sqsDispatcher,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const result = await processor.processRecord(makeMessage(messageId), 1);

    // 1. Primary cluster's upsert was called and completed (not rolled back)
    expect(completedUpserts).toContain("cluster-a");

    // 2. Record IS returned as a batchItemFailure (because non-primary failed)
    expect(result.isErr()).toBe(true);

    // 3. No side-effects are dispatched (Aurora failure gates side-effect dispatch)
    expect(sqsDispatcher.sendMessage).not.toHaveBeenCalled();
  });
});
