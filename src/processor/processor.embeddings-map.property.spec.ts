// Feature: split-embedding-pipeline, Property 4: Embeddings map composition
//
// **Validates: Requirements 2.4**
//
// For any set of secondary embedding results (mix of Ok and Err), `signal.embeddings`
// SHALL contain exactly the primary cluster's vector plus the vectors from all successful
// secondary results — no more, no less.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { ok, err } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Alias, AliasSender, Signal } from "../types/index.js";
import { bedrockError } from "../errors.js";
import type { Result } from "../errors.js";
import type { BedrockError } from "../errors.js";
import { createMockLogger, type MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster registry — primary cluster only (secondaries are mocked via
// generateForSecondaryClusters return value)
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
// Constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-prop4";

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
    mail: {
      messageId: sesMessageId,
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
    },
    receipt: {
      recipients: ["user@example.com"],
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PASS" },
      action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
    },
  };
  return {
    Records: [{
      messageId: "sqs-prop4-0",
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
// Generators
// ---------------------------------------------------------------------------

/** Generate a unique modelId for a secondary cluster */
const secondaryModelIdArb = (index: number) =>
  fc.string({ minLength: 1, maxLength: 30 }).map((s) => `secondary-model-${index}-${s}`);

/** Generate a short vector (we don't need full 1024 dims for this property) */
const vectorArb = fc.array(
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
  { minLength: 4, maxLength: 4 },
);

/** Generate a secondary result: either Ok with a vector or Err */
interface SecondaryInput {
  modelId: string;
  outcome: "ok" | "err";
  vector: number[];
}

const secondaryInputArb = (index: number): fc.Arbitrary<SecondaryInput> =>
  fc.record({
    modelId: secondaryModelIdArb(index),
    outcome: fc.oneof(fc.constant("ok" as const), fc.constant("err" as const)),
    vector: vectorArb,
  });

/** Generate 1–5 secondary cluster inputs */
const secondariesArb: fc.Arbitrary<SecondaryInput[]> = fc.integer({ min: 1, max: 5 }).chain((count) =>
  fc.tuple(...Array.from({ length: count }, (_, i) => secondaryInputArb(i))).map((arr) => arr),
);

/** Generate the primary vector */
const primaryVectorArb = fc.array(
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
  { minLength: 4, maxLength: 4 },
);

// ---------------------------------------------------------------------------
// Property 4: Embeddings map composition
// ---------------------------------------------------------------------------

describe("Feature: split-embedding-pipeline, Property 4: Embeddings map composition", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("signal.embeddings contains exactly the primary vector plus vectors from all successful secondary results", async () => {
    await fc.assert(
      fc.asyncProperty(primaryVectorArb, secondariesArb, async (primaryVector, secondaries) => {
        mockLogger = createMockLogger();

        const primaryModelId = "amazon.titan-embed-text-v2:0";

        // Build the secondary results array based on the generated inputs
        const secondaryResults: Result<EmbeddingResult, BedrockError>[] = secondaries.map((s) => {
          if (s.outcome === "ok") {
            return ok({ modelId: s.modelId, vector: s.vector, dimensions: s.vector.length });
          }
          return err(bedrockError(s.modelId, new Error("simulated failure")));
        });

        const embeddingGenerator: EmbeddingGenerator = {
          generateForModel: vi.fn().mockResolvedValue(
            ok({ modelId: primaryModelId, vector: primaryVector, dimensions: primaryVector.length }),
          ),
          generateForSecondaryClusters: vi.fn().mockResolvedValue(secondaryResults),
        };

        const store = makeStore();

        const processor = new SignalProcessor({
          store,
          mimeParser: makeMimeParser(),
          classifier: { classify: vi.fn().mockResolvedValue({ ...CLASSIFICATION }) },
          embeddingGenerator,
          auroraWriter: makeAuroraWriter(),
          arcMatcher: makeArcMatcher(),
          ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
          logger: mockLogger,
        });

        const result = await processor.process(makeSqsEvent("ses-prop4-test"));

        // Processing should succeed (no batch item failures)
        expect(result.batchItemFailures).toHaveLength(0);

        // Extract signal.embeddings from the saveSignal call
        expect(store.saveSignal).toHaveBeenCalledOnce();
        const savedSignal = (store.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Signal;
        const embeddings = savedSignal.embeddings;

        expect(embeddings).toBeDefined();

        // Build expected embeddings map
        const expected: Record<string, number[]> = { [primaryModelId]: primaryVector };
        for (const s of secondaries) {
          if (s.outcome === "ok") {
            expected[s.modelId] = s.vector;
          }
        }

        // Assert: exact key set — no more, no less
        const actualKeys = Object.keys(embeddings!).sort();
        const expectedKeys = Object.keys(expected).sort();
        expect(actualKeys).toEqual(expectedKeys);

        // Assert: each vector matches exactly
        for (const [modelId, expectedVector] of Object.entries(expected)) {
          expect(embeddings![modelId]).toEqual(expectedVector);
        }
      }),
      { numRuns: 100 },
    );
  });
});
