import { describe, it, expect, vi } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import type { InboundSignalMessage, ArcMatcher } from "../../src/processor/processor.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/arc-matcher.js";
import type { Alias, AliasSender, Rule, UnknownSenderPolicy, Workflow } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import { createMockLogger } from "../helpers/mock-logger.js";

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

describe("Blocked/quarantined signals never trigger saveArc", () => {
  const TEST_ACCOUNT_ID = "acct-prop2";

  function makeStore() {
    const arcDb = makeArcDbMock();
    const accountDb = makeAccountDbMock();
    const processingDb = makeProcessingDbMock();
    return { arcDb, accountDb, processingDb };
  }

  function makeContentSanitizer(fromDomain: string): ContentSanitizerClient {
    return {
      invoke: vi.fn().mockReturnValue(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: `sender@${fromDomain}`, name: "Sender" },
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

  function makeClassifier(overrides: Partial<ClassificationOutput> = {}): Pick<SignalClassifier, "classify"> {
    return {
      classify: vi.fn().mockResolvedValue(ok({
        workflow: "conversation" as Workflow,
        workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
        tags: [],
        summary: "A test email.",
        labels: [],
        ...overrides,
      })),
    };
  }

  function makeEmbeddingGenerator(): EmbeddingGenerator {
    return {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
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
      accountId: TEST_ACCOUNT_ID,
      s3Key: `emails/${sesMessageId}`,
      sesMessageId,
      idempotencyKey: "test-idempotency-key",
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["user@example.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  interface BlockStrategy {
    label: string;
    classifier: Pick<SignalClassifier, "classify">;
    contentSanitizer: ContentSanitizerClient;
    unknownSenderPolicy: UnknownSenderPolicy;
    aliasSenderConfig: AliasSender | null;
    rules: Rule[];
  }

  const strategies: BlockStrategy[] = [
    {
      label: "spam tags present → SR-04 quarantines",
      classifier: makeClassifier({ tags: ["phishing"], workflow: "conversation" }),
      contentSanitizer: makeContentSanitizer("spammer.com"),
      unknownSenderPolicy: "quarantine_visible",
      aliasSenderConfig: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", alias: "user", senderDomain: "spammer.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: SYSTEM_RULES,
    },
    {
      label: "onboarding workflow → SR-02 blocks",
      classifier: makeClassifier({ workflow: "onboarding" as import("../../src/types/index.js").Workflow, workflowData: { workflow: "onboarding", service: "acme.com", onboardingType: "welcome" } as unknown as import("../../src/types/index.js").WorkflowData }),
      contentSanitizer: makeContentSanitizer("acme.com"),
      unknownSenderPolicy: "quarantine_visible",
      aliasSenderConfig: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", alias: "user", senderDomain: "acme.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: SYSTEM_RULES,
    },
    {
      label: "notice workflow → SR-03 blocks",
      classifier: makeClassifier({ workflow: "notice", workflowData: { workflow: "notice", noticeType: "terms_update", provider: "gov.uk" } }),
      contentSanitizer: makeContentSanitizer("gov.uk"),
      unknownSenderPolicy: "quarantine_visible",
      aliasSenderConfig: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", alias: "user", senderDomain: "gov.uk", policy: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: SYSTEM_RULES,
    },
    {
      label: "untrusted sender + block_hidden filter mode",
      classifier: makeClassifier({ workflow: "conversation" }),
      contentSanitizer: makeContentSanitizer("unknown-sender.com"),
      unknownSenderPolicy: "block_hidden",
      aliasSenderConfig: null,
      rules: SYSTEM_RULES,
    },
    {
      label: "untrusted sender + quarantine filter mode",
      classifier: makeClassifier({ workflow: "conversation" }),
      contentSanitizer: makeContentSanitizer("unknown-sender.com"),
      unknownSenderPolicy: "quarantine_visible",
      aliasSenderConfig: null,
      rules: SYSTEM_RULES,
    },
    {
      label: "custom block rule",
      classifier: makeClassifier({ workflow: "conversation" }),
      contentSanitizer: makeContentSanitizer("example.com"),
      unknownSenderPolicy: "allow_all",
      aliasSenderConfig: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", alias: "user", senderDomain: "example.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: [{
        id: "custom-block", accountId: TEST_ACCOUNT_ID, name: "Block all",
        condition: "true", actions: [{ type: "block_hidden" }], status: "enabled",
        priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      }],
    },
    {
      label: "custom quarantine rule",
      classifier: makeClassifier({ workflow: "conversation" }),
      contentSanitizer: makeContentSanitizer("example.com"),
      unknownSenderPolicy: "allow_all",
      aliasSenderConfig: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", alias: "user", senderDomain: "example.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: [{
        id: "custom-quarantine", accountId: TEST_ACCOUNT_ID, name: "Quarantine all",
        condition: "true", actions: [{ type: "quarantine_visible" }], status: "enabled",
        priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      }],
    },
  ];

  it.each(strategies)("$label — saveArc is never called", async (strategy) => {
    const mockLogger = createMockLogger();
    const { arcDb, accountDb, processingDb } = makeStore();

    const aliasConfig: Alias = {
      id: "cfg-prop2",
      accountId: TEST_ACCOUNT_ID,
      address: "user@example.com",
      domain: "example.com",
      alias: "user",
      unknownSenderPolicy: strategy.unknownSenderPolicy,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    (accountDb.getProcessorAccountContext as ReturnType<typeof vi.fn>).mockReturnValue(Promise.resolve(ok({
      retentionDuration: "P3M",
      filtering: null,
      aliasConfig,
      registeredDomains: [],
      userEmails: [],
      billingPlan: "Paid" as const,
    })));
    (accountDb.getSender as ReturnType<typeof vi.fn>).mockReturnValue(Promise.resolve(ok(strategy.aliasSenderConfig)));
    (accountDb.listEnabledRules as ReturnType<typeof vi.fn>).mockReturnValue(Promise.resolve(ok(strategy.rules)));

    const processor = new SignalProcessor({ ...makeSharedNewDeps(),
      arcDb,
      accountDb,
      processingDb,
      contentSanitizer: strategy.contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket",
      classifier: strategy.classifier,
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: makeRuleEvaluator3(mockLogger),
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "emails/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" },
    });

    await processor.processRecord(makeMessage("msg-blocked-test"), 1);

    expect(arcDb.saveArc).not.toHaveBeenCalled();
  });
});
