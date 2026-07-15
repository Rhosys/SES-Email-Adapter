import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  RDSDataClient,
  BeginTransactionCommand,
  ExecuteStatementCommand,
  CommitTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { ThreadMatcher } from "../../src/database/thread-matcher.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster registry
// ---------------------------------------------------------------------------

vi.mock("../../src/embedding/cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze([
    Object.freeze({
      registryId: "test-cluster-1",
      clusterArn: "arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111111111111:secret:test-1",
      databaseName: "testdb",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    }),
  ]),
  getActiveClusters: () => [
    {
      registryId: "test-cluster-1",
      clusterArn: "arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1",
      secretArn: "arn:aws:secretsmanager:eu-central-1:111111111111:secret:test-1",
      databaseName: "testdb",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    },
  ],
  getRegistryById: (id: string) => {
    if (id === "test-cluster-1") {
      return {
        registryId: "test-cluster-1",
        clusterArn: "arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1",
        secretArn: "arn:aws:secretsmanager:eu-central-1:111111111111:secret:test-1",
        databaseName: "testdb",
        modelId: "amazon.titan-embed-text-v2:0",
        dimensions: 1024,
        active: true,
      };
    }
    return null;
  },
  getPrimaryThreadMatcherRegistry: () => ({
    registryId: "test-cluster-1",
    clusterArn: "arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1",
    secretArn: "arn:aws:secretsmanager:eu-central-1:111111111111:secret:test-1",
    databaseName: "testdb",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  }),
}));

// ---------------------------------------------------------------------------
// Mock DynamoDB — hasEmbedding doesn't use it, but findMatch does
// ---------------------------------------------------------------------------

vi.mock("../../src/database/shared.js", () => ({
  dynamo: { send: vi.fn() },
  SIGNALS_TABLE: "signals-test",
}));

// ---------------------------------------------------------------------------
// Tests — validates Requirements A.3, A.4
// ---------------------------------------------------------------------------

const rdsMock = mockClient(RDSDataClient);

describe("ThreadMatcher — multi-row embedding support", () => {
  let matcher: ThreadMatcher;

  beforeEach(() => {
    rdsMock.reset();
    matcher = new ThreadMatcher(createMockLogger());
  });

  // -------------------------------------------------------------------------
  // hasEmbedding — Requirements A.4, A.5
  // -------------------------------------------------------------------------

  describe("hasEmbedding", () => {
    it("returns ok(true) when at least one row exists for the threadId", async () => {
      rdsMock
        .on(ExecuteStatementCommand)
        .resolves({
          records: [[{ stringValue: "arc_thread_1" }]],
        });

      const result = await matcher.hasEmbedding("arc_thread_1");
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(true);
    }, { timeout: 5_000 });

    it("returns ok(false) when no rows exist for the threadId", async () => {
      rdsMock
        .on(ExecuteStatementCommand)
        .resolves({ records: [] });

      const result = await matcher.hasEmbedding("arc_nonexistent");
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(false);
    }, { timeout: 5_000 });

    it("returns err on Aurora connectivity error", async () => {
      rdsMock
        .on(ExecuteStatementCommand)
        .rejects(new Error("Connection refused"));

      const result = await matcher.hasEmbedding("arc_broken");
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    }, { timeout: 5_000 });

    it("queries thread_embeddings with threadId filter and limit 1", async () => {
      rdsMock
        .on(ExecuteStatementCommand)
        .resolves({ records: [] });

      await matcher.hasEmbedding("arc_check_query");

      const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
      expect(execCalls).toHaveLength(1);

      const input = execCalls[0]!.args[0].input as { sql?: string };
      expect(input.sql).toContain("thread_embeddings");
      expect(input.sql).toContain("thread_id");
      expect(input.sql!.toLowerCase()).toContain("limit");
    }, { timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // findMatch deduplication — Requirement A.3
  //
  // With multi-row embeddings (one row per signal), the same threadId can
  // appear multiple times. findMatch uses ORDER BY cosine distance + LIMIT 1,
  // ensuring only the closest match is returned. searchByVector uses
  // DISTINCT ON for multi-result deduplication.
  // -------------------------------------------------------------------------

  describe("findMatch — threadId deduplication", () => {
    it("returns single closest threadId even when multiple rows exist for same thread", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-dedup-1" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({ records: [[{ stringValue: "arc_dup" }]] }) // closest match
        .on(CommitTransactionCommand).resolves({});

      const result = await matcher.findMatch({
        registryId: "test-cluster-1",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.5, 0.6, 0.7],
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ threadId: "arc_dup" });
    }, { timeout: 5_000 });

    it("findMatch query orders by cosine distance to pick closest embedding", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-dedup-2" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({ records: [] }) // no match
        .on(CommitTransactionCommand).resolves({});

      await matcher.findMatch({
        registryId: "test-cluster-1",
        accountId: "acct_order",
        recipientAddress: "order@example.com",
        embedding: [0.1, 0.2],
      });

      const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
      const selectInput = execCalls[1]!.args[0].input as { sql?: string };

      // Query orders by cosine distance (<=>) to ensure closest embedding wins
      expect(selectInput.sql).toContain("<=>");
      expect(selectInput.sql!.toLowerCase()).toContain("order");
      // LIMIT 1 ensures only one thread is returned (natural deduplication)
      expect(selectInput.sql!.toLowerCase()).toContain("limit");
    }, { timeout: 5_000 });

    it("searchByVector uses DISTINCT ON to deduplicate multiple rows per thread", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-dedup-3" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({
            columnMetadata: [{ name: "thread_id" }],
            records: [
              [{ stringValue: "arc_a" }],
              [{ stringValue: "arc_b" }],
            ],
          })
        .on(CommitTransactionCommand).resolves({});

      const result = await matcher.searchByVector("acct_1", [0.5, 0.6], 10);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(["arc_a", "arc_b"]);

      // Verify the query uses DISTINCT ON for deduplication
      const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
      const selectInput = execCalls[1]!.args[0].input as { sql?: string };
      expect(selectInput.sql!.toLowerCase()).toContain("distinct on");
      expect(selectInput.sql!.toLowerCase()).toContain("thread_id");
    }, { timeout: 5_000 });
  });
});
