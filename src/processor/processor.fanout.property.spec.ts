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
import type { Signal, Alias, AliasSender } from "../types/index.js";
import { propertyRunner } from "../testing/property-runner.js";

// ---------------------------------------------------------------------------
// Property 6: Multi-cluster fanout writes vectors to every active target
// **Validates: Requirements 3.3**
// ---------------------------------------------------------------------------

// Use vi.hoisted to create mutable state that the hoisted vi.mock can reference
const mockState = vi.hoisted(() => ({
  clusters: [
    {
      clusterId: "cluster-default",
      clusterArn: "arn:aws:rds:eu-west-1:111:cluster:cluster-default",
      secretArn: "arn:aws:secretsmanager:eu-west-1:111:secret:cluster-default",
      databaseName: "signals",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    },
  ] as Array<{
    clusterId: string;
    clusterArn: string;
    secretArn: string;
    databaseName: string;
    modelId: string;
    dimensions: number;
    active: boolean;
  }>,
}));

vi.mock("../embedding/cluster-registry.js", () => ({
  get CLUSTER_REGISTRY() {
    return Object.freeze(mockState.clusters);
  },
  getActiveClusters: () => mockState.clusters.filter((c) => c.active),
  getClusterById: (id: string) => mockState.clusters.find((c) => c.clusterId === id) ?? null,
  getReadCluster: () => mockState.clusters.find((c) => c.active) ?? mockState.clusters[0],
}));

/**
 * For any signal processed against a registry of N active clusters, the resulting DynamoDB
 * Signal record contains an `embeddings` map with exactly N entries (one per active modelId),
 * and each of the N Aurora clusters receives one upsert with that cluster's vector for
 * (arc_id, account_id, recipient_address).
 */
