import { describe, it, expect, vi } from "vitest";
import type { SQSRecord } from "aws-lambda";
import { okAsync, errAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier } from "../classifier/classifier.js";
import type { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import { dbError } from "../errors.js";
import { createMockLogger } from "../testing/mock-logger.js";

vi.mock("../embedding/cluster-registry.js", () => {
  const cluster = Object.freeze({
    clusterId: "cluster-a",
    clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-a",
    secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-a",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([cluster]),
    getActiveClusters: () => [cluster],
    getClusterById: (id: string) => (id === "cluster-a" ? cluster : null),
    getReadCluster: () => cluster,
  };
});

describe("ProcessError always carries the SQS messageId", () => {
  function makeStore(): ProcessorDatabase {
    return {
      getSignalByMessageId: vi.fn().mockReturnValue(okAsync(null)),
      saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
      updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
      getArc: vi.fn().mockReturnValue(okAsync(null)),
      findArcByGroupingKey: vi.fn().mockReturnValue(okAsync(null)),
      saveArc: vi.fn().mockReturnValue(okAsync(undefined)),
      listEnabledRules: vi.fn().mockReturnValue(okAsync(SYSTEM_RULES)),
      getProcessorAccountContext: vi.fn().mockReturnValue(okAsync({
        retentionDays: 0,
        filtering: null,
        emailConfig: { id: "cfg", accountId: "acct", address: "u@x.com", filterMode: "quarantine_visible", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
        registeredDomains: [],
        userEmails: [],
        billingPlan: "Paid" as const,
      })),
      saveAlias: vi.fn().mockImplementation((a) => okAsync(a)),
      getSender: vi.fn().mockReturnValue(okAsync(null)),
      saveSender: vi.fn().mockReturnValue(okAsync(undefined)),
      getTemplate: vi.fn().mockReturnValue(okAsync(null)),
      updateGlobalReputation: vi.fn().mockReturnValue(okAsync(undefined)),
      getDomainByName: vi.fn().mockReturnValue(okAsync(null)),
    };
  }

  function makeSqsRecord(messageId: string, body: string): SQSRecord {
    return {
      messageId,
      receiptHandle: "handle",
      body,
      attributes: { ApproximateReceiveCount: "1", SentTimestamp: "1234567890", SenderId: "sender", ApproximateFirstReceiveTimestamp: "1234567890" },
      messageAttributes: {},
      md5OfBody: "",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:eu-west-1:123:queue",
      awsRegion: "eu-west-1",
    };
  }

  function makeProcessor(store: ProcessorDatabase): SignalProcessor {
    const mimeParser: MimeParser = {
      parse: vi.fn().mockResolvedValue({
        from: { address: "s@x.com", name: "S" },
        to: [{ address: "u@x.com" }],
        cc: [],
        subject: "Test",
        textBody: "body",
        htmlBody: "<p>body</p>",
        attachments: [],
        headers: {},
        sentAt: "2024-01-15T09:00:00Z",
      }),
    };
    const classifier: Pick<SignalClassifier, "classify"> = {
      classify: vi.fn().mockResolvedValue({
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.05, summary: "Test.", labels: [], classificationModelId: "model-1",
      }),
    };
    const embeddingGenerator: EmbeddingGenerator = {
      generateForActiveClusters: vi.fn().mockResolvedValue([]),
      generateForModel: vi.fn().mockResolvedValue({ modelId: "m", vector: [0.1], dimensions: 1024 }),
    };
    const auroraWriter: MultiClusterAuroraWriter = {
      upsertEmbedding: vi.fn().mockResolvedValue(undefined),
      findMatch: vi.fn().mockResolvedValue(null),
    };
    const arcMatcher: ArcMatcher = {
      findMatch: vi.fn().mockReturnValue(okAsync(null)),
      upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)),
    };
    const mockLogger = createMockLogger();
    return new SignalProcessor({
      store, mimeParser, classifier, embeddingGenerator, auroraWriter, arcMatcher,
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger), logger: mockLogger,
    });
  }

  const invalidBodies = [
    { label: "empty string", body: "" },
    { label: "not JSON", body: "hello world" },
    { label: "null JSON", body: "null" },
    { label: "empty object (missing Message)", body: "{}" },
    { label: "Message is not valid JSON", body: '{"Message": "not-json"}' },
  ];

  it.each(invalidBodies)("$label causes err with matching messageId", async ({ body }) => {
    const store = makeStore();
    const processor = makeProcessor(store);
    const record = makeSqsRecord("sqs-msg-abc", body);

    const result = await processor.processRecord(record);

    if (result.isErr()) {
      expect(result.error.kind).toBe("process_error");
      expect(result.error.messageId).toBe("sqs-msg-abc");
    }
  });

  it("database failure on dedup check causes err with matching messageId", async () => {
    const store = makeStore();
    (store.getSignalByMessageId as ReturnType<typeof vi.fn>).mockReturnValue(
      errAsync(dbError(new Error("connection timeout"))),
    );

    const processor = makeProcessor(store);

    const notification = {
      accountId: "acct-test",
      mail: { messageId: "ses-msg-1", timestamp: "2024-01-15T10:00:00Z", destination: ["u@x.com"] },
      receipt: { recipients: ["u@x.com"], dkimVerdict: { status: "PASS" }, dmarcVerdict: { status: "PASS" }, action: { bucketName: "b", objectKey: "k" } },
    };
    const record = makeSqsRecord("sqs-msg-xyz", JSON.stringify({ Message: JSON.stringify(notification) }));
    record.attributes.ApproximateReceiveCount = "2";

    const result = await processor.processRecord(record);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("process_error");
      expect(result.error.messageId).toBe("sqs-msg-xyz");
    }
  });
});
