import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  RDSDataClient,
  BeginTransactionCommand,
  ExecuteStatementCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { MultiClusterAuroraWriterImpl } from "./multi-cluster-aurora-writer.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry to avoid coupling to the real registry values
// ---------------------------------------------------------------------------

vi.mock("../embedding/cluster-registry.js", () => ({
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
  getPrimaryArcMatcherRegistry: () => ({
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

describe("MultiClusterAuroraWriterImpl", () => {
  let writer: MultiClusterAuroraWriterImpl;

  beforeEach(() => {
    rdsMock.reset();
    writer = new MultiClusterAuroraWriterImpl();
  });

  describe("upsertEmbedding", () => {
    it("runs BEGIN → SET LOCAL → INSERT ON CONFLICT → COMMIT in sequence", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-1" })
        .on(ExecuteStatementCommand).resolves({ records: [] })
        .on(CommitTransactionCommand).resolves({});

      const result = await writer.upsertEmbedding({
        registryId: "test-cluster-1",
        arcId: "arc_123",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.1, 0.2, 0.3],
      });

      expect(result.isOk()).toBe(true);

      const calls = rdsMock.calls();
      expect(calls).toHaveLength(4); // BEGIN, SET LOCAL, INSERT, COMMIT

      // BEGIN
      expect(calls[0]!.args[0].input).toMatchObject({
        resourceArn: "arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1",
        secretArn: "arn:aws:secretsmanager:eu-central-1:111111111111:secret:test-1",
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
        resourceArn: "arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1",
        secretArn: "arn:aws:secretsmanager:eu-central-1:111111111111:secret:test-1",
        transactionId: "txn-1",
      });
    });

    it("returns err when registryId is not in the registry", async () => {
      const result = await writer.upsertEmbedding({
        registryId: "nonexistent-cluster",
        arcId: "arc_1",
        accountId: "acct_1",
        recipientAddress: "a@b.com",
        embedding: [1],
      });

      expect(result.isErr()).toBe(true);
    });

    it("rolls back on SQL error", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-2" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL succeeds
          .rejectsOnce(new Error("SQL syntax error")) // INSERT fails
        .on(RollbackTransactionCommand).resolves({});

      const result = await writer.upsertEmbedding({
        registryId: "test-cluster-1",
        arcId: "arc_1",
        accountId: "acct_1",
        recipientAddress: "a@b.com",
        embedding: [1],
      });

      expect(result.isErr()).toBe(true);

      // Verify rollback was called
      const rollbackCalls = rdsMock.commandCalls(RollbackTransactionCommand);
      expect(rollbackCalls).toHaveLength(1);
      expect(rollbackCalls[0]!.args[0].input).toMatchObject({
        transactionId: "txn-2",
      });
    });

    it("retries on transient errors with exponential backoff", async () => {
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
        registryId: "test-cluster-1",
        arcId: "arc_1",
        accountId: "acct_1",
        recipientAddress: "a@b.com",
        embedding: [1, 2],
      });

      // Advance past both retry delays (1s + 2s)
      await vi.advanceTimersByTimeAsync(3000);

      const result = await promise;
      expect(result.isOk()).toBe(true);
      expect(callCount).toBe(3);

      vi.useRealTimers();
    });

    it("returns err after 3 failed attempts on transient errors", async () => {
      const transientError = Object.assign(new Error("Service unavailable"), {
        name: "InternalServerErrorException",
        $metadata: { httpStatusCode: 500 },
      });

      rdsMock.on(BeginTransactionCommand).rejects(transientError);

      const result = await writer.upsertEmbedding({
        registryId: "test-cluster-1",
        arcId: "arc_1",
        accountId: "acct_1",
        recipientAddress: "a@b.com",
        embedding: [1],
      });

      expect(result.isErr()).toBe(true);

      // 3 attempts total (initial + 2 retries)
      const beginCalls = rdsMock.commandCalls(BeginTransactionCommand);
      expect(beginCalls).toHaveLength(3);
    });

    it("returns err for non-transient errors", async () => {
      const nonTransientError = new Error("BadRequestException: invalid SQL");

      rdsMock.on(BeginTransactionCommand).rejects(nonTransientError);

      const result = await writer.upsertEmbedding({
        registryId: "test-cluster-1",
        arcId: "arc_1",
        accountId: "acct_1",
        recipientAddress: "a@b.com",
        embedding: [1],
      });

      expect(result.isErr()).toBe(true);

      // Only 1 call — no retries
      const beginCalls = rdsMock.commandCalls(BeginTransactionCommand);
      expect(beginCalls).toHaveLength(1);
    });
  });

  describe("findMatch", () => {
    it("returns arcId when a match is found within threshold", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-find-1" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({ records: [[{ stringValue: "arc_match_1" }]] }) // SELECT
        .on(CommitTransactionCommand).resolves({});

      const result = await writer.findMatch({
        registryId: "test-cluster-1",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.5, 0.6, 0.7],
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ arcId: "arc_match_1" });

      // Verify the SELECT query
      const execCalls = rdsMock.commandCalls(ExecuteStatementCommand);
      const selectInput = execCalls[1]!.args[0].input as { sql?: string; parameters?: unknown[] };
      expect(selectInput.sql).toContain("SELECT arc_id FROM arc_embeddings");
      expect(selectInput.sql).toContain("embedding <=> :embedding::vector < :threshold");
      expect(selectInput.sql).toContain("ORDER BY embedding <=> :embedding::vector");
      expect(selectInput.sql).toContain("LIMIT 1");
    });

    it("returns null when no match is found", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-find-2" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({ records: [] }) // SELECT — no results
        .on(CommitTransactionCommand).resolves({});

      const result = await writer.findMatch({
        registryId: "test-cluster-1",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.1, 0.2],
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns null when records is undefined", async () => {
      rdsMock
        .on(BeginTransactionCommand).resolves({ transactionId: "txn-find-3" })
        .on(ExecuteStatementCommand)
          .resolvesOnce({}) // SET LOCAL
          .resolvesOnce({}) // SELECT — no records field
        .on(CommitTransactionCommand).resolves({});

      const result = await writer.findMatch({
        registryId: "test-cluster-1",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.1],
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("retries on transient errors", async () => {
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
        registryId: "test-cluster-1",
        accountId: "acct_1",
        recipientAddress: "user@example.com",
        embedding: [0.1],
      });

      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ arcId: "arc_retried" });
      expect(beginCallCount).toBe(2);

      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // Property-based tests (converted to static edge cases)
  // ---------------------------------------------------------------------------

  describe("property tests", () => {
    // Property 16: Aurora retries with exponential backoff up to 3 attempts
    // **Validates: Requirements 6.4**

    const transientErrorTypes: Array<[string, { errorName: string }]> = [
      ["InternalServerErrorException", { errorName: "InternalServerErrorException" }],
      ["ThrottlingException", { errorName: "ThrottlingException" }],
      ["ServiceUnavailableError", { errorName: "ServiceUnavailableError" }],
      ["StatementTimeoutException", { errorName: "StatementTimeoutException" }],
    ];

    it.each(transientErrorTypes)(
      "retries transient error %s up to 3 attempts with exponential backoff",
      async (_label, { errorName }) => {
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
          fn();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout);

        try {
          rdsMock.reset();

          const transientError = Object.assign(new Error(`Transient: ${errorName}`), {
            name: errorName,
          });

          rdsMock.on(BeginTransactionCommand).rejects(transientError);

          const result = await writer.upsertEmbedding({
            registryId: "test-cluster-1",
            arcId: "arc-retry-test",
            accountId: "acct-retry-test",
            recipientAddress: "retry@example.com",
            embedding: [0.1, 0.2, 0.3],
          });

          // After 3 failed attempts, the result should be an error
          expect(result.isErr()).toBe(true);

          // Verify exactly 3 attempts were made (initial + 2 retries)
          const beginCalls = rdsMock.commandCalls(BeginTransactionCommand);
          expect(beginCalls).toHaveLength(3);

          // Verify exponential backoff delays: 1s after attempt 0, 2s after attempt 1
          const delayCalls = setTimeoutSpy.mock.calls;
          expect(delayCalls).toHaveLength(2);
          expect(delayCalls[0]![1]).toBe(1000);
          expect(delayCalls[1]![1]).toBe(2000);
        } finally {
          setTimeoutSpy.mockRestore();
        }
      },
      { timeout: 30000 },
    );

    // Property 16 (recovery): Verify successful retry after N failures
    const recoveryCases: Array<[string, { failCount: number }]> = [
      ["succeeds after 1 transient failure", { failCount: 1 }],
      ["succeeds after 2 transient failures", { failCount: 2 }],
    ];

    it.each(recoveryCases)(
      "%s",
      async (_label, { failCount }) => {
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
          fn();
          return 0 as unknown as NodeJS.Timeout;
        }) as typeof setTimeout);

        try {
          rdsMock.reset();

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

          // Should succeed without error
          const result = await writer.upsertEmbedding({
            registryId: "test-cluster-1",
            arcId: "arc-recovery",
            accountId: "acct-recovery",
            recipientAddress: "recovery@example.com",
            embedding: [0.1, 0.2, 0.3],
          });

          expect(result.isOk()).toBe(true);

          // Verify the correct number of attempts: failCount failures + 1 success
          expect(callCount).toBe(failCount + 1);

          // Verify the backoff delays match the exponential schedule
          const expectedDelays = [1000, 2000, 4000];
          const delayCalls = setTimeoutSpy.mock.calls;
          expect(delayCalls).toHaveLength(failCount);
          for (let i = 0; i < failCount; i++) {
            expect(delayCalls[i]![1]).toBe(expectedDelays[i]);
          }
        } finally {
          setTimeoutSpy.mockRestore();
        }
      },
      { timeout: 30000 },
    );

    // Property 16 (non-transient errors): Non-transient errors are NOT retried
    const nonTransientErrorTypes: Array<[string, { errorName: string }]> = [
      ["BadRequestException", { errorName: "BadRequestException" }],
      ["ValidationException", { errorName: "ValidationException" }],
      ["AccessDeniedException", { errorName: "AccessDeniedException" }],
      ["NotFoundException", { errorName: "NotFoundException" }],
    ];

    it.each(nonTransientErrorTypes)(
      "non-transient error %s is not retried",
      async (_label, { errorName }) => {
        rdsMock.reset();

        const nonTransientError = Object.assign(new Error(`Non-transient: ${errorName}`), {
          name: errorName,
        });

        rdsMock.on(BeginTransactionCommand).rejects(nonTransientError);

        const result = await writer.upsertEmbedding({
          registryId: "test-cluster-1",
          arcId: "arc-nontransient",
          accountId: "acct-nontransient",
          recipientAddress: "nontransient@example.com",
          embedding: [0.1, 0.2, 0.3],
        });

        expect(result.isErr()).toBe(true);

        // Only 1 attempt — no retries for non-transient errors
        const beginCalls = rdsMock.commandCalls(BeginTransactionCommand);
        expect(beginCalls).toHaveLength(1);
      },
      { timeout: 30000 },
    );

    // Property 9: All embedding upserts are idempotent
    // **Validates: Requirements 3.4, 6.1, 6.3**

    const idempotencyCases: Array<[string, { repeatCount: number }]> = [
      ["2 repeated writes produce identical SQL", { repeatCount: 2 }],
      ["3 repeated writes produce identical SQL", { repeatCount: 3 }],
      ["5 repeated writes produce identical SQL", { repeatCount: 5 }],
    ];

    it.each(idempotencyCases)(
      "%s",
      async (_label, { repeatCount }) => {
        rdsMock.reset();

        let txnCounter = 0;
        rdsMock
          .on(BeginTransactionCommand).callsFake(() => ({ transactionId: `txn-${++txnCounter}` }))
          .on(ExecuteStatementCommand).resolves({})
          .on(CommitTransactionCommand).resolves({});

        const arcId = "arc-idempotent";
        const accountId = "acct-idempotent";
        const recipientAddress = "idempotent@example.com";
        const embedding = [0.1, 0.2, 0.3, -0.5, 0.0];

        // Perform the upsert N times with the same inputs
        for (let i = 0; i < repeatCount; i++) {
          await writer.upsertEmbedding({
            registryId: "test-cluster-1",
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
      },
      { timeout: 30000 },
    );

    // Property 15: Aurora upserts run inside an RLS-scoped transaction
    // Validates: Requirements 6.2
    it(
      "upserts execute BeginTransaction → SET LOCAL → INSERT ON CONFLICT → CommitTransaction on the same transactionId",
      async () => {
        rdsMock.reset();

        const txnId = "txn-rls-test";

        rdsMock
          .on(BeginTransactionCommand).resolves({ transactionId: txnId })
          .on(ExecuteStatementCommand).resolves({})
          .on(CommitTransactionCommand).resolves({});

        const arcId = "arc-rls";
        const accountId = "acct-rls";
        const recipientAddress = "rls@example.com";
        const embedding = [0.1, 0.2, 0.3];

        await writer.upsertEmbedding({
          registryId: "test-cluster-1",
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
        expect(beginInput.resourceArn).toBe("arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1");
        expect(beginInput.secretArn).toBe("arn:aws:secretsmanager:eu-central-1:111111111111:secret:test-1");
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
      },
      { timeout: 10000 },
    );
  });
});
