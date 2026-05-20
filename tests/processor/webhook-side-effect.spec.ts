import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher, SqsDispatcher, Notifier, Forwarder, ReplySender, SideEffectPayload } from "../../src/processor/processor.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/multi-cluster-aurora-writer.js";
import type { S3RetentionService } from "../../src/embedding/s3-retention-service.js";
import type { Signal, Arc, Alias } from "../../src/types/index.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
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
    getPrimaryArcMatcherRegistry: () => entry,
  };
});

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-webhook-test";

const DEFAULT_ALIAS: Alias = {
  id: "cfg-default",
  accountId: TEST_ACCOUNT_ID,
  address: "user@example.com",
  unknownSenderPolicy: "allow_all",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Test double factories
// ---------------------------------------------------------------------------

function makeStore(billingPlan: "Paid" | "Free" | "Trial" = "Paid"): ProcessorDatabase {
  return {
    getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getArc: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    findArcByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveArc: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateArc: vi.fn().mockReturnValue(Promise.resolve(ok({}))),
    listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok(SYSTEM_RULES))),
    getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok({
      retentionDays: 30,
      filtering: null,
      emailConfig: DEFAULT_ALIAS,
      registeredDomains: [],
      userEmails: [],
      billingPlan,
    }))),
    saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a))),
    getSender: vi.fn().mockReturnValue(Promise.resolve(ok({
      accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com",
      domain: "example.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z",
    }))),
    saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    incrementStats: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    annotateTemplateError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  };
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "sgn-webhook-test-001",
    signalLookupId: "ses-webhook-msg-001",
    arcId: "arc-webhook-001",
    accountId: TEST_ACCOUNT_ID,
    source: "email",
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
    spamScore: 0.05,
    summary: "A webhook test signal.",
    classificationModelId: "model-v3",
    s3Key: "emails/webhook-test.eml",
    status: "active",
    createdAt: "2024-06-15T10:30:00.000Z",
    embeddings: {},
    matchedRules: [],
    ...overrides,
  };
}

function makeArc(overrides: Partial<Arc> = {}): Arc {
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
    ...overrides,
  };
}

function makeProcessor(opts: { store: ProcessorDatabase; logger: MockLogger; billingHandler?: BillingHandler }): SignalProcessor {
  return new SignalProcessor({
    store: opts.store,
    contentSanitizer: { invoke: vi.fn() } as unknown as ContentSanitizerClient,
    classifier: { classify: vi.fn() } as unknown as Pick<SignalClassifier, "classify">,
    embeddingGenerator: { generateForModel: vi.fn(), generateForSecondaryClusters: vi.fn() } as unknown as EmbeddingGenerator,
    auroraWriter: { upsertEmbedding: vi.fn(), findMatch: vi.fn() } as unknown as MultiClusterAuroraWriter,
    arcMatcher: { findMatch: vi.fn(), upsertEmbedding: vi.fn() } as unknown as ArcMatcher,
    ruleEvaluator: new JsonLogicRuleEvaluator(opts.logger),
    logger: opts.logger,
    retentionService: { applyPlanRetention: vi.fn() } as unknown as S3RetentionService,
    sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as SqsDispatcher,
    notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as Notifier,
    forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as Forwarder,
    replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "msg-001" }) } as unknown as ReplySender,
    draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    billingHandler: opts.billingHandler ?? new BillingHandler(),
    s3Client: {} as never,
    emailBucket: "test-bucket",
    contentBucket: "test-content-bucket",
    contentCdnBaseUrl: "https://cdn.example.com",
  });
}

// ---------------------------------------------------------------------------
// Integration tests: Webhook in processSideEffect
// ---------------------------------------------------------------------------

