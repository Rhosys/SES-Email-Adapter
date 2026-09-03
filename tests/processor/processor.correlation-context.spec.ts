import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, Notifier,  ReplySender, SideEffectPayload } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Signal, Thread, Alias, AliasSender } from "../../src/types/index.js";
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


// ---------------------------------------------------------------------------
// Processor side-effect correlation context tests
// Validates: Requirements 2.4, 3.3, 3.4, 3.7, 4.4
// ---------------------------------------------------------------------------

describe("processSideEffect — correlation context", () => {
  const TEST_ACCOUNT_ID = "acct-correlation";

  let mockLogger: MockLogger;
  afterEach(() => { vi.restoreAllMocks(); });

  function makeStore() {
    const threadDb = makeThreadDbMock();
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    const processingDb = makeProcessingDbMock();
    vi.mocked(accountDb.getDomainByName).mockReturnValue(Promise.resolve(ok({ domain: "example.com", senderSetupComplete: true } as never)));
    // Pong eligibility: the sender (sender@example.com) belongs to the account via a registered domain.
    vi.mocked(accountDb.listDomains).mockReturnValue(Promise.resolve(ok([{ domain: "example.com", senderSetupComplete: true } as never])));
    return { threadDb, accountDb, processingDb };
  }

  function makeSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
    const { data: dataOverrides, ...baseOverrides } = overrides;
    return {
      id: "sgn-corr-001",
      signalLookupId: "ses-corr-msg",
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
        workflow: "test",
        workflowData: { workflow: "test" },
        tags: [],
        summary: "A test email.",
        s3Key: "emails/corr-msg",
        matchedRules: [],
        ...dataOverrides,
      },
    } as Signal;
  }

  function makeThread(overrides: Partial<Thread> = {}): Thread {
    return {
      id: "arc-corr-001",
      accountId: TEST_ACCOUNT_ID,
      workflow: "test",
      labels: [],
      status: "active",
      summary: "A test email.",
      lastSignalAt: "2024-01-15T10:00:00Z",
      createdAt: "2024-01-15T10:00:00Z",
      updatedAt: "2024-01-15T10:00:00Z",
      sender: { address: "sender@example.com" },
      recipientAddress: "user@example.com",
      subject: "Test email",
      ...overrides,
    };
  }

  function makeProcessor(opts: { replySender: ReplySender; forwardingService: IForwardingService; store?: ReturnType<typeof makeStore> }) {
    mockLogger = createMockLogger();
    return new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...(opts.store ?? makeStore()),
      contentSanitizer: { invoke: vi.fn() } as unknown as ContentSanitizerClient,
      emailContentStore: { createReadUrl: vi.fn().mockResolvedValue("https://signed-url"), getContent: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])), saveRawEmail: vi.fn().mockResolvedValue(undefined), createContentUploadTicket: vi.fn().mockResolvedValue({ url: "https://post-url", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://signed-url") } as never,
      contentStore: { createReadUrl: vi.fn().mockResolvedValue("https://signed-url"), getContent: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])), saveRawEmail: vi.fn().mockResolvedValue(undefined), createContentUploadTicket: vi.fn().mockResolvedValue({ url: "https://post-url", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://signed-url") } as never,
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForModel: vi.fn(), generateForSecondaryClusters: vi.fn() } as unknown as EmbeddingGenerator,
      auroraWriter: { upsertEmbedding: vi.fn(), findMatch: vi.fn() } as unknown as MultiClusterAuroraWriter,
      threadMatcher: { findMatch: vi.fn(), upsertEmbedding: vi.fn(), deleteEmbeddingsForThread: vi.fn() } as unknown as ThreadMatcherPort,
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: opts.forwardingService,
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: opts.replySender,
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      logger: mockLogger,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });
  }

  // -------------------------------------------------------------------------
  // Pong side-effect passes correlation context to sendReply
  // -------------------------------------------------------------------------

  describe("pong side-effect", () => {
    it("calls sendReply with accountId, signalId, and threadId", async () => {
      const replySender: ReplySender = { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "pong-msg-001" })) };
      const forwardingService: IForwardingService = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) };
      const processor = makeProcessor({ replySender, forwardingService });

      // workflow "test" + sender belongs to the account (listDomains stub) satisfies pong eligibility.
      const signal = makeSignal({ id: "sgn-pong-123" });
      const thread = makeThread({ id: "arc-pong-456" });
      const payload: SideEffectPayload = { signal, thread };

      await processor.processSideEffect(payload);

      expect(replySender.sendReply).toHaveBeenCalledOnce();
      const opts = vi.mocked(replySender.sendReply).mock.calls[0]![0];
      expect(opts.accountId).toBe(TEST_ACCOUNT_ID);
      expect(opts.signalId).toBe("sgn-pong-123");
      expect(opts.threadId).toBe("arc-pong-456");
    });

    it("does not pong when the sender does not belong to the account", async () => {
      const replySender: ReplySender = { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "pong-msg-001" })) };
      const forwardingService: IForwardingService = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) };
      const processor = makeProcessor({ replySender, forwardingService });

      const signal = makeSignal({ data: { from: { address: "stranger@outsider.com", name: "Stranger" } } });
      const payload: SideEffectPayload = { signal, thread: makeThread() };

      await processor.processSideEffect(payload);

      expect(replySender.sendReply).not.toHaveBeenCalled();
    });

    it("ponging marks onboarding testEmailReceived when not yet completed", async () => {
      const replySender: ReplySender = { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "pong-msg-001" })) };
      const forwardingService: IForwardingService = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) };
      const store = makeStore();
      // Onboarding not yet complete and no test email recorded — the mark should be written.
      vi.mocked(store.accountDb.getAccount).mockReturnValue(Promise.resolve(ok({ retentionDuration: "P3M", filtering: null, billingPlan: "Paid", onboarding: { completed: false }, createdAt: "2024-01-01T00:00:00Z" } as never)));
      const processor = makeProcessor({ replySender, forwardingService, store });

      await processor.processSideEffect({ signal: makeSignal(), thread: makeThread() });

      expect(replySender.sendReply).toHaveBeenCalledOnce();
      expect(store.accountDb.updateAccount).toHaveBeenCalledWith(TEST_ACCOUNT_ID, expect.objectContaining({ onboarding: expect.objectContaining({ testEmailReceived: true }) }));
    });
  });

  // -------------------------------------------------------------------------
  // Forward side-effect passes correlation context to forwarder.forward
  // -------------------------------------------------------------------------

  describe("forward side-effect", () => {
    it("calls forwarder.forward with signalId and threadId in opts", async () => {
      const replySender: ReplySender = { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) };
      const forwardingService: IForwardingService = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) };
      const processor = makeProcessor({ replySender, forwardingService });

      const signal = makeSignal({
        id: "sgn-fwd-789",
        data: {
          s3Key: "emails/fwd-msg",
          matchedRules: [{ ruleId: "rule-fwd", actions: [{ type: "forward", value: "backup@personal.com" }], labelsAdded: [] }],
        },
      });
      const thread = makeThread({ id: "arc-fwd-012" });
      const payload: SideEffectPayload = { signal, thread };

      await processor.processSideEffect(payload);

      expect(forwardingService.forward).toHaveBeenCalledOnce();
      const [forwardingTargetId, fwdSignal, fwdArc] = vi.mocked(forwardingService.forward).mock.calls[0]!;
      expect(forwardingTargetId).toBe("backup@personal.com");
      expect(fwdSignal.id).toBe("sgn-fwd-789");
      expect(fwdArc.accountId).toBe(TEST_ACCOUNT_ID);
      expect(fwdArc.id).toBe("arc-fwd-012");
    });
  });
});
