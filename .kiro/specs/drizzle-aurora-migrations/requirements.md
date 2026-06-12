# Requirements Document

## Introduction

The `arc_embeddings` table in Aurora Serverless v2 (PostgreSQL 17 + pgvector) has never been created in production. The DDL exists only as a comment in `deploy/search.tf`. This spec introduces a safe, repeatable migration system using Drizzle ORM to manage the Aurora schema, with a dedicated Lambda function triggered by Terraform on every apply.

The system must guarantee:
- Schema changes are generated from a declarative TypeScript schema (never hand-written SQL)
- Migrations are immutable once committed — accidental modification is caught before production
- The migration Lambda is invoked by Terraform during `tofu apply` and is idempotent (safe to re-run)
- No destructive DDL can be executed without explicit, reviewable intent

## Glossary

- **Drizzle Schema**: A TypeScript file defining the desired database state using `drizzle-orm/pg-core` (tables, columns, indexes, constraints).
- **Drizzle Kit**: The CLI tool (`drizzle-kit generate`) that diffs the schema against a snapshot to produce migration SQL files.
- **Migration Lambda**: A dedicated AWS Lambda function whose sole purpose is applying pending Drizzle migrations via the RDS Data API.
- **`aws_lambda_invocation`**: A Terraform resource that synchronously invokes a Lambda during `tofu apply`, re-invoking when its `input` changes.
- **RLS Policy**: PostgreSQL Row-Level Security policy enforcing tenant isolation via `current_setting('app.current_account_id', true)`.

## Requirements

### Requirement 1: Declarative Schema Definition

**User Story:** As an engineer, I want the Aurora table schema defined in TypeScript using Drizzle's schema DSL, so that the desired state is type-checked, code-reviewed, and serves as the single source of truth for what the database looks like.

#### Acceptance Criteria

1. THE schema SHALL be defined in a `src/database/schema.ts` file using `drizzle-orm/pg-core` and `pgvector` column types.
2. THE schema SHALL declare the `arc_embeddings` table with columns: `arc_id TEXT NOT NULL`, `account_id TEXT NOT NULL`, `recipient_address TEXT NOT NULL`, `embedding vector(1024) NOT NULL`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`.
3. THE schema SHALL declare a composite primary key on `(arc_id, account_id, recipient_address)`.
4. THE schema SHALL declare an HNSW index on the `embedding` column using `vector_cosine_ops`.
5. THE schema file SHALL be the canonical reference for the database structure — no other file defines what tables or columns exist.

### Requirement 2: Migration Generation via Drizzle Kit

**User Story:** As an engineer, I want schema changes to produce SQL migration files automatically, so that I never write DDL by hand and the generated SQL is reviewable in a merge request.

#### Acceptance Criteria

1. THE project SHALL include a `drizzle.config.ts` configuring Drizzle Kit with the schema path and migrations output directory (`src/migrations/`).
2. WHEN a developer modifies `src/database/schema.ts`, they SHALL run `npm run db:generate` to produce a new timestamped migration SQL file in `src/migrations/`.
3. THE generated migration files SHALL be committed to git and treated as immutable — the conventions rule "never modify existing database migrations" applies.
4. THE `drizzle-kit generate` command SHALL NOT require a database connection (it diffs against the local snapshot/journal only).

### Requirement 3: Custom Migration for PostgreSQL Extensions and RLS

**User Story:** As an engineer, I want to include `CREATE EXTENSION vector` and RLS policy statements in the migration system, so that the full schema (including extensions and security policies) is managed in one place.

#### Acceptance Criteria

1. THE initial migration SHALL include a custom SQL block that executes `CREATE EXTENSION IF NOT EXISTS vector` before table creation.
2. THE initial migration SHALL include RLS statements: `ALTER TABLE arc_embeddings ENABLE ROW LEVEL SECURITY`, `ALTER TABLE arc_embeddings FORCE ROW LEVEL SECURITY`, and the `arc_tenant_isolation` policy using `current_setting('app.current_account_id', true)`.
3. THE RLS policy creation SHALL use a `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` guard to be idempotent.
4. CUSTOM SQL that Drizzle Kit cannot generate SHALL be added via `drizzle-kit generate --custom` and clearly commented as hand-authored.

### Requirement 4: Migration Runner Script

**User Story:** As a system, I want a migration runner script that applies pending Drizzle migrations via the RDS Data API, so that it can be executed by CodeBuild without timeout constraints.

#### Acceptance Criteria

1. THE migration runner SHALL be a TypeScript script (`src/migrations/run.ts`) that instantiates a Drizzle db instance via `drizzle-orm/aws-data-api/pg` and calls `migrate()`.
2. THE migration runner SHALL use the same cluster ARN, secret ARN, and database name as the main Lambda (read from environment variables).
3. THE migration runner SHALL check each pending migration file for destructive DDL patterns (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`) before execution — aborting with an error if found.
4. THE migration runner SHALL output structured JSON logs indicating: migrations applied (list of filenames), migrations skipped (already applied), and any errors.
5. THE migration runner SHALL be bundled with the `deploy/migrations/` SQL files into an S3 artifact zip for CodeBuild to consume.

