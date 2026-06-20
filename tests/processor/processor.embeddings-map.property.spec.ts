// Feature: split-embedding-pipeline, Property 4: Embeddings map composition
//
// **Validates: Requirements 2.4**
//
// For any set of secondary embedding results (mix of Ok and Err), `signal.embeddings`
// SHALL contain exactly the primary cluster's vector plus the vectors from all successful
// secondary results — no more, no less.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok, err } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ArcMatcher, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/arc-matcher.js";
import type { Alias, AliasSender, Signal } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { bedrockError } from "../../src/errors.js";
import type { Result } from "../../src/errors.js";
import type { BedrockError } from "../../src/errors.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster registry — primary cluster only (secondaries are mocked via
// generateForSecondaryClusters return value)
// ---------------------------------------------------------------------------

vi.mock("../../src/embedding/cluster-registry.js", () => {
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

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-prop4";

const DEFAULT_ALIAS: Alias = {
  id: "cfg-default",
  accountId: TEST_ACCOUNT_ID,
  address: "user@example.com",
  domain: "example.com",
  alias: "user",
  unknownSenderPolicy: "allow_all",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_SENDER_ENTRY: AliasSender = {
  accountId: TEST_ACCOUNT_ID,
  aliasAddress: "user@example.com",
  domain: "example.com",
  alias: "user",
  senderDomain: "example.com",
  policy: "allow",
  addedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_CTX = {
  retentionDuration: "P3M",
  filtering: null,
  aliasConfig: DEFAULT_ALIAS,
  registeredDomains: [],
  userEmails: [],
  billingPlan: "Paid" as const,
};

const CLASSIFICATION: ClassificationOutput = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
  tags: [],
  summary: "Test email.",
  labels: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContentSanitizer(): ContentSanitizerClient {
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
        headers: { "authentication-results": "spf=pass dkim=pass" },
        sentAt: "2024-01-15T09:00:00Z",
      },
      urlMapping: {},
    }))),
  };
}

function makeStore() {
  return { arcDb: makeArcDbMock(), accountDb: makeAccountDbMock(), processingDb: makeProcessingDbMock() };
}

function makeArcMatcher(): ArcMatcher {
  return {
    findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
    upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
  };
}

function makeAuroraWriter(): MultiClusterAuroraWriter {
  return {
    upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
    findMatch: vi.fn().mockResolvedValue(ok(null)),
  };
}

function makeMessage(sesMessageId: string): InboundSignalMessage {
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
// Static test cases: distinct embeddings map compositions
// ---------------------------------------------------------------------------

interface SecondaryInput {
  modelId: string;
  outcome: "ok" | "err";
  vector: number[];
}

function buildSecondaryResults(secondaries: SecondaryInput[]): Result<EmbeddingResult, BedrockError>[] {
  return secondaries.map((s) => {
    if (s.outcome === "ok") {
      return ok({ modelId: s.modelId, vector: s.vector, dimensions: s.vector.length });
    }
    return err(bedrockError(s.modelId, new Error("simulated failure")));
  });
}

const PRIMARY_MODEL_ID = "amazon.titan-embed-text-v2:0";
const PRIMARY_VECTOR = [0.1, 0.2, 0.3, 0.4];

const cases = [
  {
    scenario: "1 secondary, all succeed → embeddings has primary + 1 secondary",
    secondaries: [
      { modelId: "cohere-embed-v3", outcome: "ok" as const, vector: [0.5, 0.6, 0.7, 0.8] },
    ],
    expectedKeys: [PRIMARY_MODEL_ID, "cohere-embed-v3"],
  },
  {
    scenario: "3 secondaries, all succeed → embeddings has primary + 3",
    secondaries: [
      { modelId: "cohere-embed-v3", outcome: "ok" as const, vector: [0.5, 0.6, 0.7, 0.8] },
      { modelId: "titan-embed-g1", outcome: "ok" as const, vector: [0.9, 1.0, 1.1, 1.2] },
      { modelId: "bge-large-en", outcome: "ok" as const, vector: [1.3, 1.4, 1.5, 1.6] },
    ],
    expectedKeys: [PRIMARY_MODEL_ID, "cohere-embed-v3", "titan-embed-g1", "bge-large-en"],
  },
  {
    scenario: "3 secondaries, 1 fails → embeddings has primary + 2 (the successful ones)",
    secondaries: [
      { modelId: "cohere-embed-v3", outcome: "ok" as const, vector: [0.5, 0.6, 0.7, 0.8] },
      { modelId: "titan-embed-g1", outcome: "err" as const, vector: [0.9, 1.0, 1.1, 1.2] },
      { modelId: "bge-large-en", outcome: "ok" as const, vector: [1.3, 1.4, 1.5, 1.6] },
    ],
    expectedKeys: [PRIMARY_MODEL_ID, "cohere-embed-v3", "bge-large-en"],
  },
  {
    scenario: "0 secondaries → embeddings has only primary",
    secondaries: [],
    expectedKeys: [PRIMARY_MODEL_ID],
  },
];

// ---------------------------------------------------------------------------
// Property 4: Embeddings map composition
// ---------------------------------------------------------------------------

describe("Feature: split-embedding-pipeline, Property 4: Embeddings map composition", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(cases)("$scenario", async ({ secondaries, expectedKeys }) => {
    const secondaryResults = buildSecondaryResults(secondaries);

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: PRIMARY_MODEL_ID, vector: PRIMARY_VECTOR, dimensions: PRIMARY_VECTOR.length }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue(secondaryResults),
    };

    const { arcDb, accountDb, processingDb } = makeStore();

    const processor = new SignalProcessor({ ...makeSharedNewDeps(),
arcDb, accountDb, processingDb,
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: { classify: vi.fn().mockResolvedValue(ok({ ...CLASSIFICATION })) },
      embeddingGenerator,
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" },
    });

    const result = await processor.processRecord(makeMessage("ses-prop4-test"), 1);

    // Processing should succeed (no batch item failures)
    expect(result.isOk()).toBe(true);

    // Extract signal.embeddings from the saveSignal call
    expect(arcDb.saveSignal).toHaveBeenCalledOnce();
    const savedSignal = (arcDb.saveSignal as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Signal;
    const embeddings = savedSignal.data.embeddings;

    expect(embeddings).toBeDefined();

    // Build expected embeddings map
    const expected: Record<string, number[]> = { [PRIMARY_MODEL_ID]: PRIMARY_VECTOR };
    for (const s of secondaries) {
      if (s.outcome === "ok") {
        expected[s.modelId] = s.vector;
      }
    }

    // Assert: exact key set — no more, no less
    const actualKeys = Object.keys(embeddings!).sort();
    expect(actualKeys).toEqual([...expectedKeys].sort());

    // Assert: each vector matches exactly
    for (const [modelId, expectedVector] of Object.entries(expected)) {
      expect(embeddings![modelId]).toEqual(expectedVector);
    }
  });
});
