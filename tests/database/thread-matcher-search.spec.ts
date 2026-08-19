import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  RDSDataClient,
  BeginTransactionCommand,
  ExecuteStatementCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { ThreadMatcher } from "../../src/database/thread-matcher.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mock cluster registry — same pattern as multi-cluster-aurora-writer.test.ts
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
// Tests
// ---------------------------------------------------------------------------

const rdsMock = mockClient(RDSDataClient);

describe("ThreadMatcher.searchByVector", () => {
  let matcher: ThreadMatcher;

  beforeEach(() => {
    rdsMock.reset();
    matcher = new ThreadMatcher(createMockLogger());
  });

  it("executes SET LOCAL with the correct accountId for RLS", async () => {
    rdsMock
      .on(BeginTransactionCommand).resolves({ transactionId: "txn-search-1" })
      .on(ExecuteStatementCommand)
        .resolvesOnce({}) // SET LOCAL
        .resolvesOnce({ records: [] }) // SELECT
      .on(CommitTransactionCommand).resolves({});

    await matcher.searchByVector("acct_search_1", [0.1, 0.2, 0.3], 10);

    const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const setLocalInput = execCalls[0]!.args[0].input as { sql?: string; transactionId?: string };
    expect(setLocalInput.sql).toBe("SET LOCAL app.current_account_id = 'acct_search_1'");
    expect(setLocalInput.transactionId).toBe("txn-search-1");
  });

  it("queries thread_embeddings with accountId filter and cosine distance", async () => {
    rdsMock
      .on(BeginTransactionCommand).resolves({ transactionId: "txn-search-2" })
      .on(ExecuteStatementCommand)
        .resolvesOnce({}) // SET LOCAL
        .resolvesOnce({ records: [] }) // SELECT
      .on(CommitTransactionCommand).resolves({});

    await matcher.searchByVector("acct_42", [0.5, 0.6], 5);

    const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const selectInput = execCalls[1]!.args[0].input as { sql?: string; parameters?: unknown[] };

    // Verify the query references thread_embeddings, uses cosine distance, and includes accountId
    expect(selectInput.sql).toContain("thread_embeddings");
    expect(selectInput.sql).toContain("<=>");
    // accountId appears as a parameter binding
    expect(selectInput.sql).toContain("account_id");
  });

  it("orders results by cosine distance ascending", async () => {
    rdsMock
      .on(BeginTransactionCommand).resolves({ transactionId: "txn-search-3" })
      .on(ExecuteStatementCommand)
        .resolvesOnce({}) // SET LOCAL
        .resolvesOnce({ records: [] }) // SELECT
      .on(CommitTransactionCommand).resolves({});

    await matcher.searchByVector("acct_1", [0.1], 10);

    const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const selectInput = execCalls[1]!.args[0].input as { sql?: string };

    // ORDER BY uses cosine distance operator
    expect(selectInput.sql).toContain("<=>");
    // The query should contain "order by" somewhere (case-insensitive check via lowercase)
    expect(selectInput.sql!.toLowerCase()).toContain("order by");
  });

  it("applies the limit parameter", async () => {
    rdsMock
      .on(BeginTransactionCommand).resolves({ transactionId: "txn-search-4" })
      .on(ExecuteStatementCommand)
        .resolvesOnce({}) // SET LOCAL
        .resolvesOnce({ records: [] }) // SELECT
      .on(CommitTransactionCommand).resolves({});

    await matcher.searchByVector("acct_1", [0.1, 0.2], 7);

    const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const selectInput = execCalls[1]!.args[0].input as { sql?: string };

    // Drizzle should include the limit in the query
    expect(selectInput.sql!.toLowerCase()).toContain("limit");
  });

  it("uses SEARCH_THRESHOLD (0.75) in the distance filter", async () => {
    rdsMock
      .on(BeginTransactionCommand).resolves({ transactionId: "txn-search-5" })
      .on(ExecuteStatementCommand)
        .resolvesOnce({}) // SET LOCAL
        .resolvesOnce({ records: [] }) // SELECT
      .on(CommitTransactionCommand).resolves({});

    await matcher.searchByVector("acct_1", [0.1], 10);

    const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const selectInput = execCalls[1]!.args[0].input as { sql?: string; parameters?: Array<{ name: string; value: { doubleValue?: number; stringValue?: string } }> };

    // SEARCH_THRESHOLD = 0.75 — passed as a parameterized value
    // The SQL uses <=> :N < :M pattern, where the threshold is one of the parameters
    expect(selectInput.sql).toContain("<");
    const thresholdParam = selectInput.parameters?.find(
      p => p.value.doubleValue === 0.75 || p.value.stringValue === "0.75",
    );
    expect(thresholdParam).toBeDefined();
  });

  it("returns ok with threadId array on success", async () => {
    rdsMock
      .on(BeginTransactionCommand).resolves({ transactionId: "txn-search-6" })
      .on(ExecuteStatementCommand)
        .resolvesOnce({}) // SET LOCAL
        .resolvesOnce({
          columnMetadata: [{ name: "thread_id" }],
          records: [
            [{ stringValue: "arc_thread_1" }],
            [{ stringValue: "arc_thread_2" }],
            [{ stringValue: "arc_thread_3" }],
          ],
        })
      .on(CommitTransactionCommand).resolves({});

    const result = await matcher.searchByVector("acct_1", [0.1, 0.2, 0.3], 10);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(["arc_thread_1", "arc_thread_2", "arc_thread_3"]);
  });

  it("returns ok with empty array when no matches found", async () => {
    rdsMock
      .on(BeginTransactionCommand).resolves({ transactionId: "txn-search-7" })
      .on(ExecuteStatementCommand)
        .resolvesOnce({}) // SET LOCAL
        .resolvesOnce({ records: [] }) // SELECT — no results
      .on(CommitTransactionCommand).resolves({});

    const result = await matcher.searchByVector("acct_1", [0.1], 10);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it("returns err(DbError) when the transaction throws", async () => {
    rdsMock
      .on(BeginTransactionCommand).rejects(new Error("Connection refused"));

    const result = await matcher.searchByVector("acct_1", [0.1, 0.2], 10);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("db_error");
    expect(error.message).toContain("Connection refused");
  });

  it("escapes single quotes in accountId for SET LOCAL", async () => {
    rdsMock
      .on(BeginTransactionCommand).resolves({ transactionId: "txn-search-8" })
      .on(ExecuteStatementCommand)
        .resolvesOnce({}) // SET LOCAL
        .resolvesOnce({ records: [] }) // SELECT
      .on(CommitTransactionCommand).resolves({});

    await matcher.searchByVector("acct'injection", [0.1], 10);

    const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
    const setLocalInput = execCalls[0]!.args[0].input as { sql?: string };
    expect(setLocalInput.sql).toBe("SET LOCAL app.current_account_id = 'acct''injection'");
  });
});
