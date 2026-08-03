import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, InboundSignalMessage, SqsDispatcher, Notifier,  ReplySender, SideEffectPayload } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { S3RetentionService } from "../../src/embedding/s3-retention-service.js";
import type { Signal, Thread, Alias } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { dbError } from "../../src/errors.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster-registry
// ---------------------------------------------------------------------------

vi.mock("../../src/embedding/cluster-registry.js", () => {
  const entry = Object.freeze({
    registryId: "aurora-prod-titan-v2",
    clusterArn: "arn:aws:rds:eu-central-1:123456789012:cluster:aurora-prod-titan-v2",
    secretArn: "arn:aws:secretsmanager:eu-central-1:123456789012:secret:aurora-prod-titan-v2-xxxxxx",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([entry]),
    getActiveClusters: () => [entry],
    getRegistryById: (id: string) => (id === entry.registryId ? entry : null),
    getPrimaryThreadMatcherRegistry: () => entry,
  };
});


// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-integration";
const SES_MESSAGE_ID = "msg-integration-001";

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

const DEFAULT_CTX = {
  retentionDuration: "P3M",
  filtering: null,
  aliasConfig: DEFAULT_ALIAS,
  registeredDomains: [],
  userEmails: [],
  billingPlan: "Paid" as const,
  onboardingCompleted: true,
};

const validClassification: ClassificationOutput = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
  tags: [],
  summary: "Integration test email.",
  labels: [],
  actions: [],
};

// ---------------------------------------------------------------------------
// Test double factories
// ---------------------------------------------------------------------------

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
        subject: "Integration test email",
        textBody: "Hello from integration test",
        htmlBody: "<p>Hello from integration test</p>",
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
      ok({ modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 }),
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

function makeRetentionService(): S3RetentionService {
  return {
    applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: `emails/${SES_MESSAGE_ID}` }),
  };
}

function makeSqsDispatcher(): SqsDispatcher {
  return {
    sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  };
}

function makeNotifier(): Notifier {
  return {
    notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    
  };
}

