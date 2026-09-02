import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, SqsDispatcher, Notifier, ReplySender, SideEffectPayload } from "../../src/processor/processor.js";
import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { S3RetentionService } from "../../src/embedding/s3-retention-service.js";
import type { Signal, Thread, Alias } from "../../src/types/index.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";

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
// Constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-webhook-test";

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

// ---------------------------------------------------------------------------
// Test double factories
// ---------------------------------------------------------------------------

function makeStore(billingPlan: "Paid" | "Free" | "Trial" = "Paid") {
  const threadDb = makeThreadDbMock();
  const accountDb = {
    ...makeAccountDbMock(TEST_ACCOUNT_ID),
    getAccount: vi.fn().mockReturnValue(Promise.resolve(ok({
      retentionDuration: "P3M",
      filtering: null,
      billingPlan,
      onboarding: { completed: true },
    }))),
    getSender: vi.fn().mockReturnValue(Promise.resolve(ok({
      accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com",
      domain: "example.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z",
    }))),
  } as unknown as AccountDatabase;
  const processingDb = makeProcessingDbMock();
  return { threadDb, accountDb, processingDb };
}

function makeSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "sgn-webhook-test-001",
    signalLookupId: "ses-webhook-msg-001",
    threadId: "arc-webhook-001",
    accountId: TEST_ACCOUNT_ID,
    source: "email",
    type: "email",
    status: "active",
    createdAt: "2024-06-15T10:30:00.000Z",
    ...baseOverrides,
    data: {
      receivedAt: "2024-06-15T10:30:00.000Z",
      from: { address: "sender@example.com", name: "Alice" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Webhook test email",
      textBody: "Hello from webhook test",
      attachments: [],
      headers: {},
      recipientAddress: "user@example.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "A webhook test signal.",
      s3Key: "emails/webhook-test.eml",
      embeddings: {},
      matchedRules: [],
      ...dataOverrides,
    },
  } as Signal;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "arc-webhook-001",
    accountId: TEST_ACCOUNT_ID,
    workflow: "conversation",
    labels: ["system:workflow:conversation"],
    status: "active",
    summary: "Webhook test arc.",
    lastSignalAt: "2024-06-15T10:30:00.000Z",
    createdAt: "2024-06-01T00:00:00Z",
    updatedAt: "2024-06-15T10:30:00.000Z",
    sender: { address: "sender@example.com" },
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

function makeProcessor(opts: { store: ReturnType<typeof makeStore>; logger: MockLogger; forwardingService?: IForwardingService }): SignalProcessor {
  return new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
    ...opts.store,
    contentSanitizer: { invoke: vi.fn() } as unknown as ContentSanitizerClient,
    classifier: { classify: vi.fn() } as unknown as Pick<SignalClassifier, "classify">,
    embeddingGenerator: { generateForModel: vi.fn(), generateForSecondaryClusters: vi.fn() } as unknown as EmbeddingGenerator,
    auroraWriter: { upsertEmbedding: vi.fn(), findMatch: vi.fn() } as unknown as MultiClusterAuroraWriter,
    threadMatcher: { findMatch: vi.fn(), upsertEmbedding: vi.fn(), deleteEmbeddingsForThread: vi.fn() } as unknown as ThreadMatcherPort,
    ruleEvaluator: makeRuleEvaluator3(opts.logger),
    logger: opts.logger,
    retentionService: { applyPlanRetention: vi.fn() } as unknown as S3RetentionService,
    sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as SqsDispatcher,
    notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as Notifier,
    forwardingService: opts.forwardingService ?? { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as IForwardingService,
    replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "msg-001" })) } as unknown as ReplySender,
    draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    billingHandler: new BillingHandler(),
    emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
    contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
  });
}

// ---------------------------------------------------------------------------
// Tests: Forward action dispatches through ForwardingService
// (Webhook delivery is now internal to ForwardingService)
// ---------------------------------------------------------------------------

