import { describe, it, expect, vi } from "vitest";
import { ok, err } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ArcMatcher, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeArcDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/multi-cluster-aurora-writer.js";
import { dbError } from "../../src/errors.js";
import { createMockLogger } from "../helpers/mock-logger.js";

vi.mock("../../src/embedding/cluster-registry.js", () => {
  const cluster = Object.freeze({
    registryId: "cluster-a",
    clusterArn: "arn:aws:rds:eu-central-1:111:cluster:cluster-a",
    secretArn: "arn:aws:secretsmanager:eu-central-1:111:secret:cluster-a",
    databaseName: "signals",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([cluster]),
    getActiveClusters: () => [cluster],
    getRegistryById: (id: string) => (id === "cluster-a" ? cluster : null),
    getPrimaryArcMatcherRegistry: () => cluster,
  };
});

vi.mock("../../src/processor/presign.js", () => ({
  generatePresignedGet: vi.fn().mockResolvedValue("https://presigned-get.example.com/test"),
  generatePresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post.example.com", fields: {} }),
}));

describe("ProcessError on database failure", () => {
  function makeStore() {
    return { arcDb: makeArcDbMock(), accountDb: makeAccountDbMock(), processingDb: makeProcessingDbMock() };
  }

  function makeMessage(): InboundSignalMessage {
    return {
      accountId: "acct-test",
      s3Key: "emails/ses-msg-1",
      sesMessageId: "ses-msg-1",
      timestamp: "2024-01-15T10:00:00Z",
      destination: ["u@x.com"],
      dkimVerdict: "PASS",
      dmarcVerdict: "PASS",
    };
  }

  function makeProcessor(store: ReturnType<typeof makeStore>): SignalProcessor {
    const contentSanitizer: ContentSanitizerClient = {
      invoke: vi.fn().mockReturnValue(Promise.resolve(ok({
        success: true as const,
        parsed: {
          from: { address: "s@x.com", name: "S" },
          to: [{ address: "u@x.com" }],
          cc: [],
          subject: "Test",
          textBody: "body",
          htmlBody: "<p>body</p>",
          attachments: [],
          headers: { "authentication-results": "spf=pass dkim=pass" },
          sentAt: "2024-01-15T09:00:00Z",
        },
        urlMapping: {},
      }))),
    };
    const classifier: Pick<SignalClassifier, "classify"> = {
      classify: vi.fn().mockResolvedValue({
        workflow: "conversation",
        workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
        spamScore: 0.05, summary: "Test.", labels: [], classificationModelId: "model-1",
      }),
    };
    const embeddingGenerator: EmbeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(ok({ modelId: "m", vector: [0.1], dimensions: 1024 })),
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
    const mockLogger = createMockLogger();
    return new SignalProcessor({
      ...store, contentSanitizer, userCodeExecutor: { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() }, s3Client: {} as never, emailBucket: "test-bucket", contentBucket: "test-content-bucket", contentCdnBaseUrl: "https://cdn.example.com", classifier, embeddingGenerator, auroraWriter, arcMatcher,
      ruleEvaluator: new JsonLogicRuleEvaluator(mockLogger), logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwarder: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
    });
  }

  it("database failure on dedup check returns err with cause", async () => {
    const store = makeStore();
    (store.arcDb.getSignalByMessageId as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve(err(dbError(new Error("connection timeout")))),
    );

    const processor = makeProcessor(store);
    const message = makeMessage();

    const result = await processor.processRecord(message, 2);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.cause).toBeDefined();
    }
  });
});
