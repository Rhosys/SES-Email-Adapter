import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok, err } from "../../src/errors.js";
import { SignalProcessor } from "../../src/processor/processor.js";
import type { ArcMatcher, InboundSignalMessage } from "../../src/processor/processor.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ArcDatabase } from "../../src/database/arc-database.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/arc-matcher.js";
import type { Alias, Arc } from "../../src/types/index.js";
import { dbError } from "../../src/errors.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

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
    getPrimaryArcMatcherRegistry: () => clusterA,
    getSecondaryClusters: () => [clusterB],
  };
});

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

// ---------------------------------------------------------------------------
// Parallel arc matching — Tier 1 / Tier 1.5 / Tier 2 selection & discrepancy
// **Validates: Requirements R3, R4, R7**
// ---------------------------------------------------------------------------
describe("Feature: in-reply-to-arc-threading, Parallel arc matching tier selection", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const TEST_ACCOUNT_ID = "acct-arc-match";

  const DEFAULT_EMAIL_CONFIG: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    domain: "example.com",
    alias: "user",
    unknownSenderPolicy: "allow_all",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const SHARED_ARC_FIELDS = {
    accountId: TEST_ACCOUNT_ID,
    labels: [] as string[],
    status: "active" as const,
    summary: "Test arc",
    lastSignalAt: "2024-01-01T00:00:00Z",
    senderAddress: "sender@external.com",
    recipientAddress: "user@example.com",
    subject: "Re: test",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const TIER1_ARC: Arc = { id: "arc-tier1", workflow: "notice", ...SHARED_ARC_FIELDS };
  const TIER15_ARC: Arc = { id: "arc-tier15", workflow: "conversation", ...SHARED_ARC_FIELDS };
  const TIER2_ARC: Arc = { id: "arc-tier2", workflow: "conversation", ...SHARED_ARC_FIELDS };
  const SAME_ARC: Arc = { id: "arc-same", workflow: "notice", ...SHARED_ARC_FIELDS };

  /** Content sanitizer returning headers with in-reply-to */
  function makeContentSanitizer(opts?: { inReplyTo?: string | null }): ContentSanitizerClient {
    const headers: Record<string, string> = { "authentication-results": "spf=pass dkim=pass" };
    if (opts?.inReplyTo !== null) {
      headers["in-reply-to"] = opts?.inReplyTo ?? "<parent-msg@example.com>";
    }
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
          headers,
          sentAt: "2024-01-15T09:00:00Z",
        },
        urlMapping: {},
      }))),
    };
  }

  /** Classifier returning "notice" workflow (produces a grouping key for Tier 1) */
  function makeNoticeClassifier(): Pick<SignalClassifier, "classify"> {
    const output: ClassificationOutput = {
      workflow: "notice",
      workflowData: { workflow: "notice", noticeType: "service_notice", provider: "google.com" },
      tags: [],
      summary: "Auth code notice",
      labels: [],
    };
    return { classify: vi.fn().mockResolvedValue(ok(output)) };
  }

  /** Classifier returning "conversation" workflow (no grouping key → Tier 1 misses) */
  function makeConversationClassifier(): Pick<SignalClassifier, "classify"> {
    const output: ClassificationOutput = {
      workflow: "conversation",
      workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "A reply email",
      labels: [],
    };
    return { classify: vi.fn().mockResolvedValue(ok(output)) };
  }

  function makeEmbeddingGenerator(): EmbeddingGenerator {
    return {
      generateForModel: vi.fn().mockResolvedValue(ok({ modelId: "amazon.titan-embed-text-v2:0", vector: [0.1, -0.9], dimensions: 1024 })),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([ok({ modelId: "amazon.titan-embed-text-v3:0", vector: [0.2, 0.8], dimensions: 1536 })]),
    };
  }

  function makeAuroraWriter(matchArc?: Arc | null): MultiClusterAuroraWriter {
    return {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(matchArc ?? null)),
    };
  }

  function makeMessage(sesMessageId: string): InboundSignalMessage {
    return {
      s3Key: `emails/${sesMessageId}`,
      sesMessageId,
      idempotencyKey: "test-idempotency-key",
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  function buildProcessor(overrides: {
    arcDb?: unknown;
    classifier?: Pick<SignalClassifier, "classify">;
    contentSanitizer?: ContentSanitizerClient;
    auroraWriter?: MultiClusterAuroraWriter;
    arcMatcher?: ArcMatcher;
  }) {
    const arcDb = (overrides.arcDb ?? makeArcDbMock()) as ArcDatabase;
    const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
    const processingDb = makeProcessingDbMock();
    return new SignalProcessor({
      ...makeSharedNewDeps(),
      arcDb,
      accountDb,
      processingDb,
      contentSanitizer: overrides.contentSanitizer ?? makeContentSanitizer(),
      s3Client: {} as never,
      emailBucket: "test-bucket",
      contentBucket: "test-content-bucket",
      classifier: overrides.classifier ?? makeConversationClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: overrides.auroraWriter ?? makeAuroraWriter(),
      arcMatcher: overrides.arcMatcher ?? { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as ArcMatcher,
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "mock-reply-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" },
    });
  }

  // -------------------------------------------------------------------------
  // 1. All three tiers agree on same arc → no discrepancy log, arc used
  // -------------------------------------------------------------------------
  it("all three tiers agree on same arc → no discrepancy log, arc used", async () => {
    const arcDb = {
      ...makeArcDbMock(),
      fastFindArcByAlternativeLookupKey: vi.fn().mockReturnValue(Promise.resolve(ok(SAME_ARC))),
      findSignalByEmailMessageId: vi.fn().mockReturnValue(Promise.resolve(ok({ arcId: SAME_ARC.id, id: "sgn-1", signalLookupId: "ses-1", accountId: TEST_ACCOUNT_ID, status: "active", source: "email", type: "email" }))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(SAME_ARC))),
    };

    const processor = buildProcessor({
      arcDb,
      classifier: makeNoticeClassifier(),
      contentSanitizer: makeContentSanitizer(),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(SAME_ARC))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as ArcMatcher,
    });

    const result = await processor.processRecord(makeMessage("msg-all-agree"), 1);
    expect(result.isOk()).toBe(true);

    const trackCalls = mockLogger.calls.filter(c => c.method === "track" && c.context?.code === "processor.arc_match_discrepancy");
    expect(trackCalls).toHaveLength(0);

    const matchLog = mockLogger.calls.find(c => c.context?.code === "processor.arc_matched");
    expect(matchLog).toBeDefined();
    expect(matchLog!.context!.arcId).toBe(SAME_ARC.id);
  });

  // -------------------------------------------------------------------------
  // 2. Tier 1 and Tier 1.5 disagree → TRACK logged, Tier 1 arc selected
  // -------------------------------------------------------------------------
  it("Tier 1 and Tier 1.5 disagree → TRACK logged, Tier 1 arc selected", async () => {
    const arcDb = {
      ...makeArcDbMock(),
      fastFindArcByAlternativeLookupKey: vi.fn().mockReturnValue(Promise.resolve(ok(TIER1_ARC))),
      findSignalByEmailMessageId: vi.fn().mockReturnValue(Promise.resolve(ok({ arcId: TIER15_ARC.id, id: "sgn-2", signalLookupId: "ses-2", accountId: TEST_ACCOUNT_ID, status: "active", source: "email", type: "email" }))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(TIER15_ARC))),
    };

    const processor = buildProcessor({
      arcDb,
      classifier: makeNoticeClassifier(),
      contentSanitizer: makeContentSanitizer(),
      auroraWriter: makeAuroraWriter(null),
    });

    const result = await processor.processRecord(makeMessage("msg-tier1-vs-tier15"), 1);
    expect(result.isOk()).toBe(true);

    const trackCalls = mockLogger.calls.filter(c => c.method === "track" && c.context?.code === "processor.arc_match_discrepancy");
    expect(trackCalls).toHaveLength(1);
    expect(trackCalls[0]!.context!.tier1ArcId).toBe(TIER1_ARC.id);
    expect(trackCalls[0]!.context!.tier15ArcId).toBe(TIER15_ARC.id);
    expect(trackCalls[0]!.context!.selectedTier).toBe("groupingKey");

    const matchLog = mockLogger.calls.find(c => c.context?.code === "processor.arc_matched");
    expect(matchLog!.context!.arcId).toBe(TIER1_ARC.id);
  });

  // -------------------------------------------------------------------------
  // 3. Only Tier 1.5 matches → that arc used, no discrepancy
  // -------------------------------------------------------------------------
  it("only Tier 1.5 matches → that arc used, no discrepancy", async () => {
    const arcDb = {
      ...makeArcDbMock(),
      findSignalByEmailMessageId: vi.fn().mockReturnValue(Promise.resolve(ok({ arcId: TIER15_ARC.id, id: "sgn-3", signalLookupId: "ses-3", accountId: TEST_ACCOUNT_ID, status: "active", source: "email", type: "email" }))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(TIER15_ARC))),
    };

    const processor = buildProcessor({
      arcDb,
      classifier: makeConversationClassifier(),
      contentSanitizer: makeContentSanitizer(),
      auroraWriter: makeAuroraWriter(null),
    });

    const result = await processor.processRecord(makeMessage("msg-tier15-only"), 1);
    expect(result.isOk()).toBe(true);

    const trackCalls = mockLogger.calls.filter(c => c.method === "track" && c.context?.code === "processor.arc_match_discrepancy");
    expect(trackCalls).toHaveLength(0);

    const matchLog = mockLogger.calls.find(c => c.context?.code === "processor.arc_matched");
    expect(matchLog).toBeDefined();
    expect(matchLog!.context!.arcId).toBe(TIER15_ARC.id);
    expect(matchLog!.context!.matchMethod).toBe("inReplyTo");
  });

  // -------------------------------------------------------------------------
  // 4. Only Tier 2 matches → that arc used
  // -------------------------------------------------------------------------
  it("only Tier 2 matches → that arc used", async () => {
    const processor = buildProcessor({
      classifier: makeConversationClassifier(),
      contentSanitizer: makeContentSanitizer({ inReplyTo: null }),
      arcMatcher: { findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(TIER2_ARC))), upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) } as ArcMatcher,
    });

    const result = await processor.processRecord(makeMessage("msg-tier2-only"), 1);
    expect(result.isOk()).toBe(true);

    const matchLog = mockLogger.calls.find(c => c.context?.code === "processor.arc_matched");
    expect(matchLog).toBeDefined();
    expect(matchLog!.context!.arcId).toBe(TIER2_ARC.id);
    expect(matchLog!.context!.matchMethod).toBe("similarity");
  });

  // -------------------------------------------------------------------------
  // 5. No tier matches → new arc created
  // -------------------------------------------------------------------------
  it("no tier matches → new arc created", async () => {
    const arcDb = makeArcDbMock();

    const processor = buildProcessor({
      arcDb,
      classifier: makeConversationClassifier(),
      contentSanitizer: makeContentSanitizer({ inReplyTo: null }),
      auroraWriter: makeAuroraWriter(null),
    });

    const result = await processor.processRecord(makeMessage("msg-no-match"), 1);
    expect(result.isOk()).toBe(true);

    // New arc was saved (saveArc called)
    expect((arcDb as unknown as { saveArc: ReturnType<typeof vi.fn> }).saveArc).toHaveBeenCalled();

    // No "arc_matched" info log — instead a new arc is created
    const matchLog = mockLogger.calls.find(c => c.context?.code === "processor.arc_matched");
    expect(matchLog).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 6. Tier 1.5 returns signal without arcId → treated as miss
  // -------------------------------------------------------------------------
  it("Tier 1.5 returns signal without arcId → treated as miss", async () => {
    const arcDb = {
      ...makeArcDbMock(),
      findSignalByEmailMessageId: vi.fn().mockReturnValue(Promise.resolve(ok({ id: "sgn-quarantined", signalLookupId: "ses-q", accountId: TEST_ACCOUNT_ID, status: "quarantined", source: "email", type: "email" }))),
    };

    const processor = buildProcessor({
      arcDb,
      classifier: makeConversationClassifier(),
      contentSanitizer: makeContentSanitizer(),
      auroraWriter: makeAuroraWriter(null),
    });

    const result = await processor.processRecord(makeMessage("msg-no-arcid"), 1);
    expect(result.isOk()).toBe(true);

    // getArc should NOT have been called since the signal had no arcId
    expect((arcDb as unknown as { getArc: ReturnType<typeof vi.fn> }).getArc).not.toHaveBeenCalled();

    // New arc created (no tier matched)
    expect((arcDb as unknown as { saveArc: ReturnType<typeof vi.fn> }).saveArc).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Tier 1.5 GSI2 query throws → treated as miss, falls through
  // -------------------------------------------------------------------------
  it("Tier 1.5 GSI2 query throws → treated as miss, falls through", async () => {
    const arcDb = {
      ...makeArcDbMock(),
      findSignalByEmailMessageId: vi.fn().mockReturnValue(Promise.resolve(err(dbError(new Error("DynamoDB timeout"))))),
    };

    const processor = buildProcessor({
      arcDb,
      classifier: makeConversationClassifier(),
      contentSanitizer: makeContentSanitizer(),
      auroraWriter: makeAuroraWriter(null),
    });

    const result = await processor.processRecord(makeMessage("msg-gsi2-error"), 1);
    expect(result.isOk()).toBe(true);

    // Warn logged about the GSI2 failure
    const warnLogs = mockLogger.calls.filter(c => c.method === "warn" && c.context?.code === "processor.in_reply_to.gsi2_error");
    expect(warnLogs).toHaveLength(1);

    // Fell through → new arc created (no other tiers matched)
    expect((arcDb as unknown as { saveArc: ReturnType<typeof vi.fn> }).saveArc).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. In-Reply-To header absent → Tier 1.5 result is null, no query made
  // -------------------------------------------------------------------------
  it("In-Reply-To header absent → Tier 1.5 result is null, no query made", async () => {
    const arcDb = makeArcDbMock();

    const processor = buildProcessor({
      arcDb,
      classifier: makeConversationClassifier(),
      contentSanitizer: makeContentSanitizer({ inReplyTo: null }),
      auroraWriter: makeAuroraWriter(null),
    });

    const result = await processor.processRecord(makeMessage("msg-no-irt-header"), 1);
    expect(result.isOk()).toBe(true);

    // findSignalByEmailMessageId should NOT have been called
    expect((arcDb as unknown as { findSignalByEmailMessageId: ReturnType<typeof vi.fn> }).findSignalByEmailMessageId).not.toHaveBeenCalled();
  });
});
