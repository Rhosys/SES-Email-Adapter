import { describe, it, expect, vi } from "vitest";
import { ok } from "../errors.js";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ReplySender } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { ArcMatcher } from "./processor.js";
import type { S3RetentionService } from "../embedding/s3-retention-service.js";
import type { Arc, Alias, EmailTemplate, Rule } from "../types/index.js";
import type { SQSEvent } from "aws-lambda";
import { createMockLogger } from "../testing/mock-logger.js";

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

describe("Single saveArc call with complete mutations", () => {
  const TEST_ACCOUNT_ID = "acct-savearc";

  function makeSqsEvent(sesMessageId: string, recipientEmail: string): SQSEvent {
    const notification = {
      accountId: TEST_ACCOUNT_ID,
      mail: { messageId: sesMessageId, timestamp: "2024-01-15T10:00:00Z", destination: [recipientEmail] },
      receipt: {
        dkimVerdict: { status: "PASS" },
        dmarcVerdict: { status: "PASS" },
        action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
      },
    };
    return {
      Records: [{
        messageId: "sqs-0",
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

  interface TestCase {
    label: string;
    workflow: "conversation" | "test";
    additionalLabels: string[];
    hasRetention: boolean;
    doPong: boolean;
  }

  const cases: TestCase[] = [
    { label: "conversation workflow, no extras", workflow: "conversation", additionalLabels: [], hasRetention: false, doPong: false },
    { label: "conversation workflow with user labels", workflow: "conversation", additionalLabels: ["urgent", "finance"], hasRetention: false, doPong: false },
    { label: "conversation workflow with retention", workflow: "conversation", additionalLabels: [], hasRetention: true, doPong: false },
    { label: "test workflow triggers pong", workflow: "test", additionalLabels: [], hasRetention: false, doPong: true },
    { label: "all features combined", workflow: "test", additionalLabels: ["important"], hasRetention: true, doPong: true },
  ];

  it.each(cases)("$label — saveArc called exactly once with accumulated mutations", async (testCase) => {
    const recipientEmail = "user@testdomain.com";
    const senderEmail = "sender@external.com";
    const recipientDomain = "testdomain.com";

    const classification: ClassificationOutput = {
      workflow: testCase.workflow,
      workflowData: testCase.workflow === "test"
        ? { workflow: "test", triggeredBy: "user" }
        : { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      spamScore: 0.01,
      summary: "Test signal.",
      labels: [],
      classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    };

    const userRules: Rule[] = testCase.additionalLabels.map((label, i) => ({
      id: `user-rule-label-${i}`,
      accountId: TEST_ACCOUNT_ID,
      name: `Add label ${label}`,
      condition: "true",
      actions: [{ type: "assign_label" as const, value: label }],
      status: "enabled" as const,
      priorityOrder: 200 + i,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }));

    let saveArcCallCount = 0;
    let savedArc: Arc | null = null;

    const store: ProcessorDatabase = {
      getSignalByMessageId: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      saveSignal: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      updateSignalRetention: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getArc: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      findArcByGroupingKey: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      saveArc: vi.fn().mockImplementation((arc: Arc) => {
        saveArcCallCount++;
        savedArc = arc;
        return Promise.resolve(ok(undefined));
      }),
      listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok([...SYSTEM_RULES, ...userRules]))),
      getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok({
        retentionDays: 0,
        filtering: null,
        emailConfig: {
          id: "cfg-001", accountId: TEST_ACCOUNT_ID, address: recipientEmail,
          filterMode: "allow_all", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
        } satisfies Alias,
        registeredDomains: testCase.doPong ? [recipientDomain] : [],
        userEmails: testCase.doPong ? [senderEmail] : [],
        billingPlan: "Paid",
      }))),
      saveAlias: vi.fn().mockImplementation((a: Alias) => Promise.resolve(ok(a))),
      getSender: vi.fn().mockReturnValue(Promise.resolve(ok({
        accountId: TEST_ACCOUNT_ID, aliasAddress: recipientEmail,
        domain: "external.com", mode: "allow", addedAt: "2024-01-01T00:00:00Z",
      }))),
      saveSender: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getTemplate: vi.fn().mockImplementation((_accountId: string, id: string) =>
        Promise.resolve(ok({
          id, accountId: TEST_ACCOUNT_ID, name: `Template ${id}`,
          subject: "Re: {{signal.subject}}", body: "Auto-reply body",
          createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
        } satisfies EmailTemplate)),
      ),
      updateGlobalReputation: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
      getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok({
        id: recipientDomain, accountId: TEST_ACCOUNT_ID, domain: recipientDomain,
        receivingSetupComplete: true, senderSetupComplete: true,
        createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      }))),
    };

    const mimeParser: MimeParser = {
      parse: vi.fn().mockResolvedValue(ok({
        from: { address: senderEmail, name: "Sender" },
        to: [{ address: recipientEmail }],
        cc: [],
        subject: "Test email",
        textBody: "Hello world",
        htmlBody: "<p>Hello world</p>",
        attachments: [],
        headers: { "authentication-results": "spf=pass dkim=pass" },
        sentAt: "2024-01-15T09:00:00Z",
      })),
    };

    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(
        ok({ modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 }),
      ),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };

    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)),
      findMatch: vi.fn().mockResolvedValue(ok(null)),
    };

    const arcMatcher: ArcMatcher = {
      findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };

    let pongMessageId: string | null = null;
    const replySender: ReplySender = {
      sendReply: vi.fn().mockImplementation(() => {
        pongMessageId = "pong-msg-001";
        return Promise.resolve({ messageId: pongMessageId });
      }),
    };

    const retentionService: S3RetentionService | undefined = testCase.hasRetention
      ? { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "emails/test-ses-id" }) }
      : undefined;

    const mockLogger = createMockLogger();
    const processor = new SignalProcessor({
      store,
      mimeParser,
      classifier: { classify: vi.fn().mockResolvedValue(classification) },
      embeddingGenerator,
      auroraWriter,
      arcMatcher,
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      replySender,
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), notifyBlocked: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: retentionService ?? { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "emails/test-ses-id" }) },
    });

    await processor.process(makeSqsEvent("test-ses-id", recipientEmail));

    expect(saveArcCallCount).toBe(1);
    expect(savedArc).not.toBeNull();

    const arc = savedArc!;
    expect(arc.status).toBe("active");

    for (const label of testCase.additionalLabels) {
      expect(arc.labels).toContain(label);
    }

    if (testCase.hasRetention) {
      expect(arc.ttl).toBeDefined();
    }

    if (testCase.doPong && pongMessageId) {
      expect(arc.sentMessageIds).toContain(pongMessageId);
    }
  });
});
