// ---------------------------------------------------------------------------
// Migration handler — executed by CodeBuild after deploy.
// Applies pending Drizzle migrations via the RDS Data API.
// ---------------------------------------------------------------------------

import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import { migrate } from "drizzle-orm/aws-data-api/pg/migrator";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RequestLogger } from "../logger.js";

const logger = new RequestLogger({ serialize: true });
logger.startInvocation("migrate");

const CLUSTER_ARN = process.env["AURORA_CLUSTER_ARN"];
const SECRET_ARN = process.env["AURORA_SECRET_ARN"];
const DB_NAME = process.env["AURORA_DB_NAME"];

if (!CLUSTER_ARN || !SECRET_ARN || !DB_NAME) {
  logger.error("Missing required env vars: AURORA_CLUSTER_ARN, AURORA_SECRET_ARN, AURORA_DB_NAME", { code: "migrate.missing_env" });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Safety: scan all .sql files for destructive DDL before running anything
// ---------------------------------------------------------------------------

const DESTRUCTIVE_PATTERNS = [/DROP\s+TABLE/i, /DROP\s+COLUMN/i, /TRUNCATE/i];
const migrationsFolder = join(import.meta.dirname, "migrations");

const sqlFiles = readdirSync(migrationsFolder).filter(f => f.endsWith(".sql"));
logger.info("Scanning migration files for destructive DDL", { fileCount: sqlFiles.length });

for (const file of sqlFiles) {
  const content = readFileSync(join(migrationsFolder, file), "utf-8");
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(content)) {
      logger.critical("Destructive DDL detected — aborting migration", { code: "migrate.destructive_ddl", file, pattern: pattern.source });
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Apply pending migrations
// ---------------------------------------------------------------------------

logger.trackPoint("migrate_start");

const client = new RDSDataClient({});
const db = drizzle(client, {
  database: DB_NAME,
  secretArn: SECRET_ARN,
  resourceArn: CLUSTER_ARN,
});

try {
  await migrate(db, { migrationsFolder });
  logger.trackPoint("migrate_complete");
  logger.info("Migration complete", { migrationsChecked: sqlFiles.length });
} catch (e) {
  logger.error("Migration failed", { code: "migrate.failed", reason: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
