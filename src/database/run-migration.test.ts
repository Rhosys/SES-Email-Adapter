import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { runMigration } from "./run-migration.js";

// ---------------------------------------------------------------------------
// Mock the cluster registry
// ---------------------------------------------------------------------------

vi.mock("../embedding/cluster-registry.js", () => {
  const cluster = Object.freeze({
    registryId: "test-cluster-1",
    clusterArn: "arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1",
    secretArn: "arn:aws:secretsmanager:eu-central-1:111111111111:secret:test-1",
    databaseName: "testdb",
    modelId: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    active: true,
  });
  return {
    CLUSTER_REGISTRY: Object.freeze([cluster]),
    getPrimaryArcMatcherRegistry: () => cluster,
  };
});

// ---------------------------------------------------------------------------
// Mock fs/promises to avoid reading actual files in tests
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("-- mock SQL migration content"),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const rdsMock = mockClient(RDSDataClient);

describe("runMigration", () => {
  beforeEach(() => {
    rdsMock.reset();
  });

  it("executes the migration SQL and verifies PK shape", async () => {
    rdsMock
      .on(ExecuteStatementCommand)
      .resolvesOnce({ records: [] }) // migration execution
      .resolvesOnce({               // PK verification query
        records: [
          [{ stringValue: "arc_id" }],
          [{ stringValue: "account_id" }],
          [{ stringValue: "recipient_address" }],
        ],
      });

    const result = await runMigration({
      rdsClient: new RDSDataClient({}),
      migrationPath: "/fake/path/migration.sql",
    });

    expect(result.executed).toBe(true);
    expect(result.pkColumns).toEqual(["arc_id", "account_id", "recipient_address"]);
    expect(result.valid).toBe(true);
    expect(result.clusterArn).toBe("arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1");
  });

  it("reports invalid when PK columns do not match expected shape", async () => {
    rdsMock
      .on(ExecuteStatementCommand)
      .resolvesOnce({ records: [] }) // migration execution
      .resolvesOnce({               // return old single-column PK
        records: [[{ stringValue: "arc_id" }]],
      });

    const result = await runMigration({
      rdsClient: new RDSDataClient({}),
      migrationPath: "/fake/path/migration.sql",
    });

    expect(result.executed).toBe(true);
    expect(result.pkColumns).toEqual(["arc_id"]);
    expect(result.valid).toBe(false);
  });

  it("sends the SQL content to the correct cluster ARN and secret", async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({ records: [] });

    await runMigration({
      rdsClient: new RDSDataClient({}),
      migrationPath: "/fake/path/migration.sql",
    });

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls.length).toBe(2);

    // First call: execute migration
    const migrationCall = calls[0]!.args[0].input;
    expect(migrationCall.resourceArn).toBe("arn:aws:rds:eu-central-1:111111111111:cluster:test-cluster-1");
    expect(migrationCall.secretArn).toBe("arn:aws:secretsmanager:eu-central-1:111111111111:secret:test-1");
    expect(migrationCall.database).toBe("testdb");
    expect(migrationCall.sql).toBe("-- mock SQL migration content");

    // Second call: verify PK
    const verifyCall = calls[1]!.args[0].input;
    expect(verifyCall.sql).toContain("information_schema.table_constraints");
    expect(verifyCall.sql).toContain("information_schema.key_column_usage");
    expect(verifyCall.sql).toContain("PRIMARY KEY");
  });

  it("propagates RDS Data API errors", async () => {
    rdsMock.on(ExecuteStatementCommand).rejectsOnce(new Error("Access denied"));

    await expect(
      runMigration({
        rdsClient: new RDSDataClient({}),
        migrationPath: "/fake/path/migration.sql",
      }),
    ).rejects.toThrow("Access denied");
  });

  it("is idempotent — second apply is a no-op and PK shape matches (arc_id, account_id, recipient_address)", async () => {
    // Both runs return the composite PK shape (the migration SQL is idempotent —
    // it checks for existing PK before altering). The mock simulates the RDS Data API
    // responding identically on both invocations.
    const compositePkResponse = {
      records: [
        [{ stringValue: "arc_id" }],
        [{ stringValue: "account_id" }],
        [{ stringValue: "recipient_address" }],
      ],
    };

    rdsMock
      .on(ExecuteStatementCommand)
      // First run: execute migration + verify PK
      .resolvesOnce({ records: [] })
      .resolvesOnce(compositePkResponse)
      // Second run: execute migration (no-op) + verify PK
      .resolvesOnce({ records: [] })
      .resolvesOnce(compositePkResponse);

    // First apply
    const firstResult = await runMigration({
      rdsClient: new RDSDataClient({}),
      migrationPath: "/fake/path/migration.sql",
    });

    expect(firstResult.executed).toBe(true);
    expect(firstResult.valid).toBe(true);
    expect(firstResult.pkColumns).toEqual(["arc_id", "account_id", "recipient_address"]);

    // Second apply — should not throw and should produce the same valid result
    const secondResult = await runMigration({
      rdsClient: new RDSDataClient({}),
      migrationPath: "/fake/path/migration.sql",
    });

    expect(secondResult.executed).toBe(true);
    expect(secondResult.valid).toBe(true);
    expect(secondResult.pkColumns).toEqual(["arc_id", "account_id", "recipient_address"]);

    // Verify both runs sent the same SQL (idempotent migration script)
    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls.length).toBe(4); // 2 calls per run × 2 runs

    // Migration SQL is the same on both runs
    const firstMigrationSql = calls[0]!.args[0].input.sql;
    const secondMigrationSql = calls[2]!.args[0].input.sql;
    expect(firstMigrationSql).toBe(secondMigrationSql);
  });
});
