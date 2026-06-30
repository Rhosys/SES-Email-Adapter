import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
// Feature: split-embedding-pipeline, Property 3: Secondary failures are tolerated
// **Validates: Requirements 2.2, 2.3**
//
// For any combination of secondary cluster failures (from 1 failure up to all
// secondaries failing), the processor SHALL continue processing without returning
// a batch item failure, and SHALL log a WARN with code `embedding.secondary_failed`
// for each failure.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ArcMatcher, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock, applyCtx } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/arc-matcher.js";
import type { Alias, AliasSender } from "../../src/types/index.js";
import { bedrockError } from "../../src/errors.js";
import type { BedrockError } from "../../src/errors.js";
import type { Result } from "../../src/errors.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster-registry — single primary cluster (secondaries are mocked via
// the EmbeddingGenerator interface, not the registry)
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
// Constants and helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-secondary-fail";

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

// "conversation" workflow forces arc matching via similarity search
const CLASSIFICATION: ClassificationOutput = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
  tags: [],
  summary: "A test email.",
  labels: [],
};

function makeStore() {
  const accountDb = makeAccountDbMock(TEST_ACCOUNT_ID);
  applyCtx(accountDb, DEFAULT_CTX);
  return { arcDb: makeArcDbMock(), accountDb, processingDb: makeProcessingDbMock() };
}

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
    s3Key: `emails/${sesMessageId}`,
    sesMessageId,
    idempotencyKey: "test-idempotency-key",
    timestamp: "2024-01-15T10:00:00Z",
    destination: ["user@example.com"],
    dkimVerdict: "PASS",
    dmarcVerdict: "PASS",
  };
}

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
// Static test cases: distinct failure combinations
// ---------------------------------------------------------------------------

const cases = [
  {
    scenario: "1 secondary, 1 failure (minimum case)",
    outcomes: ["err"] as Array<"ok" | "err">,
    expectedFailureCount: 1,
  },
  {
    scenario: "3 secondaries, all fail (maximum failure)",
    outcomes: ["err", "err", "err"] as Array<"ok" | "err">,
    expectedFailureCount: 3,
  },
  {
    scenario: "3 secondaries, 2 fail + 1 succeeds (mixed)",
    outcomes: ["err", "ok", "err"] as Array<"ok" | "err">,
    expectedFailureCount: 2,
  },
  {
    scenario: "5 secondaries, 1 fails among many successes",
    outcomes: ["ok", "ok", "err", "ok", "ok"] as Array<"ok" | "err">,
    expectedFailureCount: 1,
  },
];

// ---------------------------------------------------------------------------
// Property 3: Secondary failures are tolerated
// ---------------------------------------------------------------------------

describe("Feature: split-embedding-pipeline, Property 3: Secondary failures are tolerated", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(cases)("$scenario", async ({ outcomes, expectedFailureCount }) => {
    const secondaryResults = buildSecondaryResults(outcomes);

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: Array(1024).fill(0.5), dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue(secondaryResults),
    };

    const processor = new SignalProcessor({ ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: { classify: vi.fn().mockResolvedValue(ok({ ...CLASSIFICATION })) },
      embeddingGenerator,
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" },
    });

    const result = await processor.processRecord(makeMessage("test-msg-secondary-fail"), 1);

    // Assert: NO batch item failures — processing continues despite secondary errors
    expect(result.isOk()).toBe(true);

    // Assert: WARN logged with code `embedding.secondary_failed` for each Err result
    const warnCalls = mockLogger.calls.filter(
      (c) => c.method === "warn" && c.context?.code === "embedding.secondary_failed",
    );
    expect(warnCalls).toHaveLength(expectedFailureCount);
  });
});
