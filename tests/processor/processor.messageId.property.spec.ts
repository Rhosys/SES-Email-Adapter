import type { IForwardingService } from "../../src/forwarding/forwarding-service.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "../../src/processor/processor.js";
import type { ThreadMatcherPort, InboundSignalMessage } from "../../src/processor/processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { makeSharedNewDeps, makeRuleEvaluator3 } from "./_shared-new-deps.js";
import { makeThreadDbMock, makeAccountDbMock, makeProcessingDbMock } from "./_helpers.js";
import type { ContentSanitizerClient } from "../../src/processor/content-sanitizer-client.js";
import type { SignalClassifier } from "../../src/classifier/classifier.js";
import type { EmbeddingGenerator } from "../../src/embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../../src/database/thread-matcher.js";
import { dbError } from "../../src/errors.js";
import type { EmailService } from "../../src/email/email-service.js";
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
    getPrimaryThreadMatcherRegistry: () => cluster,
  };
});


const TEST_ACCOUNT_ID = "acct-msgid";

describe("ProcessError on database failure", () => {
  function makeStore() {
    return { threadDb: makeThreadDbMock(), accountDb: makeAccountDbMock(TEST_ACCOUNT_ID), processingDb: makeProcessingDbMock() };
  }

  function makeMessage(): InboundSignalMessage {
    return {
      s3Key: "emails/ses-msg-1",
      compositeMailMessageId: "ses-ses-msg-1",
      idempotencyKey: "test-idempotency-key",
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
        tags: [], summary: "Test.", labels: [],
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
    const threadMatcher: ThreadMatcherPort = {
      findMatch: vi.fn().mockReturnValue(Promise.resolve(ok(null))),
      upsertEmbedding: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    };
    const mockLogger = createMockLogger();
    return new SignalProcessor({ resourceDb: { saveResource: async () => ok(undefined) } as never, ...makeSharedNewDeps(),
      ...store, contentSanitizer, userCodeExecutor: { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() }, emailContentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, contentStore: { getSignedUrl: vi.fn().mockResolvedValue("https://presigned-get"), getObject: vi.fn().mockResolvedValue(new Uint8Array()), putObject: vi.fn().mockResolvedValue(undefined), getPresignedPost: vi.fn().mockResolvedValue({ url: "https://presigned-post", fields: {} }), saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), getRawEmailUrl: vi.fn().mockResolvedValue("https://presigned-get") } as never, classifier, embeddingGenerator, auroraWriter, threadMatcher,
      ruleEvaluator: makeRuleEvaluator3(mockLogger), logger: mockLogger,
      notifier: { notify: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      forwardingService: { forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)) },
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) },
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply-msg-id" })) },
      sqsDispatcher: { sendMessage: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      draftSendDispatcher: { dispatch: () => Promise.resolve(ok(undefined)) } as never,
      calendarForwarderDeps: { emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() },
    });
  }

  it("database failure on dedup check returns err with cause", async () => {
    const store = makeStore();
    (store.threadDb.getSignalByMessageId as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve(err(dbError(new Error("connection timeout")))),
    );

    const processor = makeProcessor(store);
    const message = makeMessage();

    const result = await processor.processInbound(message, 2);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("db_error");
      expect((result.error as { cause: unknown }).cause).toBeDefined();
    }
  });
});
