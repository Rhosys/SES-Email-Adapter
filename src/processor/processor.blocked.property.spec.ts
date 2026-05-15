import { describe, it, expect, vi } from "vitest";
import type { SQSEvent } from "aws-lambda";
import { ok, okAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Alias, AliasSender, Rule, SenderFilterMode, Workflow } from "../types/index.js";
import { createMockLogger } from "../testing/mock-logger.js";

vi.mock("../embedding/cluster-registry.js", () => {
  const entry = Object.freeze({
    clusterId: "aurora-prod-titan-v2",
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
    getClusterById: (id: string) => (id === entry.clusterId ? entry : null),
    getReadCluster: () => entry,
  };
});

describe("Blocked/quarantined signals never trigger saveArc", () => {
  const TEST_ACCOUNT_ID = "acct-prop2";

  function makeStore(): ProcessorDatabase {
    return {
      getSignalByMessageId: vi.fn().mockReturnValue(okAsync(null)),
      saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
      updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
      getArc: vi.fn().mockReturnValue(okAsync(null)),
      findArcByGroupingKey: vi.fn().mockReturnValue(okAsync(null)),
      saveArc: vi.fn().mockReturnValue(okAsync(undefined)),
      listEnabledRules: vi.fn().mockReturnValue(okAsync(SYSTEM_RULES)),
      getProcessorAccountContext: vi.fn().mockReturnValue(okAsync(null)),
      saveAlias: vi.fn().mockImplementation((a: Alias) => okAsync(a)),
      getSender: vi.fn().mockReturnValue(okAsync(null)),
      saveSender: vi.fn().mockReturnValue(okAsync(undefined)),
      getTemplate: vi.fn().mockReturnValue(okAsync(null)),
      updateGlobalReputation: vi.fn().mockReturnValue(okAsync(undefined)),
      getDomainByName: vi.fn().mockReturnValue(okAsync(null)),
    };
  }

  function makeMimeParser(fromDomain: string): MimeParser {
    return {
      parse: vi.fn().mockResolvedValue({
        from: { address: `sender@${fromDomain}`, name: "Sender" },
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

  function makeClassifier(overrides: Partial<ClassificationOutput> = {}): Pick<SignalClassifier, "classify"> {
    return {
      classify: vi.fn().mockResolvedValue({
        workflow: "conversation" as Workflow,
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.05,
        summary: "A test email.",
        labels: [],
        classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
        ...overrides,
      }),
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
      findMatch: vi.fn().mockReturnValue(okAsync(null)),
      upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)),
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
        messageId: "sqs-1",
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

  interface BlockStrategy {
    label: string;
    classifier: Pick<SignalClassifier, "classify">;
    mimeParser: MimeParser;
    filterMode: SenderFilterMode;
    senderEntry: AliasSender | null;
    rules: Rule[];
  }

  const strategies: BlockStrategy[] = [
    {
      label: "high spam score → SR-03 quarantines",
      classifier: makeClassifier({ spamScore: 0.95, workflow: "conversation" }),
      mimeParser: makeMimeParser("spammer.com"),
      filterMode: "quarantine_visible",
      senderEntry: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "spammer.com", mode: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: SYSTEM_RULES,
    },
    {
      label: "onboarding workflow → SR-01 blocks",
      classifier: makeClassifier({ workflow: "onboarding", workflowData: { workflow: "onboarding", service: "acme.com", onboardingType: "welcome" } }),
      mimeParser: makeMimeParser("acme.com"),
      filterMode: "quarantine_visible",
      senderEntry: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "acme.com", mode: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: SYSTEM_RULES,
    },
    {
      label: "status workflow → SR-05 blocks",
      classifier: makeClassifier({ workflow: "status", workflowData: { workflow: "status", statusType: "terms_update", provider: "gov.uk" } }),
      mimeParser: makeMimeParser("gov.uk"),
      filterMode: "quarantine_visible",
      senderEntry: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "gov.uk", mode: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: SYSTEM_RULES,
    },
    {
      label: "untrusted sender + block filter mode",
      classifier: makeClassifier({ workflow: "conversation" }),
      mimeParser: makeMimeParser("unknown-sender.com"),
      filterMode: "block",
      senderEntry: null,
      rules: SYSTEM_RULES,
    },
    {
      label: "untrusted sender + quarantine filter mode",
      classifier: makeClassifier({ workflow: "conversation" }),
      mimeParser: makeMimeParser("unknown-sender.com"),
      filterMode: "quarantine_visible",
      senderEntry: null,
      rules: SYSTEM_RULES,
    },
    {
      label: "custom block rule",
      classifier: makeClassifier({ workflow: "conversation" }),
      mimeParser: makeMimeParser("example.com"),
      filterMode: "allow_all",
      senderEntry: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", mode: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: [{
        id: "custom-block", accountId: TEST_ACCOUNT_ID, name: "Block all",
        condition: "true", actions: [{ type: "block" }], status: "enabled",
        priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      }],
    },
    {
      label: "custom quarantine rule",
      classifier: makeClassifier({ workflow: "conversation" }),
      mimeParser: makeMimeParser("example.com"),
      filterMode: "allow_all",
      senderEntry: { accountId: TEST_ACCOUNT_ID, aliasAddress: "user@example.com", domain: "example.com", mode: "allow", addedAt: "2024-01-01T00:00:00Z" },
      rules: [{
        id: "custom-quarantine", accountId: TEST_ACCOUNT_ID, name: "Quarantine all",
        condition: "true", actions: [{ type: "quarantine" }], status: "enabled",
        priorityOrder: 0, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      }],
    },
  ];

  it.each(strategies)("$label — saveArc is never called", async (strategy) => {
    const mockLogger = createMockLogger();
    const store = makeStore();

    const emailConfig: Alias = {
      id: "cfg-prop2",
      accountId: TEST_ACCOUNT_ID,
      address: "user@example.com",
      filterMode: strategy.filterMode,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    (store.getProcessorAccountContext as ReturnType<typeof vi.fn>).mockReturnValue(okAsync({
      retentionDays: 0,
      filtering: null,
      emailConfig,
      registeredDomains: [],
      userEmails: [],
      billingPlan: "Paid" as const,
    }));
    (store.getSender as ReturnType<typeof vi.fn>).mockReturnValue(okAsync(strategy.senderEntry));
    (store.listEnabledRules as ReturnType<typeof vi.fn>).mockReturnValue(okAsync(strategy.rules));

    const processor = new SignalProcessor({
      store,
      mimeParser: strategy.mimeParser,
      classifier: strategy.classifier,
      embeddingGenerator: makeEmbeddingGenerator(),
      auroraWriter: makeAuroraWriter(),
      arcMatcher: makeArcMatcher(),
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      logger: mockLogger,
    });

    await processor.process(makeSqsEvent("msg-blocked-test"));

    expect(store.saveArc).not.toHaveBeenCalled();
  });
});
