import { describe, it, expect, vi, afterEach } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ArcMatcher, Notifier, Forwarder, ReplySender, SideEffectPayload } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/multi-cluster-aurora-writer.js";
import type { Signal, Arc, Alias, AliasSender } from "../../src/types/index.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

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
// Processor side-effect correlation context tests
// Validates: Requirements 2.4, 3.3, 3.4, 3.7, 4.4
// ---------------------------------------------------------------------------

describe("processSideEffect — correlation context", () => {
  const TEST_ACCOUNT_ID = "acct-correlation";

  let mockLogger: MockLogger;
  afterEach(() => { vi.restoreAllMocks(); });

  function makeStore() {
    const arcDb = makeArcDbMock();
    const accountDb = makeAccountDbMock();
    const processingDb = makeProcessingDbMock();
    vi.mocked(accountDb.getDomainByName).mockReturnValue(Promise.resolve(ok(null)));
    return { arcDb, accountDb, processingDb };
  }

  function makeSignal(overrides: Partial<Signal> = {}): Signal {
    return {
      id: "sgn-corr-001",
      signalLookupId: "ses-corr-msg",
      accountId: TEST_ACCOUNT_ID,
      source: "email",
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
      workflowData: { workflow: "test", triggeredBy: "user" },
      spamScore: 0.0,
      summary: "A test email.",
      s3Key: "emails/corr-msg",
      status: "active",
      createdAt: "2024-01-15T10:00:00Z",
      matchedRules: [],
      ...overrides,
    };
  }

  function makeArc(overrides: Partial<Arc> = {}): Arc {
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
      ...overrides,
    };
  }

  function makeProcessor(opts: { replySender: ReplySender; forwarder: Forwarder }) {
    mockLogger = createMockLogger();
    return new SignalProcessor({
      ...makeStore(),
      contentSanitizer: { invoke: vi.fn() } as unknown as ContentSanitizerClient,
      s3Client: {} as never,
      emailBucket: "test-bucket",
      contentBucket: "test-content-bucket",
      contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn() },
      embeddingGenerator: { generateForModel: vi.fn(), generateForSecondaryClusters: vi.fn() } as unknown as EmbeddingGenerator,
      auroraWriter: { upsertEmbedding: vi.fn(), findMatch: vi.fn() } as unknown as MultiClusterAuroraWriter,
      arcMatcher: { findMatch: vi.fn(), upsertEmbedding: vi.fn() } as unknown as ArcMatcher,
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: opts.forwarder,
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: opts.replySender,
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      logger: mockLogger,
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });
  }

  // -------------------------------------------------------------------------
  // Pong side-effect passes correlation context to sendReply
  // -------------------------------------------------------------------------

  describe("pong side-effect", () => {
    it("calls sendReply with accountId, signalId, and arcId", async () => {
      const replySender: ReplySender = { sendReply: vi.fn().mockResolvedValue({ messageId: "pong-msg-001" }) };
      const forwarder: Forwarder = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
      const processor = makeProcessor({ replySender, forwarder });

      const signal = makeSignal({
        id: "sgn-pong-123",
        matchedRules: [{ ruleId: "SR-13", actions: [{ type: "pong" }], labelsAdded: [] }],
      });
      const arc = makeArc({ id: "arc-pong-456" });
      const payload: SideEffectPayload = { signal, arc };

      await processor.processSideEffect(payload);

      expect(replySender.sendReply).toHaveBeenCalledOnce();
      const opts = vi.mocked(replySender.sendReply).mock.calls[0]![0];
      expect(opts.accountId).toBe(TEST_ACCOUNT_ID);
      expect(opts.signalId).toBe("sgn-pong-123");
      expect(opts.arcId).toBe("arc-pong-456");
    });
  });

  // -------------------------------------------------------------------------
  // Forward side-effect passes correlation context to forwarder.forward
  // -------------------------------------------------------------------------

  describe("forward side-effect", () => {
    it("calls forwarder.forward with signalId and arcId in opts", async () => {
      const replySender: ReplySender = { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) };
      const forwarder: Forwarder = { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
      const processor = makeProcessor({ replySender, forwarder });

      const signal = makeSignal({
        id: "sgn-fwd-789",
        s3Key: "emails/fwd-msg",
        matchedRules: [{ ruleId: "rule-fwd", actions: [{ type: "forward", value: "backup@personal.com" }], labelsAdded: [] }],
      });
      const arc = makeArc({ id: "arc-fwd-012" });
      const payload: SideEffectPayload = { signal, arc };

      await processor.processSideEffect(payload);

      expect(forwarder.forward).toHaveBeenCalledOnce();
      const [s3Key, toAddress, accountId, opts] = vi.mocked(forwarder.forward).mock.calls[0]!;
      expect(s3Key).toBe("emails/fwd-msg");
      expect(toAddress).toBe("backup@personal.com");
      expect(accountId).toBe(TEST_ACCOUNT_ID);
      expect(opts).toEqual({ signalId: "sgn-fwd-789", arcId: "arc-fwd-012" });
    });
  });
});
