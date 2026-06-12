# Design Document

## Overview

This design introduces Drizzle ORM as both the schema management layer and runtime query interface for the Aurora Serverless v2 PostgreSQL cluster used by email-catcher. Drizzle serves three purposes: (1) declarative schema definition with compile-time type safety, (2) generating migration SQL via `drizzle-kit generate`, and (3) type-safe runtime queries in the `ArcMatcher` class.

Migrations are applied by AWS CodeBuild, triggered non-blocking by CI after code deploy. CodeBuild downloads the same Lambda deployment zip (which includes a `migrate.js` entry point alongside the main `handler.js`), and runs it using the managed image's pre-installed AWS SDK.

### Design decisions and rationale

| Decision | Rationale |
|---|---|
| Drizzle for schema management AND runtime queries | Type-safe column references catch schema drift at compile time. The Data API driver works without VPC connectivity. Runtime queries get compile-time verification against `schema.ts`. |
| CodeBuild for migration execution (non-blocking) | No 15-minute timeout ceiling. CI triggers it after deploy completes. Non-blocking means CI finishes fast. CodeBuild handles Aurora auto-pause resume gracefully (minutes of patience). |
| Same zip for Lambda and CodeBuild | One build artifact, two entry points (`handler.js` for Lambda, `migrate.js` for CodeBuild). No separate artifact to maintain. CodeBuild sources from the same S3 key that Lambda deploys from. |
| `@aws-sdk/*` external in both bundles | The managed CodeBuild image (`aws/codebuild/standard:8.0`) ships Node.js 22+ with AWS SDK pre-installed. Same as Lambda's runtime providing the SDK. No need to inline — keeps bundles small. |
| CI triggers CodeBuild (not TF) | Pipeline sequence is: TF apply → deploy code → trigger CodeBuild. TF runs before code is uploaded, so TF can't trigger CodeBuild with the latest migrations. CI triggers after both are done. |
| Migrations live at `src/migrations/` | Co-located with the runner that uses them. No `deploy/migrations/` — esbuild bundles the SQL files into the output alongside `migrate.js`. |
| Shared CloudWatch log group | Reuse `/aws/lambda/${var.service_name}` — no new log group. CodeBuild writes to a `migrate/` stream prefix within it. |
| Destructive DDL blocklist in the runner | Defense in depth: even if a migration file contains `DROP TABLE`, the runner refuses to execute it. Combined with code review on migration files, this makes accidental data loss require two independent failures. |
| `DO $$ ... EXCEPTION WHEN duplicate_object` for RLS policies | PostgreSQL's `CREATE POLICY` has no `IF NOT EXISTS`. The exception handler makes it idempotent for re-runs. |
| `SET LOCAL` via `tx.execute(sql\`...\`)` | Drizzle's transaction API supports raw SQL execution within a transaction. This preserves RLS enforcement while removing manual transaction command plumbing. |

## Architecture

### Component diagram

```
┌─────────────────────────────────────────────────────────┐
│  Developer workflow                                       │
│                                                          │
│  1. Edit src/database/schema.ts                          │
│  2. npm run db:generate  →  src/migrations/XXXX.sql     │
│  3. git commit (pre-commit hook runs drizzle-kit check)  │
└────────────────────────────┬────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────┐
│  CI Pipeline (GitHub Actions)                            │
│                                                          │
│  1. npm test (includes drizzle-kit check as CI gate)     │
│  2. npm run build (esbuild → handler.js + migrate.js)    │
│  3. tofu apply (provisions CodeBuild project + Aurora)   │
│  4. npm run deploy (uploads zip to S3, updates Lambda)   │
│  5. aws codebuild start-build (non-blocking, last step)  │
│     └─ CodeBuild downloads same zip from S3              │
│        └─ node migrate.js                                │
│           └─ Drizzle migrate() via RDS Data API          │
│              └─ applies pending .sql files               │
│              └─ records in __drizzle_migrations          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Runtime (main Lambda — handler.js)                      │
│                                                          │
│  ArcMatcher uses Drizzle query builder:                  │
│  db.transaction() → SET LOCAL → select/insert            │
│  Column refs type-checked against schema.ts at build     │
└─────────────────────────────────────────────────────────┘
```

### File layout

```
email-catcher/backend/
├── src/database/
│   ├── schema.ts              # Drizzle schema definition (source of truth)
│   ├── drizzle.ts             # Shared Drizzle db instance factory (Data API driver)
│   ├── arc-matcher.ts         # Runtime queries using Drizzle query builder
│   └── ...
├── src/migrations/
│   ├── run.ts                 # Migration runner entry point (CodeBuild runs this)
│   ├── 0000_init.sql          # Generated + custom SQL (committed, immutable)
│   └── meta/
│       ├── _journal.json
│       └── 0000_snapshot.json
├── deploy/
│   ├── search.tf             # Aurora cluster (existing) + CodeBuild project
│   └── ...
├── drizzle.config.ts          # Drizzle Kit config: schema → src/database/schema.ts, out → src/migrations
└── package.json               # + drizzle-orm, drizzle-kit deps
```