describe("processSideEffect — webhook delivery", () => {
  let mockLogger: MockLogger;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("webhook fires after other side-effects (forward + notify complete first)", async () => {
    const store = makeStore("Paid");
    const forwarder = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
    const notifier = { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };

    const processor = new SignalProcessor({
      store,
      contentSanitizer: { invoke: vi.fn() } as unknown as ContentSanitizerClient,
      classifier: { classify: vi.fn() } as unknown as Pick<SignalClassifier, "classify">,
      embeddingGenerator: { generateForModel: vi.fn(), generateForSecondaryClusters: vi.fn() } as unknown as EmbeddingGenerator,
      auroraWriter: { upsertEmbedding: vi.fn(), findMatch: vi.fn() } as unknown as MultiClusterAuroraWriter,
      arcMatcher: { findMatch: vi.fn(), upsertEmbedding: vi.fn() } as unknown as ArcMatcher,
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      retentionService: { applyPlanRetention: vi.fn() } as unknown as S3RetentionService,
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as SqsDispatcher,
      notifier: notifier as unknown as Notifier,
      forwarder: forwarder as unknown as Forwarder,
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "msg-001" }) } as unknown as ReplySender,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      billingHandler: new BillingHandler(),
      s3Client: {} as never,
      emailBucket: "test-bucket",
      contentBucket: "test-content-bucket",
      contentCdnBaseUrl: "https://cdn.example.com",
    });

    const signal = makeSignal({
      matchedRules: [
        { ruleId: "rule-fwd", actions: [{ type: "forward", value: "backup@personal.com" }], labelsAdded: [] },
        { ruleId: "rule-hook", actions: [{ type: "webhook", value: '{"url":"https://hook.example.com/events"}' }], labelsAdded: [] },
      ],
    });
    const arc = makeArc();
    const payload: SideEffectPayload = { signal, arc };

    const result = await processor.processSideEffect(payload);

    expect(result.isOk()).toBe(true);

    // Forward and notify were called
    expect(forwarder.forward).toHaveBeenCalledOnce();
    expect(notifier.notify).toHaveBeenCalledOnce();

    // Webhook was called
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://hook.example.com/events");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    // Verify webhook was called AFTER forward and notify (invocation order)
    const forwardOrder = forwarder.forward.mock.invocationCallOrder[0]!;
    const notifyOrder = notifier.notify.mock.invocationCallOrder[0]!;
    const fetchOrder = mockFetch.mock.invocationCallOrder[0]!;
    expect(fetchOrder).toBeGreaterThan(forwardOrder);
    expect(fetchOrder).toBeGreaterThan(notifyOrder);

    // Verify payload shape contains expected signal fields
    const body = JSON.parse(opts.body as string);
    expect(body.id).toBe(signal.id);
    expect(body.alias).toBe(signal.recipientAddress);
    expect(body.labels).toEqual(arc.labels);
  });

  it("webhook skipped when plan-gated — INFO log with correct code", async () => {
    const store = makeStore("Free");
    const processor = makeProcessor({ store, logger: mockLogger });

    const signal = makeSignal({
      matchedRules: [
        { ruleId: "rule-hook", actions: [{ type: "webhook", value: '{"url":"https://hook.example.com/events"}' }], labelsAdded: [] },
      ],
    });
    const arc = makeArc();
    const payload: SideEffectPayload = { signal, arc };

    const result = await processor.processSideEffect(payload);

    expect(result.isOk()).toBe(true);

    // Webhook was NOT called
    expect(mockFetch).not.toHaveBeenCalled();

    // INFO log emitted with plan-gated code
    const planGatedLog = mockLogger.calls.find(
      c => c.method === "info" && c.context?.code === "processor.side_effect.webhook_plan_gated",
    );
    expect(planGatedLog).toBeDefined();
    expect(planGatedLog!.context!.plan).toBe("Free");
    expect(planGatedLog!.context!.accountId).toBe(TEST_ACCOUNT_ID);
  });

  it("multiple webhook actions on same signal all fire", async () => {
    const store = makeStore("Paid");
    const processor = makeProcessor({ store, logger: mockLogger });

    const signal = makeSignal({
      matchedRules: [
        { ruleId: "rule-hook-1", actions: [{ type: "webhook", value: '{"url":"https://first.example.com/hook"}' }], labelsAdded: [] },
        { ruleId: "rule-hook-2", actions: [{ type: "webhook", value: '{"url":"https://second.example.com/hook"}' }], labelsAdded: [] },
      ],
    });
    const arc = makeArc();
    const payload: SideEffectPayload = { signal, arc };

    const result = await processor.processSideEffect(payload);

    expect(result.isOk()).toBe(true);

    // Both webhooks were called
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const urls = mockFetch.mock.calls.map((c: unknown[]) => c[0]);
    expect(urls).toContain("https://first.example.com/hook");
    expect(urls).toContain("https://second.example.com/hook");
  });

  it("invalid config at processing time logged at TRACK level and skipped", async () => {
    const store = makeStore("Paid");
    const processor = makeProcessor({ store, logger: mockLogger });

    const signal = makeSignal({
      matchedRules: [
        { ruleId: "rule-bad", actions: [{ type: "webhook", value: "not valid json {{{" }], labelsAdded: [] },
      ],
    });
    const arc = makeArc();
    const payload: SideEffectPayload = { signal, arc };

    const result = await processor.processSideEffect(payload);

    expect(result.isOk()).toBe(true);

    // Webhook was NOT called (invalid config)
    expect(mockFetch).not.toHaveBeenCalled();

    // TRACK log emitted with invalid config code
    const invalidConfigLog = mockLogger.calls.find(
      c => c.method === "track" && c.context?.code === "processor.side_effect.webhook_invalid_config",
    );
    expect(invalidConfigLog).toBeDefined();
    expect(invalidConfigLog!.context!.accountId).toBe(TEST_ACCOUNT_ID);
    expect(invalidConfigLog!.context!.value).toBe("not valid json {{{");
  });
});
