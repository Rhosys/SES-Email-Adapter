// Feature: split-embedding-pipeline, Property 2: Primary vector flows to arc matcher
//
// **Validates: Requirements 1.3**
//
// For any successful primary embedding result, the exact vector from that result
// SHALL be passed to the arc matcher's `findMatch` method — no transformation,
// truncation, or substitution.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { ok } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Alias, AliasSender } from "../types/index.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster registry — single active cluster forces similarity search path
// ---------------------------------------------------------------------------

vi.mock("../embedding/cluster-registry.js", () => {
  const entry = Object.freeze({
    clusterId: "aurora-prod-titan-v2",
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
    getClusterById: (id: string) => (id === entry.clusterId ? entry : null),
    getReadCluster: () => entry,
    getSecondaryClusters: () => [],
  };
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-prop2";

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

// Use "conversation" workflow — deriveGroupingKey returns null for this,
// which forces the processor to use arc matcher similarity search.
const CLASSIFICATION: ClassificationOutput = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
  spamScore: 0.05,
  summary: "Test email.",
  labels: [],
  classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeSqsEvent(sesMessageId: string): SQSEvent {
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
  return {
    Records: [{
      messageId: "sqs-1",
      receiptHandle: "handle",
      body: JSON.stringify({ Message: JSON.stringify(notification) }),
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "1234567890",
        SenderId: "sender",
        ApproximateFirstReceiveTimestamp: "1234567890",
      },
      messageAttributes: {},
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:123:queue",
      awsRegion: "us-east-1",
    }],
  };
}

// ---------------------------------------------------------------------------
// Property 2: Primary vector flows to arc matcher
// ---------------------------------------------------------------------------

describe("Feature: split-embedding-pipeline, Property 2: Primary vector flows to arc matcher", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("the exact vector from generateForModel Ok result is passed to arcMatcher.findMatch — byte-for-byte identical", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e10, max: 1e10 }), { minLength: 1024, maxLength: 1024 }),
        async (vector) => {
          // Capture the vector received by the arc matcher
          let receivedVector: number[] | undefined;

          const arcMatcher: ArcMatcher = {
            findMatch: vi.fn().mockImplementation((_accountId: string, _recipientAddress: string, embedding: number[]) => {
              receivedVector = embedding;
              return Promise.resolve(ok(null));
            }),
            upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
          };

          const embeddingGenerator: EmbeddingGenerator = {
            generateForModel: vi.fn().mockResolvedValue(
              ok({ modelId: "amazon.titan-embed-text-v2:0", vector, dimensions: 1024 }),
            ),
            generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
          };

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store: makeStore(),
            mimeParser: makeMimeParser(),
            classifier: { classify: vi.fn().mockResolvedValue({ ...CLASSIFICATION }) },
            embeddingGenerator,
            auroraWriter,
            arcMatcher,
            ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
            logger: mockLogger,
          });

          await processor.process(makeSqsEvent("ses-prop2-test"));

          // Arc matcher must have been called
          expect(arcMatcher.findMatch).toHaveBeenCalledOnce();

          // The vector passed to findMatch must be the exact same reference or identical values
          expect(receivedVector).toBeDefined();
          expect(receivedVector).toHaveLength(vector.length);

          // Byte-for-byte comparison: every element must be strictly equal
          for (let i = 0; i < vector.length; i++) {
            expect(receivedVector![i]).toBe(vector[i]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