describe("Property 6: Multi-cluster fanout writes vectors to every active target", () => {
  const TEST_ACCOUNT_ID = "acct-prop6";

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

  function makeStore(): ProcessorDatabase {
    return {
      getSignalByMessageId: vi.fn().mockResolvedValue(null),
      saveSignal: vi.fn().mockResolvedValue(undefined),
      updateSignalRetention: vi.fn().mockResolvedValue(undefined),
      getArc: vi.fn().mockResolvedValue(null),
      findArcByGroupingKey: vi.fn().mockResolvedValue(null),
      saveArc: vi.fn().mockResolvedValue(undefined),
      listEnabledRules: vi.fn().mockResolvedValue(SYSTEM_RULES),
      getProcessorAccountContext: vi.fn().mockResolvedValue(DEFAULT_CTX),
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

  // -------------------------------------------------------------------------
  // Property 6a: DynamoDB embeddings map has exactly N entries for N active clusters
  // -------------------------------------------------------------------------

  it("DynamoDB signal embeddings map has exactly one entry per active cluster", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        // Generate 1-4 active clusters with unique model suffixes
        fc.array(
          fc.tuple(
            fc.stringMatching(/^[a-z]{3,10}$/),
            fc.integer({ min: 256, max: 2048 }),
          ),
          { minLength: 1, maxLength: 4 },
        ).filter((configs) => {
          const modelIds = configs.map((c) => `model-${c[0]}`);
          return new Set(modelIds).size === configs.length;
        }),
        // Arbitrary session message ID
        fc.stringMatching(/^[a-zA-Z0-9]{5,20}$/),
        async (clusterConfigs, sesMessageId) => {
          // Build cluster registry entries dynamically and set on mutable state
          const clusters = clusterConfigs.map((cfg, idx) => ({
            clusterId: `cluster-${cfg[0]}-${idx}`,
            clusterArn: `arn:aws:rds:eu-west-1:111:cluster:cluster-${cfg[0]}-${idx}`,
            secretArn: `arn:aws:secretsmanager:eu-west-1:111:secret:cluster-${cfg[0]}-${idx}`,
            databaseName: "signals",
            modelId: `model-${cfg[0]}`,
            dimensions: cfg[1],
            active: true,
          }));
          mockState.clusters = clusters;

          const store = makeStore();
          const mimeParser = makeMimeParser();
          const classifier = makeClassifier();
          const arcMatcher = makeArcMatcher();

          // Generate deterministic vectors for each cluster
          const embeddingResults: EmbeddingResult[] = clusters.map((cluster) => ({
            modelId: cluster.modelId,
            vector: Array.from({ length: cluster.dimensions }, (_, i) => (i + 1) / cluster.dimensions),
            dimensions: cluster.dimensions,
          }));

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue(embeddingResults),
            generateForModel: vi.fn().mockImplementation(async (_: string, modelId: string) => {
              const result = embeddingResults.find((r) => r.modelId === modelId);
              if (!result) throw new Error(`Model ${modelId} not found`);
              return result;
            }),
          };

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser,
            classifier,
            embeddingGenerator,
            auroraWriter,
            arcMatcher,
            ruleEvaluator: new JsonLogicRuleEvaluator(),
          });

          await processor.process(makeSqsEvent(sesMessageId));

          // Verify saveSignal was called
          const saveSignalCalls = (store.saveSignal as ReturnType<typeof vi.fn>).mock.calls;
          expect(saveSignalCalls.length).toBeGreaterThanOrEqual(1);

          // Find the main signal save (first call)
          const savedSignal = saveSignalCalls[0]![0] as Signal;

          // The embeddings map MUST have exactly one entry per active cluster
          expect(savedSignal.embeddings).toBeDefined();
          expect(Object.keys(savedSignal.embeddings!)).toHaveLength(clusters.length);

          // Each cluster's modelId must be present with its vector
          for (const cluster of clusters) {
            expect(savedSignal.embeddings![cluster.modelId]).toBeDefined();
            expect(savedSignal.embeddings![cluster.modelId]).toHaveLength(cluster.dimensions);
          }
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property 6b: Each Aurora cluster receives exactly one upsert with correct parameters
  // -------------------------------------------------------------------------

  it("Each Aurora cluster receives exactly one upsert with the cluster's vector", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        // Generate 1-4 active clusters with unique model suffixes
        fc.array(
          fc.tuple(
            fc.stringMatching(/^[a-z]{3,10}$/),
            fc.integer({ min: 256, max: 2048 }),
          ),
          { minLength: 1, maxLength: 4 },
        ).filter((configs) => {
          const modelIds = configs.map((c) => `model-${c[0]}`);
          return new Set(modelIds).size === configs.length;
        }),
        // Arbitrary session message ID
        fc.stringMatching(/^[a-zA-Z0-9]{5,20}$/),
        async (clusterConfigs, sesMessageId) => {
          // Build cluster registry entries dynamically
          const clusters = clusterConfigs.map((cfg, idx) => ({
            clusterId: `cluster-${cfg[0]}-${idx}`,
            clusterArn: `arn:aws:rds:eu-west-1:111:cluster:cluster-${cfg[0]}-${idx}`,
            secretArn: `arn:aws:secretsmanager:eu-west-1:111:secret:cluster-${cfg[0]}-${idx}`,
            databaseName: "signals",
            modelId: `model-${cfg[0]}`,
            dimensions: cfg[1],
            active: true,
          }));
          mockState.clusters = clusters;

          const store = makeStore();
          const mimeParser = makeMimeParser();
          const classifier = makeClassifier();
          const arcMatcher = makeArcMatcher();

          // Generate deterministic vectors for each cluster
          const embeddingResults: EmbeddingResult[] = clusters.map((cluster) => ({
            modelId: cluster.modelId,
            vector: Array.from({ length: cluster.dimensions }, (_, i) => (i + 1) / cluster.dimensions),
            dimensions: cluster.dimensions,
          }));

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue(embeddingResults),
            generateForModel: vi.fn().mockImplementation(async (_: string, modelId: string) => {
              const result = embeddingResults.find((r) => r.modelId === modelId);
              if (!result) throw new Error(`Model ${modelId} not found`);
              return result;
            }),
          };

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser,
            classifier,
            embeddingGenerator,
            auroraWriter,
            arcMatcher,
            ruleEvaluator: new JsonLogicRuleEvaluator(),
          });

          await processor.process(makeSqsEvent(sesMessageId));

          // Verify Aurora upsert was called exactly once per active cluster
          const upsertCalls = (auroraWriter.upsertEmbedding as ReturnType<typeof vi.fn>).mock.calls;
          expect(upsertCalls).toHaveLength(clusters.length);

          // Each cluster must have received exactly one upsert with correct params
          for (let i = 0; i < clusters.length; i++) {
            const cluster = clusters[i]!;
            const matchingCall = upsertCalls.find(
              (call: Array<{ clusterId: string }>) => call[0]?.clusterId === cluster.clusterId,
            );
            expect(matchingCall).toBeDefined();

            const opts = matchingCall![0];
            expect(opts.clusterId).toBe(cluster.clusterId);
            expect(opts.accountId).toBe(TEST_ACCOUNT_ID);
            expect(opts.recipientAddress).toBe("user@example.com");
            expect(opts.embedding).toEqual(embeddingResults[i]!.vector);
          }
        },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Property 6c: Embeddings map keys match cluster modelIds exactly
  // -------------------------------------------------------------------------

  it("Embeddings map keys match cluster modelIds exactly", () => {
    return propertyRunner.assert(
      fc.asyncProperty(
        // Generate 1-4 active clusters with unique model suffixes
        fc.array(
          fc.stringMatching(/^[a-z]{3,10}$/),
          { minLength: 1, maxLength: 4 },
        ).filter((suffixes) => new Set(suffixes.map((s) => `model-${s}`)).size === suffixes.length),
        // Arbitrary session message ID
        fc.stringMatching(/^[a-zA-Z0-9]{5,20}$/),
        async (modelSuffixes, sesMessageId) => {
          // Build cluster registry entries dynamically
          const clusters = modelSuffixes.map((suffix, idx) => ({
            clusterId: `cluster-${suffix}-${idx}`,
            clusterArn: `arn:aws:rds:eu-west-1:111:cluster:cluster-${suffix}-${idx}`,
            secretArn: `arn:aws:secretsmanager:eu-west-1:111:secret:cluster-${suffix}-${idx}`,
            databaseName: "signals",
            modelId: `model-${suffix}`,
            dimensions: 1024,
            active: true,
          }));
          mockState.clusters = clusters;

          const store = makeStore();
          const mimeParser = makeMimeParser();
          const classifier = makeClassifier();
          const arcMatcher = makeArcMatcher();

          // Generate deterministic vectors for each cluster
          const embeddingResults: EmbeddingResult[] = clusters.map((cluster) => ({
            modelId: cluster.modelId,
            vector: new Array(cluster.dimensions).fill(0.1),
            dimensions: cluster.dimensions,
          }));

          const embeddingGenerator: EmbeddingGenerator = {
            generateForActiveClusters: vi.fn().mockResolvedValue(embeddingResults),
            generateForModel: vi.fn().mockResolvedValue(embeddingResults[0]!),
          };

          const auroraWriter: MultiClusterAuroraWriter = {
            upsertEmbedding: vi.fn().mockResolvedValue(undefined),
            findMatch: vi.fn().mockResolvedValue(null),
          };

          const processor = new SignalProcessor({
            store,
            mimeParser,
            classifier,
            embeddingGenerator,
            auroraWriter,
            arcMatcher,
            ruleEvaluator: new JsonLogicRuleEvaluator(),
          });

          await processor.process(makeSqsEvent(sesMessageId));

          // Verify saveSignal was called
          const saveSignalCalls = (store.saveSignal as ReturnType<typeof vi.fn>).mock.calls;
          const savedSignal = saveSignalCalls[0]![0] as Signal;

          // The embeddings map keys must match the cluster modelIds exactly
          const embeddingsKeys = Object.keys(savedSignal.embeddings!).sort();
          const expectedKeys = clusters.map((c) => c.modelId).sort();
          expect(embeddingsKeys).toEqual(expectedKeys);
        },
      ),
    );
  });
});