### Build step in `make.ts`

```typescript
// Existing main Lambda bundle
await esbuild.build({
  ...esbuildDefaults,
  entryPoints: ['src/handler.ts'],
  outfile: 'dist/main/handler.js',
});

// Migration runner — same zip, separate entry point
await esbuild.build({
  ...esbuildDefaults,
  entryPoints: ['src/migrations/run.ts'],
  outfile: 'dist/main/migrate.js',
});

// Copy migration SQL files into the bundle (esbuild doesn't handle .sql)
copyDirSync('src/migrations', 'dist/main/migrations', { filter: /\.(sql|json)$/ });
```

Both `handler.js` and `migrate.js` end up in `dist/main/` → zipped and uploaded as one artifact. Lambda uses `handler.js`. CodeBuild uses `migrate.js`.

### Schema definition (`src/database/schema.ts`)

```typescript
import { pgTable, text, index, primaryKey, timestamp } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";

export const arcEmbeddings = pgTable("arc_embeddings", {
  arcId: text("arc_id").notNull(),
  accountId: text("account_id").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.arcId, table.accountId, table.recipientAddress] }),
  index("arc_embeddings_hnsw_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
]);
```

### Migration runner (`src/migrations/run.ts`)

```typescript
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import { migrate } from "drizzle-orm/aws-data-api/pg/migrator";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CLUSTER_ARN = process.env["AURORA_CLUSTER_ARN"]!;
const SECRET_ARN = process.env["AURORA_SECRET_ARN"]!;
const DB_NAME = process.env["AURORA_DB_NAME"]!;

const DESTRUCTIVE_PATTERNS = [/DROP\s+TABLE/i, /DROP\s+COLUMN/i, /TRUNCATE/i];
const migrationsFolder = join(import.meta.dirname, "migrations");

// Safety check: scan all .sql files for destructive DDL before running anything
const sqlFiles = readdirSync(migrationsFolder).filter(f => f.endsWith(".sql"));
for (const file of sqlFiles) {
  const content = readFileSync(join(migrationsFolder, file), "utf-8");
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(content)) {
      console.error(JSON.stringify({ status: "aborted", reason: `Destructive DDL detected in ${file}`, pattern: pattern.source }));
      process.exit(1);
    }
  }
}

const client = new RDSDataClient({});
const db = drizzle(client, {
  database: DB_NAME,
  secretArn: SECRET_ARN,
  resourceArn: CLUSTER_ARN,
});

await migrate(db, { migrationsFolder });
console.log(JSON.stringify({ status: "complete", migrationsChecked: sqlFiles.length }));
```

### Runtime query example (`src/database/arc-matcher.ts`)

```typescript
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import { eq, and, sql } from "drizzle-orm";
import { arcEmbeddings } from "./schema.js";

// Inside findMatch:
await db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL app.current_account_id = '${sql.raw(accountId.replace(/'/g, "''"))}'`);

  const result = await tx
    .select({ arcId: arcEmbeddings.arcId })
    .from(arcEmbeddings)
    .where(and(
      eq(arcEmbeddings.accountId, accountId),
      eq(arcEmbeddings.recipientAddress, recipientAddress),
      sql`${arcEmbeddings.embedding} <=> ${embedding}::vector < ${threshold}`,
    ))
    .orderBy(sql`${arcEmbeddings.embedding} <=> ${embedding}::vector`)
    .limit(1);

  return result[0]?.arcId ?? null;
});

// Inside upsertEmbedding:
await db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL app.current_account_id = '${sql.raw(accountId.replace(/'/g, "''"))}'`);

  await tx
    .insert(arcEmbeddings)
    .values({ arcId, accountId, recipientAddress, embedding, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [arcEmbeddings.arcId, arcEmbeddings.accountId, arcEmbeddings.recipientAddress],
      set: { embedding, updatedAt: new Date() },
    });
});
```

### Terraform resources

```hcl
# CodeBuild project for running migrations
resource "aws_codebuild_project" "migration" {
  name         = "${lower(var.service_name)}-migrate"
  service_role = aws_iam_role.codebuild_migrate.arn

  artifacts { type = "NO_ARTIFACTS" }

  source {
    type     = "S3"
    location = "${local.deployment_bucket}/${var.service_name}/${var.service_name}/latest/lambda.zip"
  }

  environment {
    compute_type = "BUILD_GENERAL1_SMALL"
    image        = "aws/codebuild/standard:8.0"
    type         = "LINUX_CONTAINER"

    environment_variable {
      name  = "AURORA_CLUSTER_ARN"
      value = aws_rds_cluster.aurora["aurora-prod-titan-v2"].arn
    }
    environment_variable {
      name  = "AURORA_SECRET_ARN"
      value = aws_rds_cluster.aurora["aurora-prod-titan-v2"].master_user_secret[0].secret_arn
    }
    environment_variable {
      name  = "AURORA_DB_NAME"
      value = "signals"
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.shared.name
      stream_name = "migrate"
    }
  }

  build_timeout = 30 # minutes — generous for DDL + Aurora resume
}

