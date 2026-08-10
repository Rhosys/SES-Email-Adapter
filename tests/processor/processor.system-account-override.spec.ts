import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import type { ThreadMatcherPort, Notifier, InboundSignalMessage, SqsDispatcher } from "../../src/processor/processor.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Signal, Alias } from "../../src/types/index.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import type { HandlerRegistry } from "../../src/workflow/registry.js";
import type { SchedulerClient } from "../../src/scheduler/scheduler-client.js";
import { SYSTEM_ACCOUNT_ID } from "../../src/database/system-account-db.js";
import type { EmailService } from "../../src/email/email-service.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";

// Mock cluster-registry so processor can resolve the read cluster
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
// Test doubles
// ---------------------------------------------------------------------------

const SYSTEM_ALIAS: Alias = {
  id: "system-healthcheck",
  accountId: SYSTEM_ACCOUNT_ID,
  aliasAddress: "healthcheck@platform.email.rhosys.cloud",
  domain: "platform.email.rhosys.cloud",
  aliasName: "healthcheck",
  unknownSenderPolicy: "allow_all",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const SHARED_NEW_DEPS = {
  userCodeExecutor: { invoke: vi.fn().mockResolvedValue({ success: true, result: undefined }), validateAst: vi.fn().mockResolvedValue({ success: true }), validateAstBatch: vi.fn().mockResolvedValue({ success: true }) } as unknown as UserCodeExecutorClient,
  billingHandler: new BillingHandler(),
  handlerRegistry: { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as HandlerRegistry,
  schedulerClient: { createFollowup: vi.fn().mockResolvedValue(ok(undefined)), deleteFollowup: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as SchedulerClient,
  platformTenantName: "test-platform",
};

function makeContentSanitizer(fromAddress = "sender@external.com"): ContentSanitizerClient {
  return {
    invoke: vi.fn().mockReturnValue(Promise.resolve(ok({
      success: true as const,
      parsed: {
        from: { address: fromAddress, name: "Sender" },
        to: [{ address: "healthcheck@platform.email.rhosys.cloud" }],
        cc: [],
        subject: "Healthcheck 2025-07-01",
        textBody: "Pipeline validation email.",
        htmlBody: "<p>Pipeline validation email.</p>",
        attachments: [],
        headers: { "authentication-results": "spf=pass dkim=pass" },
        sentAt: "2025-07-01T06:00:00Z",
      },
      urlMapping: {},
    }))),
  };
}

function makeClassifier(workflow = "conversation"): Pick<SignalClassifier, "classify"> {
  return {
    classify: vi.fn().mockResolvedValue(ok({
      workflow,
      workflowData: { workflow, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "A classified email.",
      labels: [],
      actions: [],
    } as ClassificationOutput)),
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
  return {
    upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
    findMatch: vi.fn().mockResolvedValue(ok(null)),
  };
}

function makeThreadMatcher(): ThreadMatcherPort {
  return {
    findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    deleteEmbeddingsForThread: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

function makeMessage(): InboundSignalMessage {
  return {
    s3Key: "emails/msg-healthcheck",
    compositeMailMessageId: "ses-msg-healthcheck",
    idempotencyKey: "hc-idempotency-key",
    timestamp: "2025-07-01T06:01:00Z",
    destination: ["healthcheck@platform.email.rhosys.cloud"],
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
  };
}

// ---------------------------------------------------------------------------
// Tests — validates Requirements D.1, D.2
// ---------------------------------------------------------------------------

describe("SYSTEM account workflow override", () => {
  let threadDb: ReturnType<typeof makeThreadDbMock>;
  let accountDb: ReturnType<typeof makeAccountDbMock>;
  let processingDb: ReturnType<typeof makeProcessingDbMock>;
  let mockLogger: MockLogger;

  function buildProcessor(opts: { classifierWorkflow?: string; fromAddress?: string } = {}) {
    const { classifierWorkflow = "conversation", fromAddress = "sender@external.com" } = opts;
    const ruleEvaluator = new JsonLogicRuleEvaluator(
      mockLogger,
      { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() } as unknown as UserCodeExecutorClient,
      { annotateRuleError: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    );

    return new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never,
      ...SHARED_NEW_DEPS,
      threadDb,
      accountDb,
      processingDb,
      contentSanitizer: makeContentSanitizer(fromAddress),
      emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never,
      classifier: makeClassifier(classifierWorkflow),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      threadMatcher: makeThreadMatcher(),
      ruleEvaluator,
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as Notifier,
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as unknown as SqsDispatcher,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    threadDb = makeThreadDbMock();
    accountDb = makeAccountDbMock(SYSTEM_ACCOUNT_ID, "healthcheck@platform.email.rhosys.cloud");
    processingDb = makeProcessingDbMock();

    // Wire SYSTEM account resolution via alias
    vi.mocked(accountDb.getAliasByGlobalAddress).mockReturnValue(Promise.resolve(ok(SYSTEM_ALIAS)));

    // SYSTEM account config
    applyCtx(accountDb, {
      retentionDuration: "P7D",
      filtering: { defaultUnknownSenderPolicy: "allow_all" },
      aliasConfig: SYSTEM_ALIAS,
      billingPlan: "Free",
      onboardingCompleted: true,
    });

    vi.mocked(accountDb.listEnabledRules).mockReturnValue(Promise.resolve(ok(SYSTEM_RULES)));

    // SYSTEM account has platform.email.rhosys.cloud as its registered domain
    vi.mocked(accountDb.listDomains).mockReturnValue(Promise.resolve(ok([{
      accountId: SYSTEM_ACCOUNT_ID,
      domain: "platform.email.rhosys.cloud",
      receivingSetupComplete: true,
      senderSetupComplete: true,
      receivingHealthy: true,
      senderHealthy: true,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    } as never])));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("overrides classifier workflow to 'healthcheck' for SYSTEM account", async () => {
    const processor = buildProcessor({ classifierWorkflow: "conversation" });
    await processor.processInbound(makeMessage(), 1);

    const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
    expect(signal.data.workflow).toBe("healthcheck");
    expect(signal.data.workflowData).toEqual({ workflow: "healthcheck" });
  });

  it("overrides any classifier workflow (payments) to 'healthcheck'", async () => {
    const processor = buildProcessor({ classifierWorkflow: "payments" });
    await processor.processInbound(makeMessage(), 1);

    const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
    expect(signal.data.workflow).toBe("healthcheck");
  });

  it("override fires after isTestEmail — takes precedence over test detection", async () => {
    // Sender is from the SYSTEM domain → isTestEmail would be true (eTLD+1 matches).
    // The SYSTEM override fires AFTER and overwrites workflow from "test" to "healthcheck".
    const processor = buildProcessor({ fromAddress: "sender@platform.email.rhosys.cloud" });
    await processor.processInbound(makeMessage(), 1);

    const signal = vi.mocked(threadDb.saveSignal).mock.calls[0]![0] as Signal;
    expect(signal.data.workflow).toBe("healthcheck");
    expect(signal.data.workflowData).toEqual({ workflow: "healthcheck" });
  });
});
