import { describe, it, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { okAsync } from "neverthrow";
import { propertyRunner } from "../testing/property-runner.js";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, TestReplier } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { ArcMatcher } from "./processor.js";
import type { S3RetentionService } from "../embedding/s3-retention-service.js";
import type { Arc, Alias, EmailTemplate } from "../types/index.js";
import type { SQSEvent } from "aws-lambda";
import { createMockLogger } from "../testing/mock-logger.js";

// Mock cluster-registry so processor can resolve the read cluster
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

/**
 * Feature: dynamodb-storage-optimization, Property 1: Single saveArc call with complete mutations
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6
 */
describe("Feature: dynamodb-storage-optimization, Property 1: Single saveArc call with complete mutations", () => {

  // Generators for random inputs that produce non-blocked, non-quarantined paths
  // We use "conversation" workflow with low spam score and an approved sender to ensure
  // the signal passes through without being blocked or quarantined.

  const arbAccountId = fc.uuid();
  const arbSesMessageId = fc.uuid();
  const arbTimestamp = fc.integer({ min: new Date("2024-01-01").getTime(), max: new Date("2025-01-01").getTime() }).map((ms) => new Date(ms).toISOString());
  const arbEmail = fc.tuple(
    fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/),
    fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/),
    fc.constantFrom("com", "org", "net", "io"),
  ).map(([user, domain, tld]) => `${user}@${domain}.${tld}`);

  const arbUrgency = fc.constantFrom("critical" as const, "high" as const, "normal" as const, "low" as const, "silent" as const);

  // Whether pong should be triggered (test workflow)
  const arbDoPong = fc.boolean();

  // Number of auto-reply templates (0-3)
  const arbAutoReplyCount = fc.integer({ min: 0, max: 3 });

  // Whether retention service is enabled
  const arbHasRetention = fc.boolean();

  // Retention TTL value
  const arbRetentionTtl = fc.integer({ min: 86400, max: 86400 * 365 });

  // Combined test input
  const arbTestInput = fc.record({
    accountId: arbAccountId,
    sesMessageId: arbSesMessageId,
    timestamp: arbTimestamp,
    senderEmail: arbEmail,
    recipientEmail: arbEmail,
    doPong: arbDoPong,
    autoReplyCount: arbAutoReplyCount,
    hasRetention: arbHasRetention,
    retentionTtl: arbRetentionTtl,
    urgency: fc.option(arbUrgency, { nil: undefined }),
    additionalLabels: fc.array(fc.stringMatching(/^[a-z]{3,10}$/), { minLength: 0, maxLength: 3 }),
  });

  function makeSqsEvent(msg: { accountId: string; sesMessageId: string; timestamp: string; destination: string[] }): SQSEvent {
    const notification = {
      accountId: msg.accountId,
      mail: {
        messageId: msg.sesMessageId,
        timestamp: msg.timestamp,
        destination: msg.destination,
      },
      receipt: {
        dkimVerdict: { status: "PASS" },
        dmarcVerdict: { status: "PASS" },
        action: { bucketName: "test-bucket", objectKey: `emails/${msg.sesMessageId}` },
      },
    };
    return {
      Records: [{
        messageId: "sqs-0",
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

  it("saveArc is called exactly once and contains all accumulated mutations", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbTestInput, async (input) => {
        // Build classification: use "test" workflow when pong is desired, "conversation" otherwise
        // Both produce non-blocked, non-quarantined paths with an approved sender
        const workflow = input.doPong ? "test" : "conversation";
        const classification: ClassificationOutput = {
          workflow,
          workflowData: workflow === "test"
            ? { workflow: "test", triggeredBy: "user" }
            : { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
          spamScore: 0.01, // Low spam score to avoid quarantine
          summary: "Test signal.",
          labels: [],
          classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
        };

        // Build user rules that add labels and set urgency (non-blocking)
        const userRules = [
          ...input.additionalLabels.map((label, i) => ({
            id: `user-rule-label-${i}`,
            accountId: input.accountId,
            name: `Add label ${label}`,
            condition: "true",
            actions: [{ type: "assign_label" as const, value: label }],
            status: "enabled" as const,
            priorityOrder: 200 + i,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          })),
          ...(input.urgency !== undefined ? [{
            id: "user-rule-urgency",
            accountId: input.accountId,
            name: "Set urgency",
            condition: "true",
            actions: [{ type: "set_urgency" as const, value: input.urgency }],
            status: "enabled" as const,
            priorityOrder: 300,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          }] : []),
          // Add auto_reply rules
          ...Array.from({ length: input.autoReplyCount }, (_, i) => ({
            id: `user-rule-autoreply-${i}`,
            accountId: input.accountId,
            name: `Auto reply ${i}`,
            condition: "true",
            actions: [{ type: "auto_reply" as const, value: `template-${i}` }],
            status: "enabled" as const,
            priorityOrder: 400 + i,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          })),
        ];

        // Track saveArc calls
        let saveArcCallCount = 0;
        let savedArc: Arc | null = null;

        const recipientDomain = input.recipientEmail.split("@")[1] ?? "example.com";

        const store: ProcessorDatabase = {
          getSignalByMessageId: vi.fn().mockReturnValue(okAsync(null)),
          saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
          updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
          getArc: vi.fn().mockReturnValue(okAsync(null)),
          findArcByGroupingKey: vi.fn().mockReturnValue(okAsync(null)),
          saveArc: vi.fn().mockImplementation((arc: Arc) => {
            saveArcCallCount++;
            savedArc = arc;
            return okAsync(undefined);
          }),
          listEnabledRules: vi.fn().mockReturnValue(okAsync([...SYSTEM_RULES, ...userRules])),
          getProcessorAccountContext: vi.fn().mockReturnValue(okAsync({
            retentionDays: 0,
            filtering: null,
            emailConfig: {
              id: "cfg-001", accountId: input.accountId, address: input.recipientEmail,
              filterMode: "allow_all",
              createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
            } satisfies Alias,
            registeredDomains: input.doPong ? [recipientDomain] : [],
            userEmails: input.doPong ? [input.senderEmail] : [],
            billingPlan: "Paid",
          })),
          saveAlias: vi.fn().mockImplementation((a: Alias) => okAsync(a)),
          getSender: vi.fn().mockReturnValue(okAsync({
            accountId: input.accountId, aliasAddress: input.recipientEmail,
            domain: input.senderEmail.split("@")[1] ?? "example.com",
            mode: "allow", addedAt: "2024-01-01T00:00:00Z",
          })),
          saveSender: vi.fn().mockReturnValue(okAsync(undefined)),
          getTemplate: vi.fn().mockImplementation((_accountId: string, id: string) =>
            okAsync({
              id, accountId: input.accountId, name: `Template ${id}`,
              subject: "Re: {{signal.subject}}", body: "Auto-reply body",
              createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
            } satisfies EmailTemplate),
          ),
          updateGlobalReputation: vi.fn().mockReturnValue(okAsync(undefined)),
          getDomainByName: vi.fn().mockReturnValue(okAsync({
            id: recipientDomain, accountId: input.accountId, domain: recipientDomain,
            receivingSetupComplete: true, senderSetupComplete: true,
            createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
          })),
        };

        const mimeParser: MimeParser = {
          parse: vi.fn().mockResolvedValue({
            from: { address: input.senderEmail, name: "Sender" },
            to: [{ address: input.recipientEmail }],
            cc: [],
            subject: "Test email",
            textBody: "Hello world",
            htmlBody: "<p>Hello world</p>",
            attachments: [],
            headers: { "authentication-results": "spf=pass dkim=pass" },
            sentAt: input.timestamp,
          }),
        };

        const classifier: Pick<SignalClassifier, "classify"> = {
          classify: vi.fn().mockResolvedValue(classification),
        };

        const embeddingGenerator: EmbeddingGenerator = {
          generateForActiveClusters: vi.fn().mockResolvedValue([
            { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 },
          ] as EmbeddingResult[]),
          generateForModel: vi.fn().mockResolvedValue(
            { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 } as EmbeddingResult,
          ),
        };

        const auroraWriter: MultiClusterAuroraWriter = {
          upsertEmbedding: vi.fn().mockResolvedValue(undefined),
          findMatch: vi.fn().mockResolvedValue(null),
        };

        const arcMatcher: ArcMatcher = {
          findMatch: vi.fn().mockReturnValue(okAsync(null)),
          upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)),
        };

        // Track pong message IDs
        let pongMessageId: string | null = null;
        const autoReplyMessageIds: string[] = [];

        const testReplier: TestReplier = {
          pong: vi.fn().mockImplementation(() => {
            const msgId = `pong-${Math.random().toString(36).slice(2)}`;
            if (!pongMessageId) {
              pongMessageId = msgId;
            } else {
              autoReplyMessageIds.push(msgId);
            }
            return Promise.resolve({ messageId: msgId });
          }),
        };

        const retentionService: S3RetentionService | undefined = input.hasRetention
          ? {
              applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: `emails/${input.sesMessageId}` }),
            }
          : undefined;

        const mockLogger = createMockLogger();
        const processor = new SignalProcessor({
          store,
          mimeParser,
          classifier,
          embeddingGenerator,
          auroraWriter,
          arcMatcher,
          ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger),
          testReplier,
          logger: mockLogger,
          ...(retentionService ? { retentionService } : {}),
        });

        const event = makeSqsEvent({
          accountId: input.accountId,
          sesMessageId: input.sesMessageId,
          timestamp: input.timestamp,
          destination: [input.recipientEmail],
        });

        await processor.process(event);

        // Property 1: saveArc is called exactly once
        if (saveArcCallCount !== 1) {
          throw new Error(`Expected saveArc to be called exactly once, but was called ${saveArcCallCount} times`);
        }

        if (!savedArc) {
          throw new Error("savedArc is null despite saveArc being called");
        }

        const arc = savedArc as Arc;

        // Verify TTL mutation is present when retention service is enabled
        if (input.hasRetention) {
          if (arc.ttl === undefined) {
            throw new Error("Expected arc.ttl to be set when retention service is enabled");
          }
        }

        // Verify sentMessageIds contains pong message ID when pong was triggered
        if (input.doPong && pongMessageId) {
          if (!arc.sentMessageIds?.includes(pongMessageId)) {
            throw new Error(`Expected arc.sentMessageIds to contain pong messageId "${pongMessageId}", got ${JSON.stringify(arc.sentMessageIds)}`);
          }
        }

        // Verify sentMessageIds contains auto-reply message IDs
        // Auto-reply only fires when domain has senderSetupComplete=true (which we mock as true)
        // and the workflow triggers auto_reply rules
        for (const msgId of autoReplyMessageIds) {
          if (!arc.sentMessageIds?.includes(msgId)) {
            throw new Error(`Expected arc.sentMessageIds to contain auto-reply messageId "${msgId}", got ${JSON.stringify(arc.sentMessageIds)}`);
          }
        }

        // Verify additional labels from rules are present
        for (const label of input.additionalLabels) {
          if (!arc.labels.includes(label)) {
            throw new Error(`Expected arc.labels to contain "${label}", got ${JSON.stringify(arc.labels)}`);
          }
        }

        // Verify urgency is set when a user rule sets it
        // Note: system rules may set urgency first (first-rule-wins), so only check when
        // no system rule would have set urgency for this workflow
        if (input.urgency !== undefined && workflow !== "conversation") {
          // For non-conversation workflows without system urgency rules, user rule should win
          if (arc.urgency !== input.urgency) {
            throw new Error(`Expected arc.urgency to be "${input.urgency}", got "${arc.urgency}"`);
          }
        }

        // Verify status is set (should be "active" for non-blocked, non-quarantined)
        if (arc.status !== "active") {
          throw new Error(`Expected arc.status to be "active", got "${arc.status}"`);
        }
      }),
    );
  });
});
