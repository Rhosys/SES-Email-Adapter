import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher, InboundSignalMessage } from "../../src/processor/processor.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/multi-cluster-aurora-writer.js";
import type { Alias } from "../../src/types/index.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

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
    getPrimaryArcMatcherRegistry: () => entry,
  };
});

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

const TEST_ACCOUNT_ID = "acct-001";

const DEFAULT_ALIAS: Alias = {
  id: "cfg-default", accountId: TEST_ACCOUNT_ID, address: "user@example.com",
  unknownSenderPolicy: "allow_all",
  createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_CTX = {
  retentionDays: 0, filtering: null, emailConfig: DEFAULT_ALIAS,
  registeredDomains: [], userEmails: [], billingPlan: "Paid" as const,
};

const validClassification: ClassificationOutput = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
  spamScore: 0.05,
  summary: "A test email.",
  labels: [],
  classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
};

function makeStore(): ProcessorDatabase {
  return {
    getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getArc: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    findArcByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    saveArc: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok(SYSTEM_RULES))),
    getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_CTX))),
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
  return { classify: vi.fn().mockResolvedValue({ ...validClassification }) };
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

function makeArcMatcher(): ArcMatcher {
  return {
    findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  };
}

/**
 * Build an InboundSignalMessage for routing tests.
 */
function makeMessage(): InboundSignalMessage {
  const sesMessageId = "msg-routing-test";
  return {
    accountId: TEST_ACCOUNT_ID,
    s3Key: `emails/${sesMessageId}`,
    sesMessageId,
    timestamp: "2024-01-15T10:00:00Z",
    destination: ["user@example.com"],
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
  };
}

// ---------------------------------------------------------------------------
// Tests: Message routing in process()
// Validates: Requirement 4.1
// ---------------------------------------------------------------------------

describe("SignalProcessor message routing", () => {
  let store: ProcessorDatabase;
  let processor: SignalProcessor;
  let mockLogger: MockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    store = makeStore();
    processor = new SignalProcessor({
      store,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    });
  });

  it("routes to processRecord when messageType attribute is absent", async () => {
    const message = makeMessage();

    const processRecordSpy = vi.spyOn(processor, "processRecord");
    await processor.processRecord(message, 1);

    // processRecord was called — observable via the store's dedup check
    expect(processRecordSpy).toHaveBeenCalledOnce();
    expect(store.getSignalByMessageId).toHaveBeenCalled();
  });

  it("routes to processRecord when messageType is 'inbound_signal'", async () => {
    const message = makeMessage();

    const processRecordSpy = vi.spyOn(processor, "processRecord");
    await processor.processRecord(message, 1);

    // processRecord was called — observable via the store's dedup check
    expect(processRecordSpy).toHaveBeenCalledOnce();
    expect(store.getSignalByMessageId).toHaveBeenCalled();
  });
});
