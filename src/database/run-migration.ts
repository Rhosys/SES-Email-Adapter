// ---------------------------------------------------------------------------
// Migration Runner
// Reads a SQL migration file and executes it via RDS Data API against the
// existing single cluster (from CLUSTER_REGISTRY). Verifies the resulting
// primary key shape via information_schema.
//
// Usage:
//   npx tsx src/database/run-migration.ts
//   (or import { runMigration } from './run-migration.js' for programmatic use)
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { getReadCluster } from "../embedding/cluster-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationResult {
  clusterArn: string;
  migrationFile: string;
  executed: boolean;
  pkColumns: string[];
  valid: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPECTED_PK_COLUMNS = ["arc_id", "account_id", "recipient_address"];

const MIGRATION_FILENAME = "2025-01-widen-arc-embeddings-pk.sql";

// ---------------------------------------------------------------------------
// Migration Runner
// ---------------------------------------------------------------------------

export async function runMigration(opts?: {
  rdsClient?: RDSDataClient;
  migrationPath?: string;
}): Promise<MigrationResult> {
  // Resolve the cluster — use the read cluster (first active entry in the registry)
  const cluster = getReadCluster();

  const rdsData = opts?.rdsClient ?? new RDSDataClient({});

  // Resolve migration file path
  const migrationPath = opts?.migrationPath ?? resolveDefaultMigrationPath();

  // Read the SQL migration file
  const sql = await readFile(migrationPath, "utf-8");

  // Execute the migration via RDS Data API
  await rdsData.send(new ExecuteStatementCommand({
    resourceArn: cluster.clusterArn,
    secretArn: cluster.secretArn,
    database: cluster.databaseName,
    sql,
  }));

  // Verify the new PK shape via information_schema
  const pkColumns = await verifyPrimaryKey(rdsData, cluster);

  const valid = arraysEqual(pkColumns, EXPECTED_PK_COLUMNS);

  return {
    clusterArn: cluster.clusterArn,
    migrationFile: migrationPath,
    executed: true,
    pkColumns,
    valid,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verifyPrimaryKey(
  rdsData: RDSDataClient,
  cluster: { clusterArn: string; secretArn: string; databaseName: string },
): Promise<string[]> {
  const result = await rdsData.send(new ExecuteStatementCommand({
    resourceArn: cluster.clusterArn,
    secretArn: cluster.secretArn,
    database: cluster.databaseName,
    sql: `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_name = 'arc_embeddings'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `,
  }));

  return (result.records ?? []).map((row) => row[0]?.stringValue ?? "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDefaultMigrationPath(): string {
  // Resolve relative to the project root (cwd), since this runs via `npx tsx`
  return resolve(process.cwd(), "deploy/migrations", MIGRATION_FILENAME);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, i) => val === b[i]);
}

// ---------------------------------------------------------------------------
// Standalone script entry-point
// When run directly via `npx tsx src/database/run-migration.ts`, execute the
// migration. When imported as a module, only the exported function is used.
// ---------------------------------------------------------------------------

if (process.argv[1]?.includes("run-migration")) {
  runMigration()
    .then((result) => {
      console.log("Migration complete:", JSON.stringify(result, null, 2));
      if (!result.valid) {
        console.error(
          `ERROR: PK verification failed. Expected [${EXPECTED_PK_COLUMNS.join(", ")}], got [${result.pkColumns.join(", ")}]`,
        );
        process.exitCode = 1;
      }
    })
    .catch((err: unknown) => {
      console.error("Migration failed:", err);
      process.exitCode = 1;
    });
}
