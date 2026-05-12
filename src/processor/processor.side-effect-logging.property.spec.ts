import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import type { SQSEvent } from "aws-lambda";
import { okAsync, errAsync } from "neverthrow";
import { SignalProcessor, SYSTEM_RULES } from "./processor.js";
import { JsonLogicRuleEvaluator } from "./rule-evaluator.js";
import type { ProcessorDatabase, ArcMatcher, Notifier, Forwarder, ForwardOptions } from "./processor.js";
import type { MimeParser } from "./mime.js";
import type { SignalClassifier, ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "../embedding/embedding-generator.js";
import type { MultiClusterAuroraWriter } from "../database/multi-cluster-aurora-writer.js";
import type { Alias, AliasSender, Rule } from "../types/index.js";
import { dbError } from "../errors.js";
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
// Property 5: Side effect caller logging
// **Validates: Requirements 5.3**
// ---------------------------------------------------------------------------

/**
 * For any side effect (notifier, forwarder) that returns `err`, the immediate
 * caller logs at TRACK or ERROR level. No error result is silently discarded.
 */
describe("Property 5: Side effect caller logging", () => {
  const TEST_ACCOUNT_ID = "acct-side-effect";

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

  const DEFAULT_CTX = {
    retentionDays: 0,
    filtering: null,
    emailConfig: DEFAULT_EMAIL_CONFIG,
    registeredDomains: [],
    userEmails: [],
    billingPlan: "Paid" as const,
  };

  const validClassification: ClassificationOutput = {
    workflow: "conversation",
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.05,
    summary: "A test email.",
    labels: [],
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
  };

  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeStore(): ProcessorDatabase {
    return {
      getSignalByMessageId: vi.fn().mockReturnValue(okAsync(null)),
      saveSignal: vi.fn().mockReturnValue(okAsync(undefined)),
      updateSignalRetention: vi.fn().mockReturnValue(okAsync(undefined)),
      getArc: vi.fn().mockReturnValue(okAsync(null)),
      findArcByGroupingKey: vi.fn().mockReturnValue(okAsync(null)),
      saveArc: vi.fn().mockReturnValue(okAsync(undefined)),
      listEnabledRules: vi.fn().mockReturnValue(okAsync(SYSTEM_RULES)),
      getProcessorAccountContext: vi.fn().mockReturnValue(okAsync(DEFAULT_CTX)),
      saveAlias: vi.fn().mockImplementation((a: Alias) => okAsync(a)),
      getSender: vi.fn().mockReturnValue(okAsync(DEFAULT_SENDER_ENTRY)),
      saveSender: vi.fn().mockReturnValue(okAsync(undefined)),
      getTemplate: vi.fn().mockReturnValue(okAsync(null)),
      updateGlobalReputation: vi.fn().mockReturnValue(okAsync(undefined)),
      getDomainByName: vi.fn().mockReturnValue(okAsync(null)),
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

  function makeEmbeddingGenerator(): EmbeddingGenerator {
    return {
      generateForActiveClusters: vi.fn().mockResolvedValue([
        { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 },
      ] as EmbeddingResult[]),
      generateForModel: vi.fn().mockResolvedValue(
        { modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 } as EmbeddingResult,
      ),
    };
  }

  function makeAuroraWriter(): MultiClusterAuroraWriter {
    return {
      upsertEmbedding: vi.fn().mockResolvedValue(undefined),
      findMatch: vi.fn().mockResolvedValue(null),
    };
  }

  function makeArcMatcher(): ArcMatcher {
    return {
      findMatch: vi.fn().mockReturnValue(okAsync(null)),
      upsertEmbedding: vi.fn().mockReturnValue(okAsync(undefined)),
    };
  }

  function makeSqsEvent(sesMessageId: string): SQSEvent {
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
        action: { bucketName: "test-bucket", objectKey: `emails/${sesMessageId}` },
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

  it("when notifier.notify() returns err, the caller logs at TRACK or ERROR level", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.string({ minLength: 3, maxLength: 20 }),
        async (shouldFail, errorMessage) => {
          vi.clearAllMocks();
          consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

          const notifier: Notifier = {
            notify: shouldFail
              ? vi.fn().mockReturnValue(errAsync(dbError(new Error(errorMessage))))
              : vi.fn().mockReturnValue(okAsync(undefined)),
            notifyBlocked: vi.fn().mockReturnValue(okAsync(undefined)),
          };

          const processor = new SignalProcessor({
            store: makeStore(),
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator: makeEmbeddingGenerator(),
            auroraWriter: makeAuroraWriter(),
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(),
            notifier,
          });

          await processor.process(makeSqsEvent("test-msg-notify"));

          if (shouldFail) {
            // Verify the caller logged at TRACK or ERROR level — not silently discarded
            const allLogs = [
              ...consoleErrorSpy.mock.calls.map((c) => c[0] as string),
              ...consoleLogSpy.mock.calls.map((c) => c[0] as string),
            ];
            const sideEffectLog = allLogs.find((log) => {
              try {
                const parsed = JSON.parse(log);
                return parsed.message === "notification_failed" &&
                  (parsed.level === "track" || parsed.level === "error");
              } catch { return false; }
            });
            expect(sideEffectLog).toBeDefined();
          }
        },
      ),
    );
  });

  it("when forwarder.forward() returns err, the caller logs at TRACK or ERROR level", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.string({ minLength: 3, maxLength: 20 }),
        async (shouldFail, errorMessage) => {
          vi.clearAllMocks();
          consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

          const forwarder: Forwarder = {
            forward: shouldFail
              ? vi.fn().mockReturnValue(errAsync(dbError(new Error(errorMessage))))
              : vi.fn().mockReturnValue(okAsync(undefined)),
          };

          // Add a forward rule so the forwarder is actually invoked
          const store = makeStore();
          const forwardRule: Rule = {
            id: "rule-fwd-prop",
            accountId: TEST_ACCOUNT_ID,
            name: "Forward all",
            condition: JSON.stringify(true),
            actions: [{ type: "forward", value: "fwd@example.com" }],
            status: "enabled",
            priorityOrder: 100,
            createdAt: "",
            updatedAt: "",
          };
          vi.mocked(store.listEnabledRules).mockReturnValue(okAsync([...SYSTEM_RULES, forwardRule]));

          const processor = new SignalProcessor({
            store,
            mimeParser: makeMimeParser(),
            classifier: makeClassifier(),
            embeddingGenerator: makeEmbeddingGenerator(),
            auroraWriter: makeAuroraWriter(),
            arcMatcher: makeArcMatcher(),
            ruleEvaluator: new JsonLogicRuleEvaluator(),
            forwarder,
          });

          await processor.process(makeSqsEvent("test-msg-forward"));

          if (shouldFail) {
            // Verify the caller logged at TRACK or ERROR level — not silently discarded
            const allLogs = [
              ...consoleErrorSpy.mock.calls.map((c) => c[0] as string),
              ...consoleLogSpy.mock.calls.map((c) => c[0] as string),
            ];
            const sideEffectLog = allLogs.find((log) => {
              try {
                const parsed = JSON.parse(log);
                return parsed.message === "forward_failed" &&
                  (parsed.level === "track" || parsed.level === "error");
              } catch { return false; }
            });
            expect(sideEffectLog).toBeDefined();
          }
        },
      ),
    );
  });
});
