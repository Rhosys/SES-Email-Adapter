import { describe, it, expect, beforeEach, vi } from "vitest";
import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import {
  RDSDataClient,
  BeginTransactionCommand,
  ExecuteStatementCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { MultiClusterAuroraWriterImpl } from "./multi-cluster-aurora-writer.js";
import { propertyRunner } from "../testing/property-runner.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry to avoid coupling to the real registry values
// ---------------------------------------------------------------------------

vi.mock("../embedding/cluster-registry.js", () => ({
  CLUSTER_REGISTRY: Object.freeze([
    Object.freeze({
      clusterId: "test-cluster-1",
      clusterArn: "arn:aws:rds:eu-west-1:111111111111:cluster:test-cluster-1",
      secretArn: "arn:aws:secretsmanager:eu-west-1:111111111111:secret:test-1",
      databaseName: "testdb",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    }),
  ]),
  getActiveClusters: () => [
    {
      clusterId: "test-cluster-1",
      clusterArn: "arn:aws:rds:eu-west-1:111111111111:cluster:test-cluster-1",
      secretArn: "arn:aws:secretsmanager:eu-west-1:111111111111:secret:test-1",
      databaseName: "testdb",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      active: true,
    },
  ],
  getClusterById: (id: string) => {
    if (id === "test-cluster-1") {
      return {
        clusterId: "test-cluster-1",
        clusterArn: "arn:aws:rds:eu-west-1:111111111111:cluster:test-cluster-1",
        secretArn: "arn:aws:secretsmanager:eu-west-1:111111111111:secret:test-1",
        databaseName: "testdb",
        modelId: "amazon.titan-embed-text-v2:0",
        dimensions: 1024,
        active: true,
      };
    }
    return null;
  },
  getReadCluster: () => ({
    clusterId: "test-cluster-1",
    clusterArn: "arn:aws:rds:eu-west-1:111111111111:cluster:test-cluster-1",
    secretArn: "arn:aws:secretsmanager:eu-west-1:111111111111:secret:test-1",
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

describe("MultiClusterAuroraWriterImpl", () => {
  let writer: MultiClusterAuroraWriterImpl;

  beforeEach(() => {
    rdsMock.reset();
    writer = new MultiClusterAuroraWriterImpl();
  });

  describe("upsertEmbedding", () => {
    it.skip("runs BEGIN → SET LOCAL → INSERT ON CONFLICT → COMMIT in sequence", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-1" })
        .on(ExecuteStatementCommand).resolves({ records: [] })
        .on(CommitTransactionCommand).resolves({});

      await writer.upsertEmbedding({
        clusterId: "test-cluster-1",
        arcId: "arc_123",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.1, 0.2, 0.3],
      });

      const calls = rdsMock.calls();
      expect(calls).toHaveLength(4); // BEGIN, SET LOCAL, INSERT, COMMIT

      // BEGIN
      expect(calls[0]!.args[0].input).toMatchObject({
        resourceArn: "arn:aws:rds:eu-west-1:111111111111:cluster:test-cluster-1",
        secretArn: "arn:aws:secretsmanager:eu-west-1:111111111111:secret:test-1",
        database: "testdb",
      });

      // SET LOCAL
      const setLocalInput = calls[1]!.args[0].input as { sql?: string; transactionId?: string; parameters?: unknown[] };
      expect(setLocalInput.sql).toBe("SET LOCAL app.current_account_id = :accountId");
      expect(setLocalInput.transactionId).toBe("txn-1");
      expect(setLocalInput.parameters).toEqual([
        { name: "accountId", value: { stringValue: "acct_1" } },
      ]);

      // INSERT ON CONFLICT
      const upsertInput = calls[2]!.args[0].input as { sql?: string; transactionId?: string; parameters?: unknown[] };
      expect(upsertInput.sql).toContain("INSERT INTO arc_embeddings");
      expect(upsertInput.sql).toContain("ON CONFLICT (arc_id, account_id, recipient_address)");
      expect(upsertInput.transactionId).toBe("txn-1");
      expect(upsertInput.parameters).toEqual([
        { name: "arcId", value: { stringValue: "arc_123" } },
        { name: "accountId", value: { stringValue: "acct_1" } },
        { name: "recipient", value: { stringValue: "user@example.com" } },
        { name: "embedding", value: { stringValue: "[0.1,0.2,0.3]" } },
      ]);

      // COMMIT
      expect(calls[3]!.args[0].input).toMatchObject({
        resourceArn: "arn:aws:rds:eu-west-1:111111111111:cluster:test-cluster-1",
        secretArn: "arn:aws:secretsmanager:eu-west-1:111111111111:secret:test-1",
        transactionId: "txn-1",
      });
    });

    it.skip("throws when clusterId is not in the registry", async () => {
      await expect(
        writer.upsertEmbedding({
          clusterId: "nonexistent-cluster",
          arcId: "arc_1",
          accountId: "acct_1",
          recipientAddress: "a@b.com",
          embedding: [1],
        }),
      ).rejects.toThrow('Cluster "nonexistent-cluster" not found in CLUSTER_REGISTRY');
    });

    it.skip("rolls back on SQL error", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-2" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL succeeds
          .rejectsOnce(new Error("SQL syntax error")) // INSERT fails
        .on(RollbackTransactionCommand).resolves({});

      await expect(
        writer.upsertEmbedding({
          clusterId: "test-cluster-1",
          arcId: "arc_1",
          accountId: "acct_1",
          recipientAddress: "a@b.com",
          embedding: [1],
        }),
      ).rejects.toThrow("SQL syntax error");

      // Verify rollback was called
      const rollbackCalls = rdsMock.commandCalls(RollbackTransactionCommand);
      expect(rollbackCalls).toHaveLength(1);
      expect(rollbackCalls[0]!.args[0].input).toMatchObject({
        transactionId: "txn-2",
      });
    });

    it.skip("retries on transient errors with exponential backoff", async () => {
      vi.useFakeTimers();

      const transientError = Object.assign(new Error("Service unavailable"), {
        name: "InternalServerErrorException",
        $metadata: { httpStatusCode: 500 },
      });

      let callCount = 0;
      rdsMock
        .on(BeginTransactionCommand).callsFake(() => {
          callCount++;
          if (callCount <= 2) throw transientError;
          return { transactionId: "txn-3" };
        })
        .on(ExecuteStatementCommand).resolves({})
        .on(CommitTransactionCommand).resolves({});

      const promise = writer.upsertEmbedding({
        clusterId: "test-cluster-1",
        arcId: "arc_1",
        accountId: "acct_1",
        recipientAddress: "a@b.com",
        embedding: [1, 2],
      });

      // Advance past both retry delays (1s + 2s)
      await vi.advanceTimersByTimeAsync(3000);

      await promise;
      expect(callCount).toBe(3);

      vi.useRealTimers();
    });

    it.skip("throws after 3 failed attempts on transient errors", async () => {
      const transientError = Object.assign(new Error("Service unavailable"), {
        name: "InternalServerErrorException",
        $metadata: { httpStatusCode: 500 },
      });

      rdsMock.on(BeginTransactionCommand).rejects(transientError);

      await expect(
        writer.upsertEmbedding({
          clusterId: "test-cluster-1",
          arcId: "arc_1",
          accountId: "acct_1",
          recipientAddress: "a@b.com",
          embedding: [1],
        }),
      ).rejects.toThrow("Service unavailable");

      // 3 attempts total (initial + 2 retries)
      const beginCalls = rdsMock.commandCalls(BeginTransactionCommand);
      expect(beginCalls).toHaveLength(3);
    });

    it.skip("does not retry non-transient errors", async () => {
      const nonTransientError = new Error("BadRequestException: invalid SQL");

      rdsMock.on(BeginTransactionCommand).rejects(nonTransientError);

      await expect(
        writer.upsertEmbedding({
          clusterId: "test-cluster-1",
          arcId: "arc_1",
          accountId: "acct_1",
          recipientAddress: "a@b.com",
          embedding: [1],
        }),
      ).rejects.toThrow("BadRequestException: invalid SQL");

      // Only 1 call — no retries
      const beginCalls = rdsMock.commandCalls(BeginTransactionCommand);
      expect(beginCalls).toHaveLength(1);
    });
  });

  describe("findMatch", () => {
    it.skip("returns arcId when a match is found within threshold", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-find-1" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({ records: [[{ stringValue: "arc_match_1" }]] }) // SELECT
        .on(CommitTransactionCommand).resolves({});

      const result = await writer.findMatch({
        clusterId: "test-cluster-1",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.5, 0.6, 0.7],
      });

      expect(result).toEqual({ arcId: "arc_match_1" });

      // Verify the SELECT query
      const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
      const selectInput = execCalls[1]!.args[0].input as { sql?: string; parameters?: unknown[] };
      expect(selectInput.sql).toContain("SELECT arc_id FROM arc_embeddings");
      expect(selectInput.sql).toContain("embedding <=> :embedding::vector < :threshold");
      expect(selectInput.sql).toContain("ORDER BY embedding <=> :embedding::vector");
      expect(selectInput.sql).toContain("LIMIT 1");
    });

    it.skip("returns null when no match is found", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-find-2" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({ records: [] }) // SELECT — no results
        .on(CommitTransactionCommand).resolves({});

      const result = await writer.findMatch({
        clusterId: "test-cluster-1",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.1, 0.2],
      });

      expect(result).toBeNull();
    });

    it.skip("returns null when records is undefined", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-find-3" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({}) // SELECT — no records field
        .on(CommitTransactionCommand).resolves({});

      const result = await writer.findMatch({
        clusterId: "test-cluster-1",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.1],
      });

      expect(result).toBeNull();
    });

    it.skip("retries on transient errors", async () => {
      vi.useFakeTimers();

      const transientError = Object.assign(new Error("throttled"), {
        name: "ThrottlingException",
      });

      let beginCallCount = 0;
      rdsMock
        .on(BeginTransactionCommand).callsFake(() => {
          beginCallCount++;
          if (beginCallCount === 1) throw transientError;
          return { transactionId: "txn-retry" };
        })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({ records: [[{ stringValue: "arc_retried" }]] })
        .on(CommitTransactionCommand).resolves({});

      const promise = writer.findMatch({
        clusterId: "test-cluster-1",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.1],
      });

      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result).toEqual({ arcId: "arc_retried" });
      expect(beginCallCount).toBe(2);

      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // Property-based tests
  // ---------------------------------------------------------------------------

  describe("property tests", () => {
    // Property 16: Aurora retries with exponential backoff up to 3 attempts
    // **Validates: Requirements 6.4**
    it.skip(
      "retries transient errors up to 3 attempts and propagates the error with context for logging",
      () => {
        // Spy on global setTimeout to capture delay values and execute immediately
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
          fn();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout);

        const result = propertyRunner.assert(
          fc.asyncProperty(
            fc.string({ minLength: 1, maxLength: 50 }), // arcId
            fc.string({ minLength: 1, maxLength: 50 }), // accountId
            fc.string({ minLength: 1, maxLength: 50 }), // recipientAddress
            fc.array(fc.float({ noNaN: true, noDefaultInfinity: true }), { minLength: 3, maxLength: 10 }), // embedding
            fc.constantFrom(
              "InternalServerErrorException",
              "ThrottlingException",
              "ServiceUnavailableError",
              "StatementTimeoutException",
            ), // transient error type
            async (arcId, accountId, recipientAddress, embedding, errorName) => {
              rdsMock.reset();
              setTimeoutSpy.mockClear();

              const transientError = Object.assign(new Error(`Transient: ${errorName}`), {
                name: errorName,
              });

              // All BeginTransaction calls fail with transient error
              rdsMock.on(BeginTransactionCommand).rejects(transientError);

              let caughtError: Error | undefined;
              try {
                await writer.upsertEmbedding({
                  clusterId: "test-cluster-1",
                  arcId,
                  accountId,
                  recipientAddress,
                  embedding,
                });
              } catch (err) {
                caughtError = err as Error;
              }

              // After 3 failed attempts, the error should be thrown
              expect(caughtError).toBeDefined();
              expect(caughtError!.message).toContain(errorName);

              // Verify exactly 3 attempts were made (initial + 2 retries)
              const beginCalls = rdsMock.commandCalls(BeginTransactionCommand);
              expect(beginCalls).toHaveLength(3);

              // Verify exponential backoff delays: 1s after attempt 0, 2s after attempt 1
              // (attempt 2 is the last attempt so no delay after it — it throws immediately)
              const delayCalls = setTimeoutSpy.mock.calls;
              expect(delayCalls).toHaveLength(2); // 2 delays between 3 attempts
              expect(delayCalls[0]![1]).toBe(1000); // 1s after first failure
              expect(delayCalls[1]![1]).toBe(2000); // 2s after second failure

              return true;
            },
          ),
        );

        return result.finally(() => {
          setTimeoutSpy.mockRestore();
        });
      },
      { timeout: 30000 },
    );

    // Property 16 (recovery after transient failures): Verify successful retry after N failures
    // **Validates: Requirements 6.4**
    it.skip(
      "succeeds after transient failures when a retry attempt succeeds within the 3-attempt limit",
      () => {
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
          fn();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout);

        const result = propertyRunner.assert(
          fc.asyncProperty(
            fc.string({ minLength: 1, maxLength: 20 }), // arcId
            fc.string({ minLength: 1, maxLength: 20 }), // accountId
            fc.integer({ min: 1, max: 2 }), // failCount: how many transient failures before success (1 or 2)
            async (arcId, accountId, failCount) => {
              rdsMock.reset();
              setTimeoutSpy.mockClear();

              const transientError = Object.assign(new Error("Service unavailable"), {
                name: "InternalServerErrorException",
                $metadata: { httpStatusCode: 500 },
              });

              let callCount = 0;
              rdsMock
                .on(BeginTransactionCommand).callsFake(() => {
                  callCount++;
                  if (callCount <= failCount) throw transientError;
                  return { transactionId: `txn-${callCount}` };
                })
                .on(ExecuteStatementCommand).resolves({})
                .on(CommitTransactionCommand).resolves({});

              // Should succeed without throwing
              await writer.upsertEmbedding({
                clusterId: "test-cluster-1",
                arcId,
                accountId,
                recipientAddress: "test@example.com",
                embedding: [0.1, 0.2, 0.3],
              });

              // Verify the correct number of attempts: failCount failures + 1 success
              expect(callCount).toBe(failCount + 1);

              // Verify the backoff delays match the exponential schedule
              const expectedDelays = [1000, 2000, 4000];
              const delayCalls = setTimeoutSpy.mock.calls;
              expect(delayCalls).toHaveLength(failCount);
              for (let i = 0; i < failCount; i++) {
                expect(delayCalls[i]![1]).toBe(expectedDelays[i]);
              }

              return true;
            },
          ),
        );

        return result.finally(() => {
          setTimeoutSpy.mockRestore();
        });
      },
      { timeout: 30000 },
    );

    // Property 16 (non-transient errors): Non-transient errors are NOT retried
    // **Validates: Requirements 6.4**
    it.skip(
      "non-transient errors are not retried — only transient errors trigger the backoff schedule",
      () => {
        return propertyRunner.assert(
          fc.asyncProperty(
            fc.string({ minLength: 1, maxLength: 20 }), // arcId
            fc.string({ minLength: 1, maxLength: 20 }), // accountId
            fc.constantFrom(
              "BadRequestException",
              "ValidationException",
              "AccessDeniedException",
              "NotFoundException",
            ), // non-transient error type
            async (arcId, accountId, errorName) => {
              rdsMock.reset();

              const nonTransientError = Object.assign(new Error(`Non-transient: ${errorName}`), {
                name: errorName,
              });

              rdsMock.on(BeginTransactionCommand).rejects(nonTransientError);

              let caughtError: Error | undefined;
              try {
                await writer.upsertEmbedding({
                  clusterId: "test-cluster-1",
                  arcId,
                  accountId,
                  recipientAddress: "test@example.com",
                  embedding: [0.1, 0.2, 0.3],
                });
              } catch (err) {
                caughtError = err as Error;
              }

              expect(caughtError).toBeDefined();
              expect(caughtError!.message).toContain(errorName);

              // Only 1 attempt — no retries for non-transient errors
              const beginCalls = rdsMock.commandCalls(BeginTransactionCommand);
              expect(beginCalls).toHaveLength(1);

              return true;
            },
          ),
        );
      },
      { timeout: 30000 },
    );

    // Property 9 (writer-scope subset): All embedding upserts are idempotent
    // **Validates: Requirements 3.4, 6.1, 6.3**
    it.skip(
      "repeated upserts for the same (arc_id, account_id, recipient_address) tuple produce the same final state",
      () => {
        return propertyRunner.assert(
          fc.asyncProperty(
            fc.string({ minLength: 1 }), // arcId
            fc.string({ minLength: 1 }), // accountId
            fc.string({ minLength: 1 }), // recipientAddress
            fc.array(fc.float({ noNaN: true, noDefaultInfinity: true }), { minLength: 3, maxLength: 128 }), // embedding vector
            fc.integer({ min: 2, max: 5 }), // number of repeated writes
            async (arcId, accountId, recipientAddress, embedding, repeatCount) => {
              // Reset mock for each property run
              rdsMock.reset();

              let txnCounter = 0;
              rdsMock
                .on(BeginTransactionCommand).callsFake(() => ({ transactionId: `txn-${++txnCounter}` }))
                .on(ExecuteStatementCommand).resolves({})
                .on(CommitTransactionCommand).resolves({});

              // Perform the upsert N times with the same inputs
              for (let i = 0; i < repeatCount; i++) {
                await writer.upsertEmbedding({
                  clusterId: "test-cluster-1",
                  arcId,
                  accountId,
                  recipientAddress,
                  embedding,
                });
              }

              // Each upsert produces 2 ExecuteStatementCommand calls: SET LOCAL + INSERT
              const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
              expect(execCalls).toHaveLength(repeatCount * 2);

              // Extract only the INSERT statements (every second ExecuteStatementCommand)
              const upsertCalls = execCalls.filter((_call, idx) => idx % 2 === 1);
              expect(upsertCalls).toHaveLength(repeatCount);

              // All INSERT statements must have identical SQL and parameters
              const firstUpsert = upsertCalls[0]!.args[0].input as { sql?: string; parameters?: unknown[] };

              for (let i = 1; i < upsertCalls.length; i++) {
                const nthUpsert = upsertCalls[i]!.args[0].input as { sql?: string; parameters?: unknown[] };
                expect(nthUpsert.sql).toBe(firstUpsert.sql);
                expect(nthUpsert.parameters).toEqual(firstUpsert.parameters);
              }

              // Verify the SQL uses ON CONFLICT with the correct composite key
              expect(firstUpsert.sql).toContain("INSERT INTO arc_embeddings");
              expect(firstUpsert.sql).toContain("ON CONFLICT (arc_id, account_id, recipient_address) DO UPDATE");

              // Verify parameters match the input exactly — proving determinism
              expect(firstUpsert.parameters).toEqual([
                { name: "arcId", value: { stringValue: arcId } },
                { name: "accountId", value: { stringValue: accountId } },
                { name: "recipient", value: { stringValue: recipientAddress } },
                { name: "embedding", value: { stringValue: `[${embedding.join(",")}]` } },
              ]);

              // Verify each upsert was committed (not rolled back)
              const commitCalls = rdsMock.commandCalls(CommitTransactionCommand);
              expect(commitCalls).toHaveLength(repeatCount);

              return true;
            },
          ),
        );
      },
      { timeout: 30000 },
    );

    // Property 15: Aurora upserts run inside an RLS-scoped transaction
    // Validates: Requirements 6.2
    it.skip(
      "upserts execute BeginTransaction → SET LOCAL → INSERT ON CONFLICT → CommitTransaction on the same transactionId",
      () => {
        return propertyRunner.assert(
          fc.asyncProperty(
            fc.string({ minLength: 1 }), // arcId
            fc.string({ minLength: 1 }), // accountId
            fc.string({ minLength: 1 }), // recipientAddress
            fc.array(fc.float({ noNaN: true }), { minLength: 1, maxLength: 128 }), // embedding vector
            async (arcId, accountId, recipientAddress, embedding) => {
              rdsMock.reset();

              const txnId = `txn-rls-${Math.random().toString(36).slice(2)}`;

              rdsMock
                .on(BeginTransactionCommand).resolves({ transactionId: txnId })
                .on(ExecuteStatementCommand).resolves({})
                .on(CommitTransactionCommand).resolves({});

              await writer.upsertEmbedding({
                clusterId: "test-cluster-1",
                arcId,
                accountId,
                recipientAddress,
                embedding,
              });

              const calls = rdsMock.calls();

              // Exactly 4 calls: BEGIN, SET LOCAL, INSERT, COMMIT
              expect(calls).toHaveLength(4);

              // Call 0: BeginTransaction
              const beginInput = calls[0]!.args[0].input as {
                resourceArn?: string;
                secretArn?: string;
                database?: string;
              };
              expect(calls[0]!.args[0]).toBeInstanceOf(BeginTransactionCommand);
              expect(beginInput.resourceArn).toBe("arn:aws:rds:eu-west-1:111111111111:cluster:test-cluster-1");
              expect(beginInput.secretArn).toBe("arn:aws:secretsmanager:eu-west-1:111111111111:secret:test-1");
              expect(beginInput.database).toBe("testdb");

              // Call 1: ExecuteStatement — SET LOCAL with the same transactionId
              const setLocalInput = calls[1]!.args[0].input as {
                sql?: string;
                transactionId?: string;
                parameters?: Array<{ name: string; value: { stringValue?: string } }>;
              };
              expect(calls[1]!.args[0]).toBeInstanceOf(ExecuteStatementCommand);
              expect(setLocalInput.transactionId).toBe(txnId);
              expect(setLocalInput.sql).toBe("SET LOCAL app.current_account_id = :accountId");
              expect(setLocalInput.parameters).toEqual([
                { name: "accountId", value: { stringValue: accountId } },
              ]);

              // Call 2: ExecuteStatement — INSERT ON CONFLICT with the same transactionId
              const upsertInput = calls[2]!.args[0].input as {
                sql?: string;
                transactionId?: string;
                parameters?: Array<{ name: string; value: { stringValue?: string } }>;
              };
              expect(calls[2]!.args[0]).toBeInstanceOf(ExecuteStatementCommand);
              expect(upsertInput.transactionId).toBe(txnId);
              expect(upsertInput.sql).toContain("INSERT INTO arc_embeddings");
              expect(upsertInput.sql).toContain("ON CONFLICT");

              // Call 3: CommitTransaction with the same transactionId
              const commitInput = calls[3]!.args[0].input as {
                transactionId?: string;
              };
              expect(calls[3]!.args[0]).toBeInstanceOf(CommitTransactionCommand);
              expect(commitInput.transactionId).toBe(txnId);

              return true;
            },
          ),
        );
      },
      { timeout: 10000 },
    );
  });
});
