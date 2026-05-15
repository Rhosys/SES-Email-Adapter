// Feature: split-embedding-pipeline, Property 3: Secondary failures are tolerated
// **Validates: Requirements 2.2, 2.3**
//
// For any combination of secondary cluster failures (from 1 failure up to all
// secondaries failing), the processor SHALL continue processing without returning
// a batch item failure, and SHALL log a WARN with code `embedding.secondary_failed`
// for each failure.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SQSEvent } from "aws-lambda";
import { ok, err } from "neverthrow";
import fc from "fast-check";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Alias, AliasSender } from "../types/index.js";
import { bedrockError } from "../errors.js";
import type { BedrockError } from "../errors.js";
import type { Result } from "../errors.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster-registry — single primary cluster (secondaries are mocked via
// the EmbeddingGenerator interface, not the registry)
// ---------------------------------------------------------------------------

vi.mock("../embedding/cluster-registry.js", () => {
  const entry = Object.freeze({
    registryId: "aurora-prod-titan-v2",
    clusterArn: "arn:aws:rds:eu-west-1:123456789012:cluster:aurora-prod-titan-v2",
    secretArn: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:aurora-prod-titan-v2-xxxxxx",
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
    getSecondaryClusters: () => [],
  };
});

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-secondary-fail";

const DEFAULT_ALIAS: Alias = {
  id: "cfg-default",
  accountId: TEST_ACCOUNT_ID,
  address: "user@example.com",
  filterMode: "allow_all",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_SENDER_ENTRY: AliasSender = {
  accountId: TEST_ACCOUNT_ID,
  aliasAddress: "user@example.com",
  domain: "example.com",
  mode: "allow",
  addedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_CTX = {
  retentionDays: 0,
  filtering: null,
  emailConfig: DEFAULT_ALIAS,
  registeredDomains: [],
  userEmails: [],
  billingPlan: "Paid" as const,
};

// "conversation" workflow forces arc matching via similarity search
const CLASSIFICATION: ClassificationOutput = {
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
    getSender: vi.fn().mockReturnValue(Promise.resolve(ok(DEFAULT_SENDER_ENTRY))),
    saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getTemplate: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
  };
}

function makeMimeParser(): MimeParser {
  return {
    parse: vi.fn().mockResolvedValue({
      from: { address: "sender@external.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email",
      textBody: "Hello world",
      htmlBody: "<p>Hello world</p>",
      attachments: [],
      headers: {},
      sentAt: "2024-01-15T09:00:00Z",
    }),
  };
}

function makeArcMatcher(): ArcMatcher {
  return {
    findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  };
}

function makeAuroraWriter(): MultiClusterAuroraWriter {
  return {
    upsertEmbedding: vi.fn().mockResolvedValue(undefined),
    findMatch: vi.fn().mockResolvedValue(null),
  };
}

function makeSqsEvent(sesMessageId: string): SQSEvent {
  const notification = {
    accountId: TEST_ACCOUNT_ID,
    mail: { messageId: sesMessageId, timestamp: "2024-01-15T10:00:00Z", destination: ["user@example.com"] },
    receipt: {
      recipients: ["user@example.com"],
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PASS" },
      action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
    },
  };
  return {
    Records: [{
      messageId: "sqs-secondary-fail-0",
      receiptHandle: "handle",
      body: JSON.stringify({ Message: JSON.stringify(notification) }),
      attributes: { ApproximateReceiveCount: "1", SentTimestamp: "1234567890", SenderId: "sender", ApproximateFirstReceiveTimestamp: "1234567890" },
      messageAttributes: {},
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:123:queue",
      awsRegion: "us-east-1",
    }],
  };
}

// ---------------------------------------------------------------------------
// Generator: random mix of Ok/Err results for secondary clusters, with at
// least 1 failure guaranteed
// ---------------------------------------------------------------------------

const secondaryResultArb = fc.array(
  fc.oneof(fc.constant("ok" as const), fc.constant("err" as const)),
  { minLength: 1, maxLength: 8 },
).filter((results) => results.some((r) => r === "err"));

function buildSecondaryResults(outcomes: Array<"ok" | "err">): Result<EmbeddingResult, BedrockError>[] {
  return outcomes.map((outcome, i) => {
    const modelId = `secondary-model-${i}`;
    if (outcome === "ok") {
      return ok({ modelId, vector: [0.1, 0.2, 0.3], dimensions: 3 });
    }
    return err(bedrockError(modelId, new Error(`secondary failure ${i}`)));
  });
}

// ---------------------------------------------------------------------------
// Property 3: Secondary failures are tolerated
// ---------------------------------------------------------------------------

describe("Feature: split-embedding-pipeline, Property 3: Secondary failures are tolerated", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("for any combination of secondary failures, the processor does NOT return a batch item failure and logs WARN for each failure", async () => {
    await fc.assert(
      fc.asyncProperty(secondaryResultArb, async (outcomes) => {
        mockLogger = createMockLogger();

        const secondaryResults = buildSecondaryResults(outcomes);
        const expectedFailureCount = outcomes.filter((o) => o === "err").length;

        const embeddingGenerator: EmbeddingGenerator = {
          generateForModel: vi.fn().mockResolvedValue(
            ok({ modelId: "amazon.titan-embed-text-v2:0", vector: Array(1024).fill(0.5), dimensions: 1024 }),
          ),
          generateForSecondaryClusters: vi.fn().mockResolvedValue(secondaryResults),
        };

        const processor = new SignalProcessor({
          store: makeStore(),
          mimeParser: makeMimeParser(),
          classifier: { classify: vi.fn().mockResolvedValue({ ...CLASSIFICATION }) },
          embeddingGenerator,
          auroraWriter: makeAuroraWriter(),
          arcMatcher: makeArcMatcher(),
          ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
          logger: mockLogger,
        });

        const result = await processor.process(makeSqsEvent("test-msg-secondary-fail"));

        // Assert: NO batch item failures — processing continues despite secondary errors
        expect(result.batchItemFailures).toHaveLength(0);

        // Assert: WARN logged with code `embedding.secondary_failed` for each Err result
        const warnCalls = mockLogger.calls.filter(
          (c) => c.method === "warn" && c.context?.code === "embedding.secondary_failed",
        );
        expect(warnCalls).toHaveLength(expectedFailureCount);
      }),
      { numRuns: 100 },
    );
  });
});
