import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, Notifier,  SideEffectPayload } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Signal, Thread, Alias, AliasSender } from "../../src/types/index.js";
import { dbError } from "../../src/errors.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";

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


describe("Side effect caller logging", () => {
  const TEST_ACCOUNT_ID = "acct-side-effect";

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

  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  function makeStore() {
    return { threadDb: makeThreadDbMock(), accountDb: makeAccountDbMock(TEST_ACCOUNT_ID), processingDb: makeProcessingDbMock() };
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

  function makeEmbeddingGenerator(): EmbeddingGenerator {
    return {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };
  }

  function makeAuroraWriter(): MultiClusterAuroraWriter {
    return { upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)), findMatch: vi.fn().mockResolvedValue(ok(null)) };
  }

  function makeThreadMatcher(): ThreadMatcherPort {
    return { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
  }

  function makeSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
    const { data: dataOverrides, ...baseOverrides } = overrides;
    return {
      id: "sgn-testmsg001",
      signalLookupId: "ses-test-msg",
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
        subject: "Test email",
        textBody: "Hello world",
        attachments: [],
        headers: {},
        recipientAddress: "user@example.com",
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        tags: [],
        summary: "A test email.",
        s3Key: "emails/test-msg",
        matchedRules: [],
        ...dataOverrides,
      },
    } as Signal;
  }

  function makeThread(): Thread {
    return {
      id: "arc-test",
      accountId: TEST_ACCOUNT_ID,
      workflow: "conversation",
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

  it("when notifier.notify() returns err, caller logs at track level", async () => {
    const notifier: Notifier = {
      notify: vi.fn().mockReturnValue(Promise.resolve(err(dbError(new Error("push failed"))))),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }) } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }) } as never,
      classifier: { classify: vi.fn().mockResolvedValue(ok({ workflow: "conversation", workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false }, tags: [], summary: "A test email.", labels: [] })) },
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      threadMatcher: makeThreadMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      notifier,
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      logger: mockLogger,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    // Side-effects are now executed via processSideEffect, not processRecord
    const payload: SideEffectPayload = { signal: makeSignal(), thread: makeThread() };
    await processor.processSideEffect(payload);

    const sideEffectLog = mockLogger.calls.find((call) =>
      call.context?.code === "processor.side_effect.notify_failed" &&
      (call.method === "track" || call.method === "error"),
    );
    expect(sideEffectLog).toBeDefined();
  });

  it("when notifier.notify() succeeds, no failure log is emitted", async () => {
    const notifier: Notifier = {
      notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }) } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }) } as never,
      classifier: { classify: vi.fn().mockResolvedValue(ok({ workflow: "conversation", workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false }, tags: [], summary: "A test email.", labels: [] })) },
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      threadMatcher: makeThreadMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      notifier,
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      logger: mockLogger,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    const payload: SideEffectPayload = { signal: makeSignal(), thread: makeThread() };
    await processor.processSideEffect(payload);

    const sideEffectLog = mockLogger.calls.find((call) =>
      call.context?.code === "processor.side_effect.notify_failed",
    );
    expect(sideEffectLog).toBeUndefined();
  });

  it("when forwarder.forward() returns err, caller logs at track level", async () => {
    const forwardingService: IForwardingService = {
      forward: vi.fn().mockReturnValue(Promise.resolve(err(dbError(new Error("forward failed"))))),
      sendVerification: vi.fn().mockResolvedValue(ok(undefined)),
      verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)),
    };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://signed-url"), getObject: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://post-url", fields: {} }) } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://signed-url"), getObject: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://post-url", fields: {} }) } as never,
      classifier: { classify: vi.fn().mockResolvedValue(ok({ workflow: "conversation", workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false }, tags: [], summary: "A test email.", labels: [] })) },
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      threadMatcher: makeThreadMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      forwardingService,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      logger: mockLogger,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });

    // Signal with a forward action in matchedRules
    const signal = makeSignal({
      data: { matchedRules: [{ ruleId: "rule-fwd", actions: [{ type: "forward", value: "fwd@example.com" }], labelsAdded: [] }] },
    });
    const payload: SideEffectPayload = { signal, thread: makeThread() };
    await processor.processSideEffect(payload);

    const sideEffectLog = mockLogger.calls.find((call) =>
      call.context?.code === "processor.side_effect.forward_failed" &&
      (call.method === "track" || call.method === "error"),
    );
    expect(sideEffectLog).toBeDefined();
  });
});
