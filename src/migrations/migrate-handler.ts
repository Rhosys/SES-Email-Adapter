// ---------------------------------------------------------------------------
// Migration handler — executed by CodeBuild after deploy.
// Applies pending Drizzle migrations via the RDS Data API.
// ---------------------------------------------------------------------------

import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import { migrate } from "drizzle-orm/aws-data-api/pg/migrator";
import { readFile, readdir } from "node:fs/promises";
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
const ALLOW_DESTRUCTIVE_MARKER = "-- @allow-destructive";
const migrationsFolder = join(import.meta.dirname, "migrations");

const allFiles = await readdir(migrationsFolder);
const sqlFiles = allFiles.filter(f => f.endsWith(".sql"));
logger.info("Scanning migration files for destructive DDL", { fileCount: sqlFiles.length });

for (const file of sqlFiles) {
  const content = await readFile(join(migrationsFolder, file), "utf-8");
  if (content.includes(ALLOW_DESTRUCTIVE_MARKER)) continue;
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(content)) {
      logger.critical("Destructive DDL detected — aborting migration", { code: "migrate.destructive_ddl", file, pattern: pattern.source });
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Apply pending migrations (with retry for Aurora auto-pause resume)
// ---------------------------------------------------------------------------

logger.trackPoint("migrate_start");

const client = new RDSDataClient({});
const db = drizzle(client, {
  database: DB_NAME,
  secretArn: SECRET_ARN,
  resourceArn: CLUSTER_ARN,
});

const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 5000;

async function migrationWrapper() {
  const errors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await migrate(db, { migrationsFolder });
      logger.trackPoint("migrate_complete");
      logger.info("Migration complete", { migrationsChecked: sqlFiles.length, attempts: attempt });
      return;
    } catch (e) {
      errors.push(e);
      const message = e instanceof Error ? e.message : String(e);
      const isResuming = message.includes("resuming after being auto-paused");
      const isTransient = message.includes("Communications link failure")
        || message.includes("Connection reset")
        || message.includes("CREATE SCHEMA");

      // First attempt hitting a paused cluster — wait the full wake time silently
      if (isResuming && attempt === 1) {
        logger.info("Aurora cluster is resuming from auto-pause — waiting 25s", { code: "migrate.aurora_resume", attempt });
        await new Promise(r => setTimeout(r, 25_000));
        continue;
      }

      if ((isResuming || isTransient) && attempt < MAX_ATTEMPTS) {
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn("Migration attempt failed — retrying", { code: "migrate.retry", attempt, maxAttempts: MAX_ATTEMPTS, reason: message, nextDelayMs: delayMs, error: e });
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      logger.error("Migration failed due to unretryable reason", { code: "migrate.failed", reason: message, attempts: attempt, error: e, errors });
      process.exit(1);
    }
  }

  logger.error("Migration failed after retries", { code: "migrate.failed", errors });
  process.exit(1);
}

await migrationWrapper();