describe("processSideEffect — forward dispatches to ForwardingService", () => {
  let mockLogger: MockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forward fires after notify completes", async () => {
    const store = makeStore("Paid");
    const forwarder = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) };
    const notifier = { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };

    const processor = new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...store,
      contentSanitizer: { invoke: vi.fn() } as unknown as ContentSanitizerClient,
      classifier: { classify: vi.fn() } as unknown as Pick<SignalClassifier, "classify">,
      embeddingGenerator: { generateForModel: vi.fn(), generateForSecondaryClusters: vi.fn() } as unknown as EmbeddingGenerator,
      auroraWriter: { upsertEmbedding: vi.fn(), findMatch: vi.fn() } as unknown as MultiClusterAuroraWriter,
      threadMatcher: { findMatch: vi.fn(), upsertEmbedding: vi.fn(), deleteEmbeddingsForThread: vi.fn() } as unknown as ThreadMatcherPort,
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      retentionService: { applyPlanRetention: vi.fn() } as unknown as S3RetentionService,
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as SqsDispatcher,
      notifier: notifier as unknown as Notifier,
      forwardingService: forwarder as unknown as IForwardingService,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "msg-001" })) } as unknown as ReplySender,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
      billingHandler: new BillingHandler(),
      emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
    });

    const signal = makeSignal({
      data: {
        matchedRules: [
          { ruleId: "rule-fwd", actions: [{ type: "forward", value: "backup@personal.com" }], labelsAdded: [] },
        ],
      },
    });
    const thread = makeThread();
    const payload: SideEffectPayload = { signal, thread };

    const result = await processor.processSideEffect(payload);

    expect(result.isOk()).toBe(true);

    // Forward and notify were called
    expect(forwarder.forward).toHaveBeenCalledOnce();
    expect(notifier.notify).toHaveBeenCalledOnce();

    // Verify forward was called with signal and thread
    const [targetId, fwdSignal, fwdThread] = forwarder.forward.mock.calls[0]!;
    expect(targetId).toBe("backup@personal.com");
    expect(fwdSignal.id).toBe(signal.id);
    expect(fwdThread.id).toBe(thread.id);
  });

  it("multiple forward actions on same signal all fire", async () => {
    const store = makeStore("Paid");
    const forwarder = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) };
    const processor = makeProcessor({ store, logger: mockLogger, forwardingService: forwarder as unknown as IForwardingService });

    const signal = makeSignal({
      data: {
        matchedRules: [
          { ruleId: "rule-fwd-1", actions: [{ type: "forward", value: "first@example.com" }], labelsAdded: [] },
          { ruleId: "rule-fwd-2", actions: [{ type: "forward", value: "second@example.com" }], labelsAdded: [] },
        ],
      },
    });
    const thread = makeThread();
    const payload: SideEffectPayload = { signal, thread };

    const result = await processor.processSideEffect(payload);

    expect(result.isOk()).toBe(true);

    // Both forwards were called
    expect(forwarder.forward).toHaveBeenCalledTimes(2);
    const targets = forwarder.forward.mock.calls.map((c: unknown[]) => c[0]);
    expect(targets).toContain("first@example.com");
    expect(targets).toContain("second@example.com");
  });

  it("no forward actions — forwardingService.forward not called", async () => {
    const store = makeStore("Paid");
    const forwarder = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) };
    const processor = makeProcessor({ store, logger: mockLogger, forwardingService: forwarder as unknown as IForwardingService });

    const signal = makeSignal({
      data: {
        matchedRules: [
          { ruleId: "rule-label", actions: [{ type: "assign_label", value: "important" }], labelsAdded: ["important"] },
        ],
      },
    });
    const thread = makeThread();
    const payload: SideEffectPayload = { signal, thread };

    const result = await processor.processSideEffect(payload);

    expect(result.isOk()).toBe(true);
    expect(forwarder.forward).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: pong eligibility — ownership by registered domain OR account user email
//
// A test-workflow signal pongs only when the sender belongs to the account. Ownership is
// proven by the sender's eTLD+1 matching a registered domain, OR — the new fallback — by the
// sender's exact address matching the email of a user on the account (case-insensitive). This
// covers IMAP/JMAP onboarding, where the test lands on an alias whose domain the account never
// registered, but the sender is the account owner's personal address.
// ---------------------------------------------------------------------------

