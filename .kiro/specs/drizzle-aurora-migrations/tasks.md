# Tasks

## Task 1: Add Drizzle dependencies and configuration
- [ ] Install `drizzle-orm` as a production dependency and `drizzle-kit` as a dev dependency
- [ ] Create `drizzle.config.ts` at the project root configuring: schema path (`src/database/schema.ts`), output directory (`src/migrations/`), dialect `postgresql`, and driver `aws-data-api`
- [ ] Add npm scripts: `db:generate` → `drizzle-kit generate`, `db:check` → `drizzle-kit check`
- [ ] Verify `npm run db:generate` runs without errors (produces empty migration set since schema doesn't exist yet)

## Task 2: Define the Drizzle schema for arc_embeddings
- [ ] Create `src/database/schema.ts` with the `arcEmbeddings` table definition using `pgTable`, `text`, `vector`, `timestamp`, `primaryKey`, and `index`
- [ ] Columns: `arc_id TEXT NOT NULL`, `account_id TEXT NOT NULL`, `recipient_address TEXT NOT NULL`, `embedding vector(1024) NOT NULL`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- [ ] Composite primary key on `(arc_id, account_id, recipient_address)`
- [ ] HNSW index on `embedding` with `vector_cosine_ops` operator class
- [ ] Run `npm run db:generate` to produce the initial migration SQL in `src/migrations/`

## Task 3: Add custom SQL for pgvector extension and RLS
- [ ] Prepend `CREATE EXTENSION IF NOT EXISTS vector;` to the generated initial migration file (before table creation)
- [ ] Append RLS statements after the table/index creation: `ALTER TABLE ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and the `arc_tenant_isolation` policy wrapped in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`
- [ ] Commit the migration file — it is now immutable

## Task 4: Build the migration runner script
- [ ] Create `src/migrations/run.ts` that: instantiates RDSDataClient, creates a Drizzle instance via `drizzle-orm/aws-data-api/pg`, reads pending `.sql` files from the co-located migrations directory, checks for destructive DDL patterns (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`), aborts if found, otherwise calls `migrate()` with the migrations folder path
- [ ] Log output as structured JSON — applied filenames, skipped filenames, errors
- [ ] Add a second esbuild entry point in `make.ts`: `src/migrations/run.ts` → `dist/main/migrate.js`
- [ ] Add a copy step in `make.ts` that copies `src/migrations/**/*.{sql,json}` into `dist/main/migrations/`
- [ ] Verify the existing zip upload includes both `handler.js` and `migrate.js` + `migrations/` directory
- [ ] Add unit test verifying the destructive DDL blocklist rejects files containing `DROP TABLE`

## Task 5: Terraform — CodeBuild project and IAM
- [ ] Define `aws_codebuild_project.migrate` in `deploy/search.tf` with: project name `${var.service_name}-migrate`, managed image `aws/codebuild/standard:8.0`, S3 source pointing to the same Lambda zip (`${deployment_bucket}/${service_name}/latest/lambda.zip`), inline buildspec that runs `node migrate.js`
- [ ] Define `aws_iam_role.codebuild_migrate` with trust policy for `codebuild.amazonaws.com`
- [ ] IAM permissions: `rds-data:*` on the Aurora cluster ARN, `secretsmanager:GetSecretValue` on the master user secret ARN, `logs:CreateLogStream`/`logs:PutLogEvents` on the shared log group, `s3:GetObject`/`s3:GetBucketLocation` on the deployment artifact bucket
- [ ] Configure `logs_config.cloudwatch_logs` to use the existing shared log group with stream prefix `migrate/`
- [ ] Pass environment variables: `AURORA_CLUSTER_ARN`, `AURORA_SECRET_ARN`, `AURORA_DB_NAME`
- [ ] Set build timeout to 30 minutes

## Task 6: CI — trigger CodeBuild after deploy
- [ ] Add a step in `.github/workflows/build.yml` `prod_deploy` job after `npm run deploy`: run `aws codebuild start-build --project-name ${TF_VAR_service_name}-migrate` (non-blocking)
- [ ] Remove the `terraform_data.pgvector_init` resource from `deploy/search.tf`
- [ ] Verify: push a commit with a new migration → CI deploys → triggers CodeBuild → CodeBuild applies migration (check CloudWatch logs)

## Task 7: Migrate ArcMatcher runtime queries to Drizzle
- [ ] Create a shared Drizzle `db` instance in `src/database/arc-matcher.ts` using `drizzle(rdsClient, { database, secretArn, resourceArn, schema })`
- [ ] Rewrite `findMatch` to use `db.transaction()` → `tx.execute(sql\`SET LOCAL ...\`)` → `tx.select().from(arcEmbeddings).where(...).orderBy(...).limit(1)` with `<=>` via `sql` template
- [ ] Rewrite `upsertEmbedding` to use `db.transaction()` → `tx.execute(sql\`SET LOCAL ...\`)` → `tx.insert(arcEmbeddings).values(...).onConflictDoUpdate(...)`
- [ ] Remove all raw `BeginTransactionCommand`/`ExecuteStatementCommand`/`CommitTransactionCommand`/`RollbackTransactionCommand` imports and usage
- [ ] Preserve the `withRetry` wrapper around the Drizzle transaction calls (retry logic unchanged)
- [ ] Run `npm test` — all 1965+ existing tests must still pass (the interfaces are unchanged, only internals change)
- [ ] Verify the per-cluster client cache still works (one Drizzle `db` instance per cluster registry entry)

## Task 8: Pre-commit hook for schema/migration sync
- [ ] Add a check to `.husky/pre-commit` that detects if `src/database/schema.ts` is in the staged files
- [ ] If staged, run `npx drizzle-kit check` — if it exits non-zero (drift detected), abort the commit with a message: "Schema changed but migrations are out of sync. Run `npm run db:generate` and stage the result."
- [ ] If `schema.ts` is not staged, skip the check entirely
- [ ] Verify: modify schema.ts, stage it without running db:generate, attempt commit → blocked. Then run db:generate, stage the migration, attempt commit → passes.

## Task 9: CI gate — drizzle-kit check in pipeline
- [ ] Add `drizzle-kit check` to the `npm run check` script (or as a separate `db:check` script called by CI)
- [ ] Update `.gitlab-ci.yml` to ensure the schema sync check runs before any deploy step
- [ ] Verify: push a commit with a modified schema.ts but no new migration → pipeline fails

## Task 10: Verify end-to-end — table creation in production
- [ ] Push the commit with all changes → CI deploys → triggers CodeBuild
- [ ] Check CloudWatch logs (`/aws/lambda/${service_name}`, stream prefix `migrate/`) for migration success output
- [ ] Verify the `arc_embeddings` table exists by running a query via the main Lambda (the existing `findMatch` / `upsertEmbedding` should now succeed instead of returning "relation does not exist")
- [ ] Verify RLS is active: confirm `SELECT * FROM arc_embeddings` without `SET LOCAL` returns zero rows even if data exists
- [ ] Confirm a second CodeBuild run is a no-op (logs show "no pending migrations")
