import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
// Feature: split-embedding-pipeline, Property 2: Primary vector flows to arc matcher
//
// **Validates: Requirements 1.3**
//
// For any successful primary embedding result, the exact vector from that result
// SHALL be passed to the arc matcher's `findMatch` method — no transformation,
// truncation, or substitution.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import type { Alias, AliasSender } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster registry — single active cluster forces similarity search path
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
    getPrimaryThreadMatcherRegistry: () => entry,
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

const TEST_ACCOUNT_ID = "acct-prop2";

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

// Use "conversation" workflow — deriveGroupingKey returns null for this,
// which forces the processor to use arc matcher similarity search.
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
  return { threadDb: makeThreadDbMock(), accountDb: makeAccountDbMock(TEST_ACCOUNT_ID), processingDb: makeProcessingDbMock() };
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

// ---------------------------------------------------------------------------
// Static test vectors: each exercises a distinct value pattern
// ---------------------------------------------------------------------------

/** All zeros — tests that a zero vector is not treated as "missing" */
const allZerosVector = Array.from({ length: 1024 }, () => 0);

/** Mixed positive/negative — typical embedding output */
const mixedVector = Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? 0.123456 : -0.654321));

/** Near float boundaries — tests no clamping or rounding occurs */
const boundaryVector = Array.from({ length: 1024 }, (_, i) => {
  if (i % 3 === 0) return 3.4028234e+38;   // near Float32 max
  if (i % 3 === 1) return -3.4028234e+38;  // near Float32 min
  return 1.1754944e-38;                     // near Float32 smallest positive normal
});

const cases = [
  { scenario: "all-zeros vector (not treated as missing)", vector: allZerosVector },
  { scenario: "mixed positive/negative values", vector: mixedVector },
  { scenario: "values near float32 boundaries (no clamping)", vector: boundaryVector },
] as const;

// ---------------------------------------------------------------------------
// Property 2: Primary vector flows to arc matcher
// ---------------------------------------------------------------------------

describe("Feature: split-embedding-pipeline, Property 2: Primary vector flows to arc matcher", () => {
  let mockLogger: MockLogger;
  beforeEach(() => { mockLogger = createMockLogger(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(cases)("$scenario", async ({ vector }) => {
    let receivedVector: number[] | undefined;

    const threadMatcher: ThreadMatcherPort = {
      findMatch: vi.fn().mockImplementation((_accountId: string, _recipientAddress: string, embedding: number[]) => {
        receivedVector = embedding;
        return Promise.resolve(ok(null));
      }),
      upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: [...vector], dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const processor = new SignalProcessor({ ...makeSharedNewDeps(),
      ...makeStore(),
      contentSanitizer: makeContentSanitizer(), s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: { classify: vi.fn().mockResolvedValue(ok({ ...CLASSIFICATION })) },
      embeddingGenerator,
      auroraWriter,
      threadMatcher,
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

    await processor.processRecord(makeMessage("ses-prop2-test"), 1);

    // Arc matcher must have been called
    expect(threadMatcher.findMatch).toHaveBeenCalledOnce();

    // The vector passed to findMatch must be identical values
    expect(receivedVector).toBeDefined();
    expect(receivedVector).toHaveLength(1024);

    // Byte-for-byte comparison: every element must be strictly equal
    for (let i = 0; i < vector.length; i++) {
      expect(receivedVector![i]).toBe(vector[i]);
    }
  });
});