# IAM role for CodeBuild
resource "aws_iam_role" "codebuild_migrate" {
  name = "${var.service_name}-codebuild-migrate"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "codebuild_migrate" {
  name = "migrate"
  role = aws_iam_role.codebuild_migrate.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["rds-data:ExecuteStatement", "rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction", "rds-data:BatchExecuteStatement"]
        Resource = aws_rds_cluster.aurora["aurora-prod-titan-v2"].arn
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_rds_cluster.aurora["aurora-prod-titan-v2"].master_user_secret[0].secret_arn
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.shared.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetBucketLocation"]
        Resource = ["arn:aws:s3:::${local.deployment_bucket}/*", "arn:aws:s3:::${local.deployment_bucket}"]
      }
    ]
  })
}
```

CI triggers it non-blocking as the final deploy step:
```yaml
- name: Trigger Migrations
  run: aws codebuild start-build --project-name ${{ env.TF_VAR_service_name }}-migrate
```

### CodeBuild buildspec (inline in TF or bundled)

```yaml
version: 0.2
phases:
  build:
    commands:
      - node migrate.js
```

### Custom migration for extensions + RLS

The initial migration (generated via `drizzle-kit generate --custom`) includes:

```sql
-- Custom: pgvector extension (not expressible in Drizzle schema)
CREATE EXTENSION IF NOT EXISTS vector;

-- Generated by Drizzle Kit from schema.ts:
CREATE TABLE IF NOT EXISTS "arc_embeddings" (
  "arc_id" text NOT NULL,
  "account_id" text NOT NULL,
  "recipient_address" text NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "arc_embeddings_pkey" PRIMARY KEY ("arc_id", "account_id", "recipient_address")
);

CREATE INDEX IF NOT EXISTS "arc_embeddings_hnsw_idx"
  ON "arc_embeddings" USING hnsw ("embedding" vector_cosine_ops);

-- Custom: Row-Level Security (not expressible in Drizzle schema)
ALTER TABLE "arc_embeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "arc_embeddings" FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY arc_tenant_isolation ON arc_embeddings
    USING (account_id = current_setting('app.current_account_id', true))
    WITH CHECK (account_id = current_setting('app.current_account_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

### Safety mechanisms

1. **Immutable migrations** — Convention rule: never modify committed migration files. Drizzle's journal records a hash per migration; content changes cause `migrate()` to throw.
2. **Destructive DDL blocklist** — The runner scans pending SQL for `DROP TABLE`, `DROP COLUMN`, `TRUNCATE` before executing. Abort on match.
3. **Transactional execution** — Each migration runs in a transaction. Partial application is impossible.
4. **Pre-commit hook** — `drizzle-kit check` blocks commit if schema.ts is modified without regenerating migrations.
5. **CI gate** — `drizzle-kit check` runs unconditionally in the pipeline, catching hook bypasses.
6. **Code review** — Migration files are committed artifacts visible in pull requests. Dangerous DDL is reviewable.
7. **Type-safe queries** — Column references in runtime code are validated against schema.ts by `tsc`. Schema renames break the build before reaching production.

## Dependencies

| Package | Purpose | Version constraint |
|---|---|---|
| `drizzle-orm` | Runtime queries + migrate() | `^0.44` (latest stable) |
| `drizzle-kit` | devDep — generate migrations from schema | `^0.31` |
| `@aws-sdk/client-rds-data` | RDS Data API client (already present) | existing |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Drizzle Kit `@aws-sdk` bundling bug (#5050) | Only affects `drizzle-kit migrate` CLI — we use `drizzle-orm` `migrate()` programmatically, which is unaffected. |
| CodeBuild managed image SDK version drift | The RDS Data API client interface is stable. If a breaking change occurs, pin by switching to inlined SDK (remove from externals) in a single commit. |
| Aurora auto-pause on first invocation | CodeBuild has 30min timeout — resume takes 45s max. No risk. |
| RLS policy `CREATE POLICY` not idempotent | Wrapped in `DO $$ ... EXCEPTION WHEN duplicate_object` block. |
| Future schema changes need RLS awareness | Document that any new table needing tenant isolation must include RLS in its custom migration section. |
| `CREATE INDEX CONCURRENTLY` on large tables | Non-blocking to other connections but blocks the issuing connection. CodeBuild's 30min timeout (configurable to 8h) handles this. Not a concern for Lambda runtime. |
