import { describe, it, expect, vi } from "vitest";
import { ok } from "../../src/errors.js";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ArcDatabase } from "../../src/database/arc-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier, ClassificationOutput } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/multi-cluster-aurora-writer.js";
import type { ArcMatcher } from "../../src/processor/processor.js";
import type { S3RetentionService } from "../../src/embedding/s3-retention-service.js";
import type { Arc, Alias, EmailTemplate, Rule } from "../../src/types/index.js";
import type { InboundSignalMessage, ReplySender } from "../../src/processor/processor.js";
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

describe("Single saveArc call with complete mutations", () => {
  const TEST_ACCOUNT_ID = "acct-savearc";

  function makeMessage(sesMessageId: string, recipientEmail: string): InboundSignalMessage {
    return {
      accountId: TEST_ACCOUNT_ID,
      s3Key: `emails/${sesMessageId}`,
      sesMessageId,
      timestamp: "2024-01-15T10:00:00Z",
      destination: [recipientEmail],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
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

    const arcDb = {
      ...makeArcDbMock(),
      saveArc: vi.fn().mockImplementation((arc: Arc) => {
        saveArcCallCount++;
        savedArc = arc;
        return Promise.resolve(ok(undefined));
      }),
    } as unknown as ArcDatabase;
    const accountDb = {
      ...makeAccountDbMock(),
      listEnabledRules: vi.fn().mockReturnValue(Promise.resolve(ok([...SYSTEM_RULES, ...userRules]))),
      getProcessorAccountContext: vi.fn().mockReturnValue(Promise.resolve(ok({
        retentionDays: 0,
        filtering: null,
        emailConfig: {
          id: "cfg-001", accountId: TEST_ACCOUNT_ID, address: recipientEmail,
          unknownSenderPolicy: "allow_all", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
        } satisfies Alias,
        registeredDomains: testCase.doPong ? [recipientDomain] : [],
        userEmails: testCase.doPong ? [senderEmail] : [],
        billingPlan: "Paid",
      }))),
      getSender: vi.fn().mockReturnValue(Promise.resolve(ok({
        accountId: TEST_ACCOUNT_ID, aliasAddress: recipientEmail,
        domain: "external.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z",
      }))),
      getTemplate: vi.fn().mockImplementation((_accountId: string, id: string) =>
        Promise.resolve(ok({
          id, accountId: TEST_ACCOUNT_ID, name: `Template ${id}`,
          subject: "Re: {{signal.subject}}", body: "Auto-reply body",
          createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
        } satisfies EmailTemplate)),
      ),
      getDomainByName: vi.fn().mockReturnValue(Promise.resolve(ok({
        id: recipientDomain, accountId: TEST_ACCOUNT_ID, domain: recipientDomain,
        receivingSetupComplete: true, senderSetupComplete: true,
        createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      }))),
    } as unknown as AccountDatabase;
    const processingDb = makeProcessingDbMock();

    const contentSanitizer: ContentSanitizerClient = {
      invoke: vi.fn().mockReturnValue(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: senderEmail, name: "Sender" },
          to: [{ address: recipientEmail }],
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
      arcDb, accountDb, processingDb,
      contentSanitizer, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com",
      classifier: { classify: vi.fn().mockResolvedValue(classification) },
      embeddingGenerator,
      auroraWriter,
      arcMatcher,
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
      replySender,
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: retentionService ?? { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "emails/test-ses-id" }) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud" },
    });

    await processor.processRecord(makeMessage("test-ses-id", recipientEmail), 1);

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
