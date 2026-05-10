import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { S3RetentionService, S3RetentionInput } from "../embedding/s3-retention-service.js";
import { getRetentionForPlan, type BillingPlan } from "../embedding/retention-tier.js";
import type { Signal, Alias, AliasSender } from "../types/index.js";
import { propertyRunner } from "../testing/property-runner.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry
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
  };
});

// ---------------------------------------------------------------------------
// Property 19: Plan changes never retroactively retag
// **Validates: Requirements 8.7**
// ---------------------------------------------------------------------------

describe("Property 19: Plan changes never retroactively retag", () => {
  const TEST_ACCOUNT_ID = "acct-prop19";

  const DEFAULT_EMAIL_CONFIG: Alias = {
    id: "cfg-default",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    filterMode: "quarantine_visible",
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
      getSignalByMessageId: vi.fn().mockResolvedValue(null),
      saveSignal: vi.fn().mockResolvedValue(undefined),
      updateSignalRetention: vi.fn().mockResolvedValue(undefined),
      getArc: vi.fn().mockResolvedValue(null),
      findArcByGroupingKey: vi.fn().mockResolvedValue(null),
      saveArc: vi.fn().mockResolvedValue(undefined),
      listEnabledRules: vi.fn().mockResolvedValue(SYSTEM_RULES),
      getProcessorAccountContext: vi.fn().mockResolvedValue({
        retentionDays: 0,
        filtering: null,
        emailConfig: DEFAULT_EMAIL_CONFIG,
        registeredDomains: [],
        userEmails: [],
        billingPlan: 'Paid' as BillingPlan,
      }),
      saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(a)),
      getSender: vi.fn().mockResolvedValue(DEFAULT_SENDER_ENTRY),
      saveSender: vi.fn().mockResolvedValue(undefined),
      getTemplate: vi.fn().mockResolvedValue(null),
      updateGlobalReputation: vi.fn().mockResolvedValue(undefined),
      getDomainByName: vi.fn().mockResolvedValue(null),
    };
  }

  function makeMimeParser(): MimeParser {
    return {
      parse: vi.fn().mockResolvedValue({
        from: { address: "sender@example.com", name: "Sender" },
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

  function makeClassifier(): Pick<SignalClassifier, "classify"> {
    return {
      classify: vi.fn().mockResolvedValue({ ...validClassification }),
    };
  }

  function makeArcMatcher(): ArcMatcher {
    return {
      findMatch: vi.fn().mockResolvedValue(null),
      upsertEmbedding: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeSqsEvent(sesMessageId: string, s3Key: string): SQSEvent {
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
        action: { bucketName: "test-bucket", objectKey: s3Key },
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

  it.skip(
    "Free-to-Paid: old signal retains Free tier retention, new signal gets Paid tier retention",
    () => {
      return propertyRunner.assert(
        fc.asyncProperty(
          fc.string({ minLength: 5, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
          fc.string({ minLength: 5, maxLength: 50 }).filter((s) => s.startsWith("inbox/")),
          fc.string({ minLength: 5, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
          fc.string({ minLength: 5, maxLength: 50 }).filter((s) => s.startsWith("inbox/")),
          async (sesMessageId1, s3Key1, sesMessageId2, s3Key2) => {
            const store = makeStore();
            const mimeParser = makeMimeParser();
            const classifier = makeClassifier();
            const arcMatcher = makeArcMatcher();

            const s3RetentionCalls: S3RetentionInput[] = [];

            const s3RetentionService: S3RetentionService = {
              applyPlanRetention: vi.fn().mockImplementation(async (s3Key: string, input: S3RetentionInput) => {
                s3RetentionCalls.push(input);
                if (input.copyToSaved) {
                  return { s3Key: s3Key.replace("inbox/", "saved/") };
                }
                return { s3Key };
              }),
            };

            const processor = new SignalProcessor({
              store,
              mimeParser,
              classifier,
              embeddingGenerator: {
                generateForActiveClusters: vi.fn().mockResolvedValue([
                  { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 },
                ] as EmbeddingResult[]),
                generateForModel: vi.fn().mockResolvedValue(
                  { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 } as EmbeddingResult,
                ),
              },
              auroraWriter: {
                upsertEmbedding: vi.fn().mockResolvedValue(undefined),
                findMatch: vi.fn().mockResolvedValue(null),
              },
              arcMatcher,
              ruleEvaluator: new JsonLogicRuleEvaluator(),
              retentionService: s3RetentionService,
            });

            // Step 1: Process first signal under FREE plan
            vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
              retentionDays: 0,
              filtering: null,
              emailConfig: DEFAULT_EMAIL_CONFIG,
              registeredDomains: [],
              userEmails: [],
              billingPlan: 'Free' as BillingPlan,
            });

            await processor.process(makeSqsEvent(sesMessageId1, s3Key1));

            // Step 2: Process second signal under PAID plan
            vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
              retentionDays: 0,
              filtering: null,
              emailConfig: DEFAULT_EMAIL_CONFIG,
              registeredDomains: [],
              userEmails: [],
              billingPlan: 'Paid' as BillingPlan,
            });

            await processor.process(makeSqsEvent(sesMessageId2, s3Key2));

            // Verify S3 retention service was called with correct inputs
            expect(s3RetentionCalls).toHaveLength(2);

            // First call should be for Free tier (with P1Y tag)
            expect(s3RetentionCalls[0]!.s3Tag).toBe("retention-tier=P1Y");

            // Second call should be for Paid tier (no tag)
            expect(s3RetentionCalls[1]!.s3Tag).toBeNull();

            // Verify updateSignalRetention was called for both signals
            const updateRetentionCalls = (store.updateSignalRetention as ReturnType<typeof vi.fn>).mock.calls;
            expect(updateRetentionCalls.length).toBe(2);

            // First signal should have P1Y retention persisted
            expect(updateRetentionCalls[0]![2]).toMatchObject({ retentionDuration: 'P1Y' });

            // Second signal should have P5Y retention persisted
            expect(updateRetentionCalls[1]![2]).toMatchObject({ retentionDuration: 'P5Y' });
          },
        ),
      );
    },
  );

  it.skip(
    "Paid-to-Free: old signal retains Paid tier retention, new signal gets Free tier retention",
    () => {
      return propertyRunner.assert(
        fc.asyncProperty(
          fc.string({ minLength: 5, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
          fc.string({ minLength: 5, maxLength: 50 }).filter((s) => s.startsWith("inbox/")),
          fc.string({ minLength: 5, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
          fc.string({ minLength: 5, maxLength: 50 }).filter((s) => s.startsWith("inbox/")),
          async (sesMessageId1, s3Key1, sesMessageId2, s3Key2) => {
            const store = makeStore();
            const mimeParser = makeMimeParser();
            const classifier = makeClassifier();
            const arcMatcher = makeArcMatcher();

            const s3RetentionCalls: S3RetentionInput[] = [];

            const s3RetentionService: S3RetentionService = {
              applyPlanRetention: vi.fn().mockImplementation(async (s3Key: string, input: S3RetentionInput) => {
                s3RetentionCalls.push(input);
                return { s3Key };
              }),
            };

            const processor = new SignalProcessor({
              store,
              mimeParser,
              classifier,
              embeddingGenerator: {
                generateForActiveClusters: vi.fn().mockResolvedValue([
                  { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 },
                ] as EmbeddingResult[]),
                generateForModel: vi.fn().mockResolvedValue(
                  { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 } as EmbeddingResult,
                ),
              },
              auroraWriter: {
                upsertEmbedding: vi.fn().mockResolvedValue(undefined),
                findMatch: vi.fn().mockResolvedValue(null),
              },
              arcMatcher,
              ruleEvaluator: new JsonLogicRuleEvaluator(),
              retentionService: s3RetentionService,
            });

            // Step 1: Process first signal under PAID plan
            vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
              retentionDays: 0,
              filtering: null,
              emailConfig: DEFAULT_EMAIL_CONFIG,
              registeredDomains: [],
              userEmails: [],
              billingPlan: 'Paid' as BillingPlan,
            });

            await processor.process(makeSqsEvent(sesMessageId1, s3Key1));

            // Step 2: Process second signal under FREE plan
            vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
              retentionDays: 0,
              filtering: null,
              emailConfig: DEFAULT_EMAIL_CONFIG,
              registeredDomains: [],
              userEmails: [],
              billingPlan: 'Free' as BillingPlan,
            });

            await processor.process(makeSqsEvent(sesMessageId2, s3Key2));

            // Verify S3 retention service was called with correct inputs
            expect(s3RetentionCalls).toHaveLength(2);

            // First call should be for Paid tier (no tag)
            expect(s3RetentionCalls[0]!.s3Tag).toBeNull();

            // Second call should be for Free tier (with P1Y tag)
            expect(s3RetentionCalls[1]!.s3Tag).toBe("retention-tier=P1Y");

            // Verify updateSignalRetention was called for both signals
            const updateRetentionCalls = (store.updateSignalRetention as ReturnType<typeof vi.fn>).mock.calls;
            expect(updateRetentionCalls.length).toBe(2);

            // First signal should have P5Y retention persisted
            expect(updateRetentionCalls[0]![2]).toMatchObject({ retentionDuration: 'P5Y' });

            // Second signal should have P1Y retention persisted
            expect(updateRetentionCalls[1]![2]).toMatchObject({ retentionDuration: 'P1Y' });
          },
        ),
      );
    },
  );

  it.skip(
    "Free-to-Premium: old signal retains Free tier retention, new signal gets Premium retention with copy to saved",
    () => {
      return propertyRunner.assert(
        fc.asyncProperty(
          fc.string({ minLength: 5, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
          fc.string({ minLength: 5, maxLength: 50 }).filter((s) => s.startsWith("inbox/")),
          fc.string({ minLength: 5, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
          fc.string({ minLength: 5, maxLength: 50 }).filter((s) => s.startsWith("inbox/")),
          async (sesMessageId1, s3Key1, sesMessageId2, s3Key2) => {
            const store = makeStore();
            const mimeParser = makeMimeParser();
            const classifier = makeClassifier();
            const arcMatcher = makeArcMatcher();

            const s3RetentionCalls: S3RetentionInput[] = [];

            const s3RetentionService: S3RetentionService = {
              applyPlanRetention: vi.fn().mockImplementation(async (s3Key: string, input: S3RetentionInput) => {
                s3RetentionCalls.push(input);
                if (input.copyToSaved) {
                  return { s3Key: s3Key.replace("inbox/", "saved/") };
                }
                return { s3Key };
              }),
            };

            const processor = new SignalProcessor({
              store,
              mimeParser,
              classifier,
              embeddingGenerator: {
                generateForActiveClusters: vi.fn().mockResolvedValue([
                  { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 },
                ] as EmbeddingResult[]),
                generateForModel: vi.fn().mockResolvedValue(
                  { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 } as EmbeddingResult,
                ),
              },
              auroraWriter: {
                upsertEmbedding: vi.fn().mockResolvedValue(undefined),
                findMatch: vi.fn().mockResolvedValue(null),
              },
              arcMatcher,
              ruleEvaluator: new JsonLogicRuleEvaluator(),
              retentionService: s3RetentionService,
            });

            // Step 1: Process first signal under FREE plan
            vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
              retentionDays: 0,
              filtering: null,
              emailConfig: DEFAULT_EMAIL_CONFIG,
              registeredDomains: [],
              userEmails: [],
              billingPlan: 'Free' as BillingPlan,
            });

            await processor.process(makeSqsEvent(sesMessageId1, s3Key1));

            // Step 2: Process second signal under PREMIUM plan
            vi.mocked(store.getProcessorAccountContext).mockResolvedValueOnce({
              retentionDays: 0,
              filtering: null,
              emailConfig: DEFAULT_EMAIL_CONFIG,
              registeredDomains: [],
              userEmails: [],
              billingPlan: 'Premium' as BillingPlan,
            });

            await processor.process(makeSqsEvent(sesMessageId2, s3Key2));

            // Verify S3 retention service was called with correct inputs
            expect(s3RetentionCalls).toHaveLength(2);

            // First call should be for Free tier (with P1Y tag)
            expect(s3RetentionCalls[0]!.s3Tag).toBe("retention-tier=P1Y");
            expect(s3RetentionCalls[0]!.copyToSaved).toBe(false);

            // Second call should be for Premium tier (no tag, copy to saved)
            expect(s3RetentionCalls[1]!.s3Tag).toBeNull();
            expect(s3RetentionCalls[1]!.copyToSaved).toBe(true);

            // Verify updateSignalRetention was called for both signals
            const updateRetentionCalls = (store.updateSignalRetention as ReturnType<typeof vi.fn>).mock.calls;
            expect(updateRetentionCalls.length).toBe(2);

            // First signal should have P1Y retention persisted
            expect(updateRetentionCalls[0]![2]).toMatchObject({ retentionDuration: 'P1Y' });

            // Second signal should have P1000Y retention persisted with saved/ s3Key
            expect(updateRetentionCalls[1]![2]).toMatchObject({ retentionDuration: 'P1000Y' });
            expect(updateRetentionCalls[1]![2].s3Key).toContain("saved/");
          },
        ),
      );
    },
  );
});