function makeForwarder(): IForwardingService {
  return {
    forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    sendVerification: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

function makeReplySender(): ReplySender {
  return {
    sendReply: vi.fn().mockResolvedValue(ok({ messageId: "pong-msg-001" })),
  };
}

/**
 * Build an inbound signal message.
 */
function makeMessage(opts: {
  messageId?: string;
}): InboundSignalMessage {
  const messageId = opts.messageId ?? SES_MESSAGE_ID;
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

/**
 * Build a side-effect payload (dispatched by the processor itself).
 */
function makeSideEffectPayload(payload: { signal: Signal; arc: Thread }): SideEffectPayload {
  return { signal: payload.signal, thread: payload.arc };
}

/**
 * Build a realistic Signal as it would exist in DDB after first-attempt processing.
 */
function makeExistingSignal(overrides: Partial<Omit<Signal, "data">> & { data?: Partial<Signal["data"]> } = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "sgn-integration001",
    signalLookupId: `ses-${SES_MESSAGE_ID}`,
    threadId: "arc-integration-001",
    accountId: TEST_ACCOUNT_ID,
    source: "email",
    type: "email",
    status: "active",
    createdAt: "2024-01-15T10:00:00Z",
    ...baseOverrides,
    data: {
      receivedAt: "2024-01-15T10:00:00Z",
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Integration test email",
      textBody: "Hello from integration test",
      attachments: [],
      headers: {},
      recipientAddress: "user@example.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "Integration test email.",
      s3Key: `emails/${SES_MESSAGE_ID}`,
      embeddings: { "amazon.titan-embed-text-v2:0": new Array(1024).fill(0.1) },
      matchedRules: [],
      ...dataOverrides,
    },
  } as Signal;
}

function makeExistingArc(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "arc-integration-001",
    accountId: TEST_ACCOUNT_ID,
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "Integration test email.",
    lastSignalAt: "2024-01-15T10:00:00Z",
    sender: { address: "sender@example.com" },
    recipientAddress: "user@example.com",
    subject: "Test email",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}


// ---------------------------------------------------------------------------
// Integration tests: End-to-end retry flow
// Validates: Requirements 1.1, 1.2, 2.1, 2.2, 3.3, 4.1, 4.2
// ---------------------------------------------------------------------------

describe("SignalProcessor integration: end-to-end retry flow", () => {
  let threadDb: ReturnType<typeof makeThreadDbMock>;
  let accountDb: ReturnType<typeof makeAccountDbMock>;
  let processingDb: ReturnType<typeof makeProcessingDbMock>;
  let contentSanitizer: ContentSanitizerClient;
  let classifier: Pick<SignalClassifier, "classify">;
  let embeddingGenerator: EmbeddingGenerator;
  let auroraWriter: MultiClusterAuroraWriter;
  let threadMatcher: ThreadMatcherPort;
  let retentionService: S3RetentionService;
  let sqsDispatcher: SqsDispatcher;
  let notifier: Notifier;
  let forwardingService: IForwardingService;
  let replySender: ReplySender;
  let mockLogger: MockLogger;
  let processor: SignalProcessor;
  let resourceDb: { saveResource: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    ({ threadDb, accountDb, processingDb } = makeStore());
    contentSanitizer = makeContentSanitizer();
    classifier = makeClassifier();
    embeddingGenerator = makeEmbeddingGenerator();
    auroraWriter = makeAuroraWriter();
    threadMatcher = makeArcMatcher();
    retentionService = makeRetentionService();
    sqsDispatcher = makeSqsDispatcher();
    notifier = makeNotifier();
    forwardingService = makeForwarder();
    replySender = makeReplySender();
    resourceDb = { saveResource: vi.fn().mockResolvedValue(ok({ status: "active" })) };
    processor = new SignalProcessor({ resourceDb: resourceDb as never, ...makeSharedNewDeps(),
      threadDb, accountDb, processingDb,
      contentSanitizer, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://signed-url"), getObject: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://post-url", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://signed-url") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://signed-url"), getObject: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://post-url", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://signed-url") } as never,
      classifier,
      embeddingGenerator,
      auroraWriter,
      threadMatcher,
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      retentionService,
      sqsDispatcher,
      notifier,
      forwardingService,
      replySender,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: First attempt → saves arc → saves signal → S3 retention → Aurora → dispatches side-effect message
  // -------------------------------------------------------------------------

  describe("first attempt (receiveCount=1)", () => {
    it("executes full pipeline: parse → classify → arc match → save arc → save signal → S3 retention → Aurora → dispatch", async () => {
      const message = makeMessage({});

      const result = await processor.processInbound(message, 1);

      // No failures
      expect(result.isOk()).toBe(true);

      // MIME was parsed
      expect(contentSanitizer.invoke).toHaveBeenCalledOnce();

      // Classification ran
      expect(classifier.classify).toHaveBeenCalledOnce();

      // Embedding generated
      expect(embeddingGenerator.generateForModel).toHaveBeenCalledOnce();

      // Arc was saved before signal
      const callOrder: string[] = [];
      vi.mocked(threadDb.saveThread).mock.invocationCallOrder.forEach(() => callOrder.push("saveArc"));
      vi.mocked(threadDb.saveSignal).mock.invocationCallOrder.forEach(() => callOrder.push("saveSignal"));
      // Verify saveArc was called
      expect(threadDb.saveThread).toHaveBeenCalled();
      // Verify saveSignal was called
      expect(threadDb.saveSignal).toHaveBeenCalled();
      // saveArc invocation order < saveSignal invocation order
      const arcOrder = vi.mocked(threadDb.saveThread).mock.invocationCallOrder[0]!;
      const signalOrder = vi.mocked(threadDb.saveSignal).mock.invocationCallOrder[0]!;
      expect(arcOrder).toBeLessThan(signalOrder);

      // S3 retention was attempted
      expect(retentionService.applyPlanRetention).toHaveBeenCalledOnce();

      // Aurora upsert ran after signal save
      expect(auroraWriter.upsertEmbedding).toHaveBeenCalledOnce();
      const auroraOrder = vi.mocked(auroraWriter.upsertEmbedding).mock.invocationCallOrder[0]!;
      expect(auroraOrder).toBeGreaterThan(signalOrder);

      // Side-effect SQS message was dispatched after Aurora
      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
      const dispatchOrder = vi.mocked(sqsDispatcher.sendMessage).mock.invocationCallOrder[0]!;
      expect(dispatchOrder).toBeGreaterThan(auroraOrder);
    });

    it("dispatches side-effect payload containing signal and thread", async () => {
      const message = makeMessage({});

      await processor.processInbound(message, 1);

      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      expect(payload.signal).toBeDefined();
      expect(payload.thread).toBeDefined();
      expect(payload.signal.accountId).toBe(TEST_ACCOUNT_ID);
      expect(payload.thread!.accountId).toBe(TEST_ACCOUNT_ID);
      expect(payload.signal.threadId).toBe(payload.thread!.id);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: Retry with existing signal → skips parse/classify → S3 retention → Aurora → dispatches side-effect message
  // -------------------------------------------------------------------------

  describe("retry with existing signal (receiveCount > 1, signal in DDB)", () => {
    const existingSignal = makeExistingSignal();
    const existingArc = makeExistingArc();

    beforeEach(() => {
      vi.mocked(threadDb.getSignalByMessageId).mockReturnValue(Promise.resolve(ok(existingSignal)));
      vi.mocked(threadDb.getThread).mockReturnValue(Promise.resolve(ok(existingArc)));
    });

    it("skips parse, classify, and embedding — resumes from S3 retention → Aurora → dispatch", async () => {
      const message = makeMessage({});

      const result = await processor.processInbound(message, 3);

      // No failures
      expect(result.isOk()).toBe(true);

      // Signal was looked up from DDB
      expect(threadDb.getSignalByMessageId).toHaveBeenCalledWith(TEST_ACCOUNT_ID, `ses-${SES_MESSAGE_ID}`);

      // Arc was loaded from DDB
      expect(threadDb.getThread).toHaveBeenCalledWith(TEST_ACCOUNT_ID, existingSignal.threadId);

      // Expensive operations were NOT called
      expect(contentSanitizer.invoke).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(embeddingGenerator.generateForModel).not.toHaveBeenCalled();

      // No new DDB saves (arc and signal already exist)
      expect(threadDb.saveThread).not.toHaveBeenCalled();
      expect(threadDb.saveSignal).not.toHaveBeenCalled();

      // S3 retention was attempted (idempotent, always runs)
      expect(retentionService.applyPlanRetention).toHaveBeenCalledOnce();

      // Aurora upsert ran (idempotent)
      expect(auroraWriter.upsertEmbedding).toHaveBeenCalledOnce();

      // Side-effect SQS message was dispatched
      expect(sqsDispatcher.sendMessage).toHaveBeenCalledOnce();
      const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
      expect(payload.signal.id).toBe(existingSignal.id);
      expect(payload.thread!.id).toBe(existingArc.id);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: Aurora failure on retry → no side-effect dispatch → batchItemFailure returned
  // -------------------------------------------------------------------------

  describe("Aurora failure on retry", () => {
    const existingSignal = makeExistingSignal();
    const existingArc = makeExistingArc();

    beforeEach(() => {
      vi.mocked(threadDb.getSignalByMessageId).mockReturnValue(Promise.resolve(ok(existingSignal)));
      vi.mocked(threadDb.getThread).mockReturnValue(Promise.resolve(ok(existingArc)));
      // Aurora fails
      vi.mocked(auroraWriter.upsertEmbedding).mockResolvedValue(err(dbError(new Error("Aurora cluster timeout"))));
    });

    it("returns batchItemFailure and does not dispatch side-effects", async () => {
      const message = makeMessage({});

      const result = await processor.processInbound(message, 2);

      // Record returned as failure
      expect(result.isErr()).toBe(true);

      // Side-effect dispatch was NOT called (Aurora failed)
      expect(sqsDispatcher.sendMessage).not.toHaveBeenCalled();

      // S3 retention still ran (fire-and-forget, before Aurora)
      expect(retentionService.applyPlanRetention).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: Side-effect message received → derives outcome → executes effects
  // -------------------------------------------------------------------------

  describe("side-effect message processing", () => {
    it("derives outcome from matchedRules and executes forward + notify", async () => {
      const signal = makeExistingSignal({
        data: {
          matchedRules: [
            {
              ruleId: "rule-fwd",
              actions: [{ type: "forward", value: "backup@personal.com" }],
              labelsAdded: [],
            },
          ],
        },
      });
      const arc = makeExistingArc();

      const payload = makeSideEffectPayload({ signal, arc });

      const result = await processor.processSideEffect(payload);

      // No failures (side-effect handler does not return batchItemFailure for execution errors)
      expect(result.isOk()).toBe(true);

      // Forward was called with the address from matchedRules
      expect(forwardingService.forward).toHaveBeenCalledOnce();
      expect(forwardingService.forward).toHaveBeenCalledWith(
        "backup@personal.com",
        expect.objectContaining({ id: signal.id, accountId: TEST_ACCOUNT_ID }),
        expect.objectContaining({ id: arc.id, accountId: TEST_ACCOUNT_ID }),
      );

      // Notification was sent (no suppress_notification action)
      expect(notifier.notify).toHaveBeenCalledOnce();
      expect(notifier.notify).toHaveBeenCalledWith(TEST_ACCOUNT_ID, arc, signal, "normal");
    });

    it("executes pong when doPong action is present", async () => {
      const signal = makeExistingSignal({
        data: {
          matchedRules: [
            {
              ruleId: "rule-pong",
              actions: [{ type: "pong" }],
              labelsAdded: [],
            },
          ],
        },
      });
      const arc = makeExistingArc();

      const payload = makeSideEffectPayload({ signal, arc });

      const result = await processor.processSideEffect(payload);

      expect(result.isOk()).toBe(true);
      expect(replySender.sendReply).toHaveBeenCalledOnce();
      expect(replySender.sendReply).toHaveBeenCalledWith(expect.objectContaining({
        to: signal.data.from.address,
        from: `noreply@${process.env["MAIL_DOMAIN"] ?? "platform.email.rhosys.cloud"}`,
      }));
    });

    it("suppresses notification when suppress_notification action is present", async () => {
      const signal = makeExistingSignal({
        data: {
          matchedRules: [
            {
              ruleId: "rule-suppress",
              actions: [{ type: "suppress_notification" }],
              labelsAdded: [],
            },
          ],
        },
      });
      const arc = makeExistingArc();

      const payload = makeSideEffectPayload({ signal, arc });

      await processor.processSideEffect(payload);

      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it("does not invoke inbound signal pipeline for side-effect messages", async () => {
      const signal = makeExistingSignal();
      const arc = makeExistingArc();

      const payload = makeSideEffectPayload({ signal, arc });

      await processor.processSideEffect(payload);

      // None of the inbound signal pipeline was invoked
      expect(contentSanitizer.invoke).not.toHaveBeenCalled();
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(embeddingGenerator.generateForModel).not.toHaveBeenCalled();
      expect(threadDb.getSignalByMessageId).not.toHaveBeenCalled();
      expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Resource upsert — post-signal-save hook (processor.ts, right after saveSignal)
  // -------------------------------------------------------------------------

  describe("resource upsert", () => {
    it("saves a resource for a package-workflow signal with a date + orderNumber", async () => {
      vi.mocked(classifier.classify).mockResolvedValue(ok({
        workflow: "package",
        workflowData: {
          workflow: "package",
          packageType: "shipping",
          retailer: "Amazon",
          orderNumber: "123-456-789",
          estimatedDelivery: "2024-01-20T00:00:00Z",
        },
        tags: [],
        summary: "Your package is on its way.",
        labels: [],
        actions: [],
      }));

      const message = makeMessage({});
      const result = await processor.processInbound(message, 1);

      expect(result.isOk()).toBe(true);
      expect(resourceDb.saveResource).toHaveBeenCalledOnce();
      const call = resourceDb.saveResource.mock.calls[0]![0];
      expect(call).toMatchObject({
        workflow: "package",
        resourceKey: "123-456-789",
        expectedResolutionDate: "2024-01-20T00:00:00Z",
      });
      expect(call).not.toHaveProperty("terminal");

      // Resource save happens after the signal save, not before.
      const signalOrder = vi.mocked(threadDb.saveSignal).mock.invocationCallOrder[0]!;
      const resourceOrder = resourceDb.saveResource.mock.invocationCallOrder[0]!;
      expect(resourceOrder).toBeGreaterThan(signalOrder);
    });

    it("saves the same shape for a delivered package as any other packageType — completion is never inferred here", async () => {
      vi.mocked(classifier.classify).mockResolvedValue(ok({
        workflow: "package",
        workflowData: {
          workflow: "package",
          packageType: "delivered",
          retailer: "Amazon",
          orderNumber: "123-456-789",
          estimatedDelivery: "2024-01-20T00:00:00Z",
        },
        tags: [],
        summary: "Your package was delivered.",
        labels: [],
        actions: [],
      }));

      await processor.processInbound(makeMessage({}), 1);

      expect(resourceDb.saveResource).toHaveBeenCalledOnce();
      expect(resourceDb.saveResource.mock.calls[0]![0]).toMatchObject({
        resourceKey: "123-456-789",
        expectedResolutionDate: "2024-01-20T00:00:00Z",
      });
    });

    it("does not save a resource for a workflow with no forward-looking date (conversation)", async () => {
      // Default classifier mock already returns "conversation".
      await processor.processInbound(makeMessage({}), 1);

      expect(threadDb.saveSignal).toHaveBeenCalled();
      expect(resourceDb.saveResource).not.toHaveBeenCalled();
    });

    it("floors resource ttl at expectedResolutionDate + 1yr even when the signal's own ttl is shorter", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      applyCtx(accountDb, { ...DEFAULT_CTX, retentionDuration: "P3M" });
      vi.mocked(classifier.classify).mockResolvedValue(ok({
        workflow: "package",
        workflowData: {
          workflow: "package", packageType: "shipping", retailer: "Amazon",
          orderNumber: "123-456-789", estimatedDelivery: "2030-01-20T00:00:00Z",
        },
        tags: [], summary: "Your package is on its way.", labels: [], actions: [],
      }));

      await processor.processInbound(makeMessage({}), 1);

      const call = resourceDb.saveResource.mock.calls[0]![0];
      // Signal ttl (P3M from 2024-01-01) is far short of 2030-01-20 + 1yr — the floor must win.
      const expectedFloor = Math.floor(new Date("2031-01-20T00:00:00Z").getTime() / 1000);
      expect(call.ttl).toBe(expectedFloor);

      vi.useRealTimers();
    });

    it("still sets resource ttl (floor only) when the account has unlimited retention (no signal ttl)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      applyCtx(accountDb, { ...DEFAULT_CTX, retentionDuration: "Infinity" });
      vi.mocked(classifier.classify).mockResolvedValue(ok({
        workflow: "package",
        workflowData: {
          workflow: "package", packageType: "shipping", retailer: "Amazon",
          orderNumber: "123-456-789", estimatedDelivery: "2025-06-01T00:00:00Z",
        },
        tags: [], summary: "Your package is on its way.", labels: [], actions: [],
      }));

      await processor.processInbound(makeMessage({}), 1);

      const call = resourceDb.saveResource.mock.calls[0]![0];
      const expectedFloor = Math.floor(new Date("2026-06-01T00:00:00Z").getTime() / 1000);
      expect(call.ttl).toBe(expectedFloor);

      vi.useRealTimers();
    });
  });
});