describe("processSideEffect — pong eligibility (sender ownership)", () => {
  let mockLogger: MockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeReplySenderSpy() {
    return { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "pong-msg-001" })) } as unknown as ReplySender;
  }

  function makeProcessorWithAccess(opts: {
    store: ReturnType<typeof makeStore>;
    replySender: ReplySender;
    accessService: { listUsers: ReturnType<typeof vi.fn>; getUserProfile: ReturnType<typeof vi.fn> };
    logger: MockLogger;
  }): SignalProcessor {
    return new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      accessService: opts.accessService as never,
      ...opts.store,
      contentSanitizer: { invoke: vi.fn() } as unknown as ContentSanitizerClient,
      classifier: { classify: vi.fn() } as unknown as Pick<SignalClassifier, "classify">,
      embeddingGenerator: { generateForModel: vi.fn(), generateForSecondaryClusters: vi.fn() } as unknown as EmbeddingGenerator,
      auroraWriter: { upsertEmbedding: vi.fn(), findMatch: vi.fn() } as unknown as MultiClusterAuroraWriter,
      threadMatcher: { findMatch: vi.fn(), upsertEmbedding: vi.fn(), deleteEmbeddingsForThread: vi.fn() } as unknown as ThreadMatcherPort,
      ruleEvaluator: makeRuleEvaluator3(opts.logger),
      logger: opts.logger,
      retentionService: { applyPlanRetention: vi.fn() } as unknown as S3RetentionService,
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as SqsDispatcher,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as Notifier,
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as IForwardingService,
      replySender: opts.replySender,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
      billingHandler: new BillingHandler(),
      emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
    });
  }

  // A test-workflow signal whose sender's domain is NOT a registered domain (listDomains → []).
  function makeImapTestSignal(fromAddress: string): Signal {
    return makeSignal({
      data: {
        from: { address: fromAddress, name: "Owner" },
        recipientAddress: "me@gmail.com",
        workflow: "test",
        workflowData: { workflow: "test" },
        subject: "Test",
        textBody: "ping",
        matchedRules: [],
      },
    });
  }

  it("pongs when the sender is not on a registered domain but matches an account user's email", async () => {
    const store = makeStore("Paid");
    // No registered domains — the domain ownership check must fail, forcing the user-email path.
    vi.mocked(store.accountDb.listDomains).mockResolvedValue(ok([]));
    const replySender = makeReplySenderSpy();
    const accessService = {
      listUsers: vi.fn().mockResolvedValue(ok([{ userId: "user-1", role: "admin" }])),
      getUserProfile: vi.fn().mockResolvedValue(ok({ email: "owner@personal.com" })),
    };
    const processor = makeProcessorWithAccess({ store, replySender, accessService, logger: mockLogger });

    const result = await processor.processSideEffect({ signal: makeImapTestSignal("owner@personal.com"), thread: makeThread() });

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).toHaveBeenCalledOnce();
  });

  it("matches the user email case-insensitively", async () => {
    const store = makeStore("Paid");
    vi.mocked(store.accountDb.listDomains).mockResolvedValue(ok([]));
    const replySender = makeReplySenderSpy();
    const accessService = {
      listUsers: vi.fn().mockResolvedValue(ok([{ userId: "user-1", role: "admin" }])),
      getUserProfile: vi.fn().mockResolvedValue(ok({ email: "Owner@Personal.com" })),
    };
    const processor = makeProcessorWithAccess({ store, replySender, accessService, logger: mockLogger });

    const result = await processor.processSideEffect({ signal: makeImapTestSignal("owner@personal.com"), thread: makeThread() });

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).toHaveBeenCalledOnce();
  });

  it("does not pong when the sender matches neither a registered domain nor any user email", async () => {
    const store = makeStore("Paid");
    vi.mocked(store.accountDb.listDomains).mockResolvedValue(ok([]));
    const replySender = makeReplySenderSpy();
    const accessService = {
      listUsers: vi.fn().mockResolvedValue(ok([{ userId: "user-1", role: "admin" }])),
      getUserProfile: vi.fn().mockResolvedValue(ok({ email: "someone-else@personal.com" })),
    };
    const processor = makeProcessorWithAccess({ store, replySender, accessService, logger: mockLogger });

    const result = await processor.processSideEffect({ signal: makeImapTestSignal("stranger@random.com"), thread: makeThread() });

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
  });

  it("skips the user-email lookup entirely when the sender is already on a registered domain", async () => {
    const store = makeStore("Paid");
    vi.mocked(store.accountDb.listDomains).mockResolvedValue(ok([
      { accountId: TEST_ACCOUNT_ID, domain: "example.com", status: "active", receivingSetupComplete: true, senderSetupComplete: true, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
    ] as never));
    const replySender = makeReplySenderSpy();
    const accessService = {
      listUsers: vi.fn().mockResolvedValue(ok([])),
      getUserProfile: vi.fn().mockResolvedValue(ok({})),
    };
    const processor = makeProcessorWithAccess({ store, replySender, accessService, logger: mockLogger });

    // Sender sender@example.com — eTLD+1 example.com matches the registered domain.
    const result = await processor.processSideEffect({ signal: makeSignal({ data: { workflow: "test", workflowData: { workflow: "test" }, matchedRules: [] } }), thread: makeThread() });

    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).toHaveBeenCalledOnce();
    expect(accessService.listUsers).not.toHaveBeenCalled();
  });

  it("does not force a retry when the Authress user lookup fails — tracks and skips the pong", async () => {
    const store = makeStore("Paid");
    vi.mocked(store.accountDb.listDomains).mockResolvedValue(ok([]));
    const replySender = makeReplySenderSpy();
    const accessService = {
      listUsers: vi.fn().mockResolvedValue(err({ kind: "authress_service_error", message: "Authress unavailable", cause: new Error("Authress unavailable") })),
      getUserProfile: vi.fn().mockResolvedValue(ok({})),
    };
    const processor = makeProcessorWithAccess({ store, replySender, accessService, logger: mockLogger });

    const result = await processor.processSideEffect({ signal: makeImapTestSignal("owner@personal.com"), thread: makeThread() });

    // Pong eligibility failure is non-critical: the side-effect pass still succeeds (no retry).
    expect(result.isOk()).toBe(true);
    expect(replySender.sendReply).not.toHaveBeenCalled();
  });
});
