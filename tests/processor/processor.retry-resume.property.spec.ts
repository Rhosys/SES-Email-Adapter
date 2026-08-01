import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, InboundSignalMessage, SqsDispatcher } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Signal, Thread, Alias, AliasSender, Workflow } from "../../src/types/index.js";
import { dbError } from "../../src/errors.js";
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
  };
});


// ---------------------------------------------------------------------------
// Property 1: Resume from prior state on retry
// **Validates: Requirements 1.1, 1.2**
// ---------------------------------------------------------------------------

/**
 * For any signal that exists in DDB when receiveCount > 1, the processor SHALL
 * read the signal and its arc from DDB, then execute Aurora upserts and dispatch
 * side-effects, without re-parsing, re-classifying, or re-evaluating rules.
 */
describe("Feature: signal-processor-retry-resilience, Property 1: Resume from prior state on retry", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop1";

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

  // -------------------------------------------------------------------------
  // Edge-case inputs
  // -------------------------------------------------------------------------

  // receiveCount values that matter for branching:
  // - 2: first retry (enters retry path, `receiveCount > 1`)
  // - 30: at RETRY_TRACK_THRESHOLD (still logs at warn level)
  // - 31: exceeds threshold (logs at error level on failure)
  const RECEIVE_COUNTS = [2, 30, 31] as const;

  // Embedding variations that exercise different Aurora upsert paths:
  // - valid embedding: normal upsert path
  // - undefined embeddings: Aurora upsert skipped for all clusters
  // - wrong model key: Aurora upsert skipped (no matching modelId)
  const SIGNAL_VARIANTS: Array<{ label: string; signal: Signal }> = [
    {
      label: "valid embedding for cluster model",
      signal: {
        id: "sgn-validEmb000000000000abc",
        signalLookupId: "ses-msg-valid-emb",
        threadId: "arc-valid-emb",
        accountId: TEST_ACCOUNT_ID,
        source: "email" as const,
        type: "email" as const,
        status: "active" as const,
        labels: [],
        createdAt: "2024-01-15T10:00:00Z",
        data: {
          receivedAt: "2024-01-15T10:00:00Z",
          from: { address: "sender@external.com", name: "Sender" },
          to: [{ address: "user@example.com" }],
          cc: [],
          subject: "Test email",
          textBody: "Hello world",
          attachments: [],
          headers: {},
          recipientAddress: "user@example.com",
          workflow: "conversation" as Workflow,
          workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
          tags: [],
          summary: "A test email.",
          s3Key: "emails/msg-valid-emb",
          actions: [],
          embeddings: { "amazon.titan-embed-text-v2:0": [0.1, -0.5, 0.3] },
          matchedRules: [],
        },
      } as Signal,
    },
    {
      label: "embeddings undefined (Aurora upsert skipped)",
      signal: {
        id: "sgn-noEmb0000000000000000abc",
        signalLookupId: "ses-msg-no-emb",
        threadId: "arc-no-emb",
        accountId: TEST_ACCOUNT_ID,
        source: "email" as const,
        type: "email" as const,
        status: "active" as const,
        labels: [],
        createdAt: "2024-01-15T10:00:00Z",
        data: {
          receivedAt: "2024-01-15T10:00:00Z",
          from: { address: "sender@external.com", name: "Sender" },
          to: [{ address: "user@example.com" }],
          cc: [],
          subject: "Test email",
          textBody: "Hello world",
          attachments: [],
          headers: {},
          recipientAddress: "user@example.com",
          workflow: "conversation" as Workflow,
          workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
          tags: [],
          summary: "A test email.",
          s3Key: "emails/msg-no-emb",
          actions: [],
          matchedRules: [],
        },
      } as unknown as Signal,
    },
    {
      label: "embedding for wrong model (Aurora upsert skipped for cluster)",
      signal: {
        id: "sgn-wrongModel00000000000abc",
        signalLookupId: "ses-msg-wrong-model",
        threadId: "arc-wrong-model",
        accountId: TEST_ACCOUNT_ID,
        source: "email" as const,
        type: "email" as const,
        status: "active" as const,
        labels: [],
        createdAt: "2024-01-15T10:00:00Z",
        data: {
          receivedAt: "2024-01-15T10:00:00Z",
          from: { address: "sender@external.com", name: "Sender" },
          to: [{ address: "user@example.com" }],
          cc: [],
          subject: "Test email",
          textBody: "Hello world",
          attachments: [],
          headers: {},
          recipientAddress: "user@example.com",
          workflow: "conversation" as Workflow,
          workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
          tags: [],
          summary: "A test email.",
          s3Key: "emails/msg-wrong-model",
          actions: [],
          embeddings: { "cohere.embed-english-v3": [0.1, 0.2, 0.3] },
          matchedRules: [],
        },
      } as Signal,
    },
  ];

  // Build test cases: cross-product of signal variants × receive counts
  const RETRY_CASES = SIGNAL_VARIANTS.flatMap(({ label, signal }) =>
    RECEIVE_COUNTS.map((rc) => ({
      label: `${label}, receiveCount=${rc}`,
      signal,
      receiveCount: rc,
    })),
  );

  function arbArcForSignal(signal: Signal): Thread {
    return {
      id: signal.threadId!,
      accountId: signal.accountId,
      workflow: signal.data.workflow,
      labels: [],
      status: "active",
      summary: signal.data.summary,
      lastSignalAt: signal.data.receivedAt,
      createdAt: signal.data.receivedAt,
      updatedAt: signal.data.receivedAt,
      sender: { address: "sender@example.com" },
      recipientAddress: "user@example.com",
      subject: "Test email",
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

  function makeStore(signal: Signal, arc: Thread) {
    const threadDb = {
      ...makeThreadDbMock(),
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      getThread: vi.fn().mockReturnValue(Promise.resolve(ok(arc))),
    } as unknown as ThreadDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    const processingDb = makeProcessingDbMock();
    return { threadDb, accountDb, processingDb };
  }

  function makeAuroraWriter(): MultiClusterAuroraWriter {
    return {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };
  }

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  it.each(RETRY_CASES)("MIME parser is NOT called on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const messageId = signal.signalLookupId.slice(4);
    const contentSanitizer: ContentSanitizerClient = { invoke: vi.fn() };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(signal, arc),
      contentSanitizer, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
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

    await processor.processRecord(makeMessage(messageId), receiveCount);
    expect(contentSanitizer.invoke).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES)("classifier is NOT called on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const messageId = signal.signalLookupId.slice(4);
    const classifier: Pick<SignalClassifier, "classify"> = { classify: vi.fn() };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier,
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
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

    await processor.processRecord(makeMessage(messageId), receiveCount);
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES)("rule evaluation is NOT called on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const messageId = signal.signalLookupId.slice(4);
    const ruleEvaluator = makeRuleEvaluator3(mockLogger);
    const evaluateSpy = vi.spyOn(ruleEvaluator, "evaluate");

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator,
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processRecord(makeMessage(messageId), receiveCount);
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES.filter(c => c.signal.data.embeddings?.["amazon.titan-embed-text-v2:0"]))("Aurora upserts ARE called with the signal's cached embeddings on retry ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const messageId = signal.signalLookupId.slice(4);
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
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

    await processor.processRecord(makeMessage(messageId), receiveCount);

    expect(auroraWriter.upsertEmbedding).toHaveBeenCalled();
    const call = vi.mocked(auroraWriter.upsertEmbedding).mock.calls[0]!;
    expect(call[0]).toMatchObject({
      threadId: arc.id,
      accountId: signal.accountId,
      embedding: signal.data.embeddings!["amazon.titan-embed-text-v2:0"],
    });
  });

  it.each(RETRY_CASES.filter(c => !c.signal.data.embeddings?.["amazon.titan-embed-text-v2:0"]))("Aurora upsert is SKIPPED when embedding is missing for cluster model ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const messageId = signal.signalLookupId.slice(4);
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
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

    await processor.processRecord(makeMessage(messageId), receiveCount);

    // Aurora upsert is NOT called when embedding is missing for the cluster's model
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
  });

  it.each(RETRY_CASES)("result is NOT a batchItemFailure on retry when signal exists in DDB ($label)", async ({ signal, receiveCount }) => {
    const arc = arbArcForSignal(signal);
    const messageId = signal.signalLookupId.slice(4);

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(signal, arc),
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: makeAuroraWriter(),
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
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

    const result = await processor.processRecord(makeMessage(messageId), receiveCount);
    expect(result.isOk()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Boundary: threadId falsy on retry → early error return
  // The code checks `if (!signal.threadId) return err(processError(...))`
  // -------------------------------------------------------------------------

  const FALSY_THREAD_ID_CASES = [
    { label: "threadId=undefined (signal saved before thread assignment)", threadId: undefined },
    { label: "threadId='' (empty string — falsy)", threadId: "" },
  ] as const;

  it.each(FALSY_THREAD_ID_CASES)("returns batchItemFailure when signal exists but $label", async ({ threadId: testThreadId }) => {
    const signal: Signal = {
      id: "sgn-noArc000000000000000abc",
      signalLookupId: "ses-msg-no-arc",
      threadId: testThreadId as string | undefined,
      accountId: TEST_ACCOUNT_ID,
      source: "email" as const,
      type: "email" as const,
      status: "active" as const,
      labels: [],
      createdAt: "2024-01-15T10:00:00Z",
      data: {
        receivedAt: "2024-01-15T10:00:00Z",
        from: { address: "sender@external.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Test email",
        textBody: "Hello world",
        attachments: [],
        headers: {},
        recipientAddress: "user@example.com",
        workflow: "conversation" as Workflow,
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
        tags: [],
        summary: "A test email.",
        s3Key: "emails/msg-no-arc",
        actions: [],
        embeddings: { "amazon.titan-embed-text-v2:0": [0.1, 0.2] },
        matchedRules: [],
      },
    } as Signal;

    const threadDb = {
      ...makeThreadDbMock(),
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
    } as unknown as ThreadDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    const processingDb = makeProcessingDbMock();

    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      threadDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
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

    const result = await processor.processRecord(makeMessage("msg-no-arc"), 2);

    expect(result.isErr()).toBe(true);
    // No Aurora upserts should execute when threadId is falsy
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    // No DDB writes should execute
    expect(threadDb.saveSignal).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// Property 3: DDB read failure on retry returns batchItemFailure without writes
// **Validates: Requirements 1.5**
// ---------------------------------------------------------------------------

/**
 * For any retry attempt where the DDB read for the signal or arc record fails,
 * the processor SHALL return the record as a batchItemFailure without executing
 * any Aurora upserts, side-effect dispatches, or DDB writes.
 */
describe("Feature: signal-processor-retry-resilience, Property 3: DDB read failure on retry returns batchItemFailure without writes", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop3";

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

  function makeRetryMessage(messageId: string): InboundSignalMessage {
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

  function makeExistingSignal(messageId: string): Signal {
    return {
      id: `sgn-${messageId}`,
      signalLookupId: `ses-${messageId}`,
      accountId: TEST_ACCOUNT_ID,
      threadId: "arc-existing",
      source: "email",
      type: "email",
      status: "active",
      labels: [],
      createdAt: "2024-01-15T10:00:01Z",
      data: {
        from: { address: "sender@external.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        attachments: [],
        headers: {},
        recipientAddress: "user@example.com",
        subject: "Test email",
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        tags: [],
        summary: "A test email.",
        s3Key: `emails/${messageId}`,
        actions: [],
        matchedRules: [],
        receivedAt: "2024-01-15T10:00:00Z",
        embeddings: { "amazon.titan-embed-text-v2:0": new Array(10).fill(0.1) },
      },
    } as Signal;
  }

  function makeAuroraWriter(): MultiClusterAuroraWriter {
    return {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };
  }

  function makeStore(overrides: { getSignalByMessageId?: unknown; getThread?: unknown } = {}) {
    const threadDb = {
      ...makeThreadDbMock(),
      ...(overrides.getSignalByMessageId ? { getSignalByMessageId: overrides.getSignalByMessageId } : {}),
      ...(overrides.getThread ? { getThread: overrides.getThread } : {}),
    } as unknown as ThreadDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    const processingDb = makeProcessingDbMock();
    return { threadDb, accountDb, processingDb };
  }

  // -------------------------------------------------------------------------
  // Edge-case inputs
  // -------------------------------------------------------------------------

  const DDB_ERRORS = [
    { label: "connection timeout", error: dbError(new Error("DDB error: Connection timeout")) },
    { label: "throughput exceeded", error: dbError(new Error("DDB error: ProvisionedThroughputExceededException")) },
  ] as const;

  // receiveCount values that exercise different log-level branches on failure:
  // - 2: first retry (warn level)
  // - 30: at threshold (warn level — threshold is >30)
  // - 31: exceeds threshold (error level)
  const RETRY_RECEIVE_COUNTS = [2, 30, 31] as const;

  const SES_MESSAGE_IDS = ["abc123", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"] as const;

  const SIGNAL_READ_FAILURE_CASES = DDB_ERRORS.flatMap(({ label: errLabel, error }) =>
    RETRY_RECEIVE_COUNTS.flatMap((rc) =>
      SES_MESSAGE_IDS.map((msgId) => ({
        label: `error="${errLabel}", receiveCount=${rc}, msgId="${msgId}"`,
        error,
        receiveCount: rc,
        messageId: msgId,
      })),
    ),
  );

  const ARC_READ_FAILURE_CASES = DDB_ERRORS.flatMap(({ label: errLabel, error }) =>
    RETRY_RECEIVE_COUNTS.map((rc) => ({
      label: `error="${errLabel}", receiveCount=${rc}`,
      error,
      receiveCount: rc,
      messageId: "test-msg-arc-fail",
    })),
  );

  it.each(SIGNAL_READ_FAILURE_CASES)("signal read failure returns batchItemFailure without Aurora upserts or DDB writes ($label)", async ({ error, receiveCount, messageId }) => {
    const { threadDb, accountDb, processingDb } = makeStore({
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(err(error))),
    });
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      threadDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
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

    const result = await processor.processRecord(makeRetryMessage(messageId), receiveCount);

    expect(result.isErr()).toBe(true);
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    expect(threadDb.saveSignal).not.toHaveBeenCalled();
    expect(threadDb.saveThread).not.toHaveBeenCalled();
  });

  it.each(ARC_READ_FAILURE_CASES)("arc read failure returns batchItemFailure without Aurora upserts or DDB writes ($label)", async ({ error, receiveCount, messageId }) => {
    const existingSignal = makeExistingSignal(messageId);
    const { threadDb, accountDb, processingDb } = makeStore({
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(existingSignal))),
      getThread: vi.fn().mockReturnValue(Promise.resolve(err(error))),
    });
    const auroraWriter = makeAuroraWriter();

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      threadDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter,
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
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

    const result = await processor.processRecord(makeRetryMessage(messageId), receiveCount);

    expect(result.isErr()).toBe(true);
    expect(auroraWriter.upsertEmbedding).not.toHaveBeenCalled();
    expect(threadDb.saveSignal).not.toHaveBeenCalled();
    expect(threadDb.saveThread).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// Property 2: Missing signal on retry triggers fresh processing
// **Validates: Requirements 1.3**
// ---------------------------------------------------------------------------

/**
 * For any SQS record with receiveCount > 1 where the signal does NOT exist
 * in DDB, the processor SHALL execute the full first-attempt pipeline (parse,
 * classify, match, save) identically to a first delivery.
 */
describe("Feature: signal-processor-retry-resilience, Property 2: Missing signal on retry triggers fresh processing", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop2";

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

  const validClassification = {
    workflow: "conversation" as const,
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
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
  // Edge-case inputs
  // -------------------------------------------------------------------------

  const MISSING_SIGNAL_CASES = [
    { label: "receiveCount=2 (first retry — enters retry path, falls through to full pipeline)", receiveCount: 2, messageId: "msg-missing-first-retry" },
    { label: "receiveCount=30 (at threshold — still warn level on failure)", receiveCount: 30, messageId: "msg-missing-at-threshold" },
    { label: "receiveCount=31 (exceeds threshold — error level on failure)", receiveCount: 31, messageId: "msg-missing-over-threshold" },
  ] as const;

  it.each(MISSING_SIGNAL_CASES)("MIME parser IS called when signal does not exist on retry ($label)", async ({ receiveCount, messageId }) => {
    const contentSanitizer = makeContentSanitizer();

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
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

    await processor.processRecord(makeMessage(messageId), receiveCount);
    expect(contentSanitizer.invoke).toHaveBeenCalled();
  });

  it.each(MISSING_SIGNAL_CASES)("classifier IS called when signal does not exist on retry ($label)", async ({ receiveCount, messageId }) => {
    const classifier = makeClassifier();

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier,
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
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

    await processor.processRecord(makeMessage(messageId), receiveCount);
    expect(classifier.classify).toHaveBeenCalled();
  });

  it.each(MISSING_SIGNAL_CASES)("saveArc and saveSignal ARE called when signal does not exist on retry ($label)", async ({ receiveCount, messageId }) => {
    const { threadDb, accountDb, processingDb } = makeStore();

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      threadDb, accountDb, processingDb,
      contentSanitizer: makeContentSanitizer(), emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
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

    await processor.processRecord(makeMessage(messageId), receiveCount);
    expect(threadDb.saveThread).toHaveBeenCalled();
    expect(threadDb.saveSignal).toHaveBeenCalled();
  });

  it.each(MISSING_SIGNAL_CASES)("result is NOT a batchItemFailure when signal does not exist on retry ($label)", async ({ receiveCount, messageId }) => {
    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
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

    const result = await processor.processRecord(makeMessage(messageId), receiveCount);
    expect(result.isOk()).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Property 8: Outcome re-derived from persisted matchedRules on retry
// **Validates: Requirements 4.1**
// ---------------------------------------------------------------------------

/**
 * For any signal that exists in DDB on retry, the processor SHALL call
 * `deriveOutcome()` with the signal's persisted `matchedRules` field to
 * reconstruct the processing outcome, rather than re-evaluating rules against
 * the current rule set.
 */
describe("Feature: signal-processor-retry-resilience, Property 8: Outcome re-derived from persisted matchedRules on retry", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-prop8";

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

  // -------------------------------------------------------------------------
  // Edge-case inputs for matchedRules
  // -------------------------------------------------------------------------

  const MATCHED_RULES_CASES = [
    {
      label: "empty matchedRules (no actions — default outcome)",
      matchedRules: [],
    },
    {
      label: "single forward action (triggers side-effect dispatch)",
      matchedRules: [{ ruleId: "rule-1", actions: [{ type: "forward", value: "fwd@example.com" }], labelsAdded: [], statusChange: undefined }],
    },
    {
      label: "pong action (triggers test reply side-effect)",
      matchedRules: [{ ruleId: "rule-pong", actions: [{ type: "pong" }], labelsAdded: [], statusChange: undefined }],
    },
    {
      label: "suppress_notification (suppresses notify side-effect)",
      matchedRules: [{ ruleId: "rule-suppress", actions: [{ type: "suppress_notification" }], labelsAdded: [], statusChange: undefined }],
    },
    {
      label: "block action (first-wins status: blocked)",
      matchedRules: [{ ruleId: "rule-block", actions: [{ type: "block" }], labelsAdded: [], statusChange: "blocked" as const }],
    },
    {
      label: "conflicting status actions (first-wins: block beats archive)",
      matchedRules: [
        { ruleId: "rule-block", actions: [{ type: "block" }], labelsAdded: [], statusChange: "blocked" as const },
        { ruleId: "rule-archive", actions: [{ type: "archive" }], labelsAdded: [], statusChange: "archived" as const },
      ],
    },
    {
      label: "multiple non-status actions (forward + label + suppress)",
      matchedRules: [
        { ruleId: "rule-fwd", actions: [{ type: "forward", value: "fwd@example.com" }, { type: "assign_label", value: "urgent" }], labelsAdded: ["urgent"], statusChange: undefined },
        { ruleId: "rule-suppress", actions: [{ type: "suppress_notification" }], labelsAdded: [], statusChange: undefined },
      ],
    },
  ] as const;

  // Only test receive counts that exercise different code paths
  const RECEIVE_COUNTS = [2, 31] as const;

  const PROP8_CASES = MATCHED_RULES_CASES.flatMap(({ label: ruleLabel, matchedRules }) =>
    RECEIVE_COUNTS.map((rc) => ({
      label: `${ruleLabel}, receiveCount=${rc}`,
      matchedRules,
      receiveCount: rc,
    })),
  );

  function makeSignalWithRules(matchedRules: readonly unknown[]): Signal {
    return {
      id: "sgn-prop8000000000000000abc",
      signalLookupId: "ses-msg-prop8",
      threadId: "arc-prop8",
      accountId: TEST_ACCOUNT_ID,
      source: "email" as const,
      type: "email" as const,
      status: "active" as const,
      labels: [],
      createdAt: "2024-01-15T10:00:00Z",
      data: {
        receivedAt: "2024-01-15T10:00:00Z",
        from: { address: "sender@external.com", name: "Sender" },
        to: [{ address: "user@example.com" }],
        cc: [],
        subject: "Test email with rules",
        textBody: "Hello world",
        attachments: [],
        headers: {},
        recipientAddress: "user@example.com",
        workflow: "conversation" as Workflow,
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false } as const,
        tags: [],
        summary: "A test email.",
        s3Key: "emails/msg-prop8",
        actions: [],
        embeddings: { "amazon.titan-embed-text-v2:0": [0.1, -0.5, 0.3] },
        matchedRules: matchedRules as Signal["data"]["matchedRules"],
      },
    } as Signal;
  }

  function makeThread(): Thread {
    return {
      id: "arc-prop8",
      accountId: TEST_ACCOUNT_ID,
      workflow: "conversation" as Workflow,
      labels: [],
      status: "active",
      summary: "A test email.",
      lastSignalAt: "2024-01-15T10:00:00Z",
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z",
      sender: { address: "sender@example.com" },
      recipientAddress: "user@example.com",
      subject: "Test email",
    };
  }

  function makeMessage(): InboundSignalMessage {
    return {
      s3Key: "emails/msg-prop8",
      compositeMailMessageId: "ses-msg-prop8",
      idempotencyKey: "test-idempotency-key",
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  it.each(PROP8_CASES)("listEnabledRules is NOT called on retry when signal exists in DDB ($label)", async ({ matchedRules, receiveCount }) => {
    const signal = makeSignalWithRules(matchedRules);
    const arc = makeThread();

    const threadDb = {
      ...makeThreadDbMock(),
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      getThread: vi.fn().mockReturnValue(Promise.resolve(ok(arc))),
    } as unknown as ThreadDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    const processingDb = makeProcessingDbMock();

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      threadDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: { upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)), findMatch: vi.fn().mockResolvedValue(ok(null)) },
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      sqsDispatcher,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processRecord(makeMessage(), receiveCount);
    expect(accountDb.listEnabledRules).not.toHaveBeenCalled();
  });

  it.each(PROP8_CASES)("dispatched side-effect payload contains the signal's persisted matchedRules ($label)", async ({ matchedRules, receiveCount }) => {
    const signal = makeSignalWithRules(matchedRules);
    const arc = makeThread();

    const threadDb = {
      ...makeThreadDbMock(),
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(signal))),
      getThread: vi.fn().mockReturnValue(Promise.resolve(ok(arc))),
    } as unknown as ThreadDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    applyCtx(accountDb, DEFAULT_CTX);
    const processingDb = makeProcessingDbMock();

    const sqsDispatcher: SqsDispatcher = {
      sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      threadDb, accountDb, processingDb,
      contentSanitizer: { invoke: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForSecondaryClusters: vi.fn(), generateForModel: vi.fn() },
      auroraWriter: { upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)), findMatch: vi.fn().mockResolvedValue(ok(null)) },
      threadMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      sqsDispatcher,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    await processor.processRecord(makeMessage(), receiveCount);

    expect(sqsDispatcher.sendMessage).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(sqsDispatcher.sendMessage).mock.calls[0]![0];
    expect(payload.signal.data.matchedRules).toEqual(signal.data.matchedRules);
  });
});