### Requirement 5: CodeBuild Project Provisioned by Terraform

**User Story:** As an operator, I want Terraform to provision the CodeBuild project with correct IAM and logging configuration, so that CI can trigger migration builds without manual setup.

#### Acceptance Criteria

1. THE Terraform configuration SHALL define an `aws_codebuild_project` with S3 source type pointing to the migration artifact zip.
2. THE CodeBuild project IAM role SHALL have permissions for: RDS Data API operations on the Aurora cluster, `secretsmanager:GetSecretValue` on the master user secret, CloudWatch Logs writes to the shared log group, and S3 read access to the artifact bucket.
3. THE CodeBuild project SHALL write logs to the existing shared CloudWatch log group (`/aws/lambda/${var.service_name}`) with a `migrate/` stream prefix.
4. THE `terraform_data.pgvector_init` resource (containing the commented-out DDL) SHALL be removed, replaced by this mechanism.
5. THE CodeBuild build timeout SHALL be 30 minutes — sufficient for Aurora resume + any reasonable DDL operation.

### Requirement 7: Pre-Commit Schema Sync Check

**User Story:** As an engineer, I want the pre-commit hook to block my commit if I modified the schema without regenerating migrations, so that I never accidentally commit a schema change without its corresponding migration file.

#### Acceptance Criteria

1. THE Husky pre-commit hook SHALL detect when `src/database/schema.ts` is staged and run `drizzle-kit check` to verify schema and migrations are in sync.
2. IF `drizzle-kit check` reports a drift (schema changed but no corresponding migration generated), THEN the commit SHALL be blocked with a message instructing the developer to run `npm run db:generate` and stage the result.
3. IF `drizzle-kit check` passes (no drift), THEN the commit SHALL proceed normally.
4. THE check SHALL NOT run if `src/database/schema.ts` is not in the staged changeset (avoid unnecessary delay on unrelated commits).

### Requirement 8: CI Schema Sync Gate

**User Story:** As a team, I want the CI pipeline to fail if schema and migrations are out of sync, so that bypassing the pre-commit hook (e.g. `--no-verify`) cannot ship a broken migration state to production.

#### Acceptance Criteria

1. THE CI pipeline SHALL run `drizzle-kit check` as part of the existing `npm run check` gate (or as a separate early stage).
2. IF `drizzle-kit check` detects drift between `src/database/schema.ts` and the committed migrations, THEN the pipeline SHALL fail before any deploy step.
3. THE CI check SHALL run unconditionally on every pipeline (not gated on which files changed) — it is a global invariant.

### Requirement 9: Runtime Queries via Drizzle ORM

**User Story:** As an engineer, I want the Aurora runtime queries (findMatch, upsertEmbedding) to use Drizzle's type-safe query builder, so that column references are validated against the schema at compile time and schema changes that break queries are caught by `tsc` before reaching production.

