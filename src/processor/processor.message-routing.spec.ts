import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { ok } from "../errors.js";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Alias } from "../types/index.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// Mock cluster-registry so processor can resolve the read cluster
vi.mock("../embedding/cluster-registry.js", () => {
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

const TEST_ACCOUNT_ID = "acct-001";

const DEFAULT_ALIAS: Alias = {
  id: "cfg-default", accountId: TEST_ACCOUNT_ID, address: "user@example.com",
  filterMode: "allow_all",
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
      domain: "example.com", mode: "allow", addedAt: "2024-01-01T00:00:00Z",
    }))),
    saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
  };
}

function makeMimeParser(): MimeParser {
  return {
    parse: vi.fn().mockResolvedValue(ok({
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email",
      textBody: "Hello world",
      htmlBody: "<p>Hello world</p>",
      attachments: [],
      headers: { "authentication-results": "spf=pass dkim=pass" },
      sentAt: "2024-01-15T09:00:00Z",
    })),
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
 * Build an SQS record with a specific messageType attribute (or absent).
 */
function makeSqsRecord(opts: {
  messageType?: string;
  body?: string;
  messageId?: string;
}): SQSRecord {
  const sesMessageId = "msg-routing-test";
  const notification = {
    accountId: TEST_ACCOUNT_ID,
    mail: {
      messageId: sesMessageId,
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
    },
    receipt: {
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PASS" },
      action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
    },
  };

  const messageAttributes: SQSRecord["messageAttributes"] = {};
  if (opts.messageType !== undefined) {
    messageAttributes["messageType"] = {
      stringValue: opts.messageType,
      dataType: "String",
      stringListValues: [],
      binaryListValues: [],
    };
  }

  return {
    messageId: opts.messageId ?? "sqs-routing-0",
    receiptHandle: "handle",
    body: opts.body ?? JSON.stringify({ Message: JSON.stringify(notification) }),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "1234567890",
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: "1234567890",
    },
    messageAttributes,
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123:queue",
    awsRegion: "us-east-1",
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
      mimeParser: makeMimeParser(),
      classifier: makeClassifier(),
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), notifyBlocked: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    });
  });

  it("routes to processRecord when messageType attribute is absent", async () => {
    const event: SQSEvent = { Records: [makeSqsRecord({})] };

    const processRecordSpy = vi.spyOn(processor, "processRecord");
    await processor.process(event);

    // processRecord was called — observable via the store's dedup check
    expect(processRecordSpy).toHaveBeenCalledOnce();
    expect(store.getSignalByMessageId).toHaveBeenCalled();
  });

  it("routes to processRecord when messageType is 'inbound_signal'", async () => {
    const event: SQSEvent = { Records: [makeSqsRecord({ messageType: "inbound_signal" })] };

    const processRecordSpy = vi.spyOn(processor, "processRecord");
    await processor.process(event);

    // processRecord was called — observable via the store's dedup check
    expect(processRecordSpy).toHaveBeenCalledOnce();
    expect(store.getSignalByMessageId).toHaveBeenCalled();
  });

  it("routes to processSideEffectRecord when messageType is 'side_effect'", async () => {
    const event: SQSEvent = { Records: [makeSqsRecord({ messageType: "side_effect" })] };

    const processRecordSpy = vi.spyOn(processor, "processRecord");
    await processor.process(event);

    // processRecord was NOT called — the side-effect handler was used instead
    expect(processRecordSpy).not.toHaveBeenCalled();
    // The inbound signal pipeline (dedup check, MIME parse, classify) was not invoked
    expect(store.getSignalByMessageId).not.toHaveBeenCalled();
  });
});