#### Acceptance Criteria

1. THE `ArcMatcher` class SHALL use a Drizzle `db` instance (via `drizzle-orm/aws-data-api/pg`) instead of raw `ExecuteStatementCommand` calls for all Aurora operations.
2. THE `findMatch` query SHALL use Drizzle's `select()`, `from()`, `where()`, `orderBy()`, and `limit()` with the `<=>` cosine operator expressed via `sql` template literal for the pgvector-specific operator.
3. THE `upsertEmbedding` operation SHALL use Drizzle's `insert().onConflictDoUpdate()` with the composite key `(arcId, accountId, recipientAddress)`.
4. THE `SET LOCAL app.current_account_id` statement SHALL be executed via `tx.execute(sql\`...\`)` inside a Drizzle `db.transaction()` block — the manual `BeginTransactionCommand`/`CommitTransactionCommand`/`RollbackTransactionCommand` plumbing SHALL be removed.
5. ALL column references in queries SHALL use the schema's column objects (e.g. `arcEmbeddings.arcId`) — never raw string column names. This ensures `tsc` fails if a column is renamed or removed in `schema.ts`.
6. THE existing retry logic (transient error detection, Aurora auto-pause resume) SHALL be preserved — it wraps the Drizzle transaction call, not the individual statements within it.
7. THE `MultiClusterAuroraWriter` interface and `ArcMatcherPort` interface SHALL remain unchanged — only the internal implementation of `ArcMatcher` changes.

### Requirement 10: CodeBuild Migration Runner (Non-Blocking)

**User Story:** As an operator, I want migrations to run in AWS CodeBuild (non-blocking) rather than a Lambda, so that long-running migrations (e.g. concurrent index builds on large tables) are not constrained by Lambda's 15-minute timeout.

#### Acceptance Criteria

1. THE migration runner SHALL be an `aws_codebuild_project` provisioned by Terraform, using the Node.js 24 managed image.
2. THE CodeBuild project source SHALL be an S3 artifact zip containing the bundled migration code and the `deploy/migrations/` SQL files — uploaded by CI as part of the deploy step.
3. THE CodeBuild IAM role SHALL have: `rds-data:*` on the Aurora cluster, `secretsmanager:GetSecretValue` on the master user secret, and `logs:CreateLogStream`/`logs:PutLogEvents` on the shared log group.
4. THE CodeBuild project SHALL write logs to the existing shared CloudWatch log group (`/aws/lambda/${var.service_name}`).
5. CI SHALL trigger `aws codebuild start-build` (non-blocking, no `--wait`) as the final pipeline step — after `tofu apply` and `npm run deploy` have both completed.
6. THE CodeBuild build SHALL execute `npx tsx src/migrations/run.ts` which calls Drizzle's `migrate()` via the Data API driver.
7. THE `terraform_data.pgvector_init` resource SHALL be removed, replaced by this mechanism.

### Requirement 6: Idempotency and Safety Guarantees

**User Story:** As an engineer, I want the migration system to be safe against accidental re-runs, modified migrations, and destructive DDL, so that production data is never corrupted by schema automation.

#### Acceptance Criteria

1. Drizzle's built-in `__drizzle_migrations` journal table SHALL track which migrations have been applied — the runner skips already-applied migrations.
2. THE migration runner SHALL NOT execute any migration whose SQL contains `DROP TABLE`, `DROP COLUMN`, or `TRUNCATE` — if detected, it SHALL abort with an error naming the offending file.
3. IF a previously-applied migration file's content has changed (detected via Drizzle's journal hash), THEN the runner SHALL abort with an error rather than re-applying or skipping silently.
4. THE migration runner SHALL execute within a transaction — if any statement fails, the entire migration is rolled back and the runner exits with a non-zero code.
5. REPEATED invocations with the same migration set SHALL be no-ops (the journal says they're already applied).
