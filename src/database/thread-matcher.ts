// ---------------------------------------------------------------------------
// ThreadMatcher — single owner for all pgvector/Aurora operations.
// Implements both ThreadMatcherPort (processor reads) and MultiClusterAuroraWriter
// (processor + reindex writes). Uses Drizzle ORM for type-safe queries.
// ---------------------------------------------------------------------------

import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import { eq, and, sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getRegistryById, getPrimaryThreadMatcherRegistry, type ClusterRegistryEntry } from "../embedding/cluster-registry.js";
import { threadEmbeddings } from "./schema.js";
import { dynamo, SIGNALS_TABLE } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { ThreadMatcherPort } from "../processor/processor.js";
import type { Thread } from "../types/index.js";
import type { AwsDataApiPgDatabase } from "drizzle-orm/aws-data-api/pg";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Vector literal helper — RDS Data API cannot implicitly cast text → vector.
// All embedding values MUST go through this function. See static-analysis test.
// ---------------------------------------------------------------------------

/** Serialize number[] into a pg vector literal with explicit ::vector cast. */
// toVector:
export function toVector(embedding: number[]) {
  return sql`${`[${embedding.join(",")}]`}::vector`;
}

// ---------------------------------------------------------------------------
// Interface — re-exported so existing imports keep working
// ---------------------------------------------------------------------------

export interface MultiClusterAuroraWriter {
  upsertEmbedding(opts: {
    registryId: string;
    threadId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
    signalId: string;
  }): Promise<Result<void, DbError>>;

  findMatch(opts: {
    registryId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
  }): Promise<Result<{ threadId: string } | null, DbError>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.5;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

// Aurora auto-pause resume retry: exponential backoff up to 60s total
const RESUME_MAX_ATTEMPTS = 8;
const RESUME_BASE_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const threadPk = (accountId: string, id: string) => `ACCT#${accountId}#ARC#${id}`;
const ITEM_SK = "#";

// ---------------------------------------------------------------------------
// Drizzle error unwrapping — DrizzleQueryError wraps SDK errors, replacing
// .message with the SQL text. Classification must inspect .cause to reach
// the original SDK error's .name, .message, and .$metadata.
// ---------------------------------------------------------------------------

type ClassifiableError = { name?: string; message?: string; code?: string; $metadata?: { httpStatusCode?: number } };

function classifiableError(e: unknown): ClassifiableError {
  if (e instanceof DrizzleQueryError && e.cause) return e.cause as ClassifiableError;
  return e as ClassifiableError;
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

function isTransientError(e: unknown): boolean {
  const error = classifiableError(e);
  if (error == null || typeof error !== "object") return false;

  if (error.name === "StatementTimeoutException") return true;
  if (error.name === "ServiceUnavailableError") return true;
  if (error.name === "InternalServerErrorException") return true;
  if (error.code === "ThrottlingException") return true;
  if (error.name === "ThrottlingException") return true;

  const status = error.$metadata?.httpStatusCode;
  if (status != null && (status >= 500 || status === 429)) return true;

  if (error.name === "NetworkingError") return true;
  if (error.message?.includes("Connection reset")) return true;
  if (error.message?.includes("resuming after being auto-paused")) return true;

  return false;
}

function isAuroraResuming(e: unknown): boolean {
  const error = classifiableError(e);
  if (error == null || typeof error !== "object") return false;
  return error.message?.includes("resuming after being auto-paused") === true;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>, logger: Logger, operation: string): Promise<T> {
  let lastError: unknown;
  let maxAttempts = MAX_ATTEMPTS;
  let baseDelay = BASE_DELAY_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;

      if (isAuroraResuming(e) && maxAttempts === MAX_ATTEMPTS) {
        maxAttempts = RESUME_MAX_ATTEMPTS;
        baseDelay = RESUME_BASE_DELAY_MS;
        logger.info("Aurora cluster is resuming from auto-pause — switching to extended retry budget", { code: "aurora.resume_detected", operation, attempt });
      }

      if (!isTransientError(e)) {
        logger.error("Aurora query failed with non-transient error — no retry", { code: "aurora.non_transient", operation, attempt, error: e });
        throw e;
      }

      if (attempt === maxAttempts - 1) {
        logger.error("Aurora query failed after all retry attempts exhausted", { code: "aurora.retries_exhausted", operation, attempts: maxAttempts, error: e });
        throw e;
      }

      const delayMs = Math.min(baseDelay * Math.pow(2, attempt), 8000);
      logger.warn("Aurora query failed — retrying", { code: "aurora.retry", operation, attempt, maxAttempts, nextDelayMs: delayMs, error: e });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Per-cluster Drizzle db instance cache
// ---------------------------------------------------------------------------

const dbCache = new Map<string, AwsDataApiPgDatabase>();

function getDbForCluster(cluster: ClusterRegistryEntry): AwsDataApiPgDatabase {
  let db = dbCache.get(cluster.registryId);
  if (!db) {
    const client = new RDSDataClient({});
    db = drizzle(client, {
      database: cluster.databaseName,
      secretArn: cluster.secretArn,
      resourceArn: cluster.clusterArn,
    });
    dbCache.set(cluster.registryId, db);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ThreadMatcher implements ThreadMatcherPort, MultiClusterAuroraWriter {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // ThreadMatcherPort — processor reads (uses primary cluster, returns full Thread)
  // ---------------------------------------------------------------------------

  async findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Result<Thread | null, DbError>>;
  async findMatch(opts: { registryId: string; accountId: string; recipientAddress: string; embedding: number[] }): Promise<Result<{ threadId: string } | null, DbError>>;
  async findMatch(
    accountIdOrOpts: string | { registryId: string; accountId: string; recipientAddress: string; embedding: number[] },
    recipientAddress?: string,
    embedding?: number[],
  ): Promise<Result<Thread | null, DbError> | Result<{ threadId: string } | null, DbError>> {
    if (typeof accountIdOrOpts === "string") {
      return this.findMatchForThreadMatcher(accountIdOrOpts, recipientAddress!, embedding!);
    }
    return this.findMatchForCluster(accountIdOrOpts);
  }

  private async findMatchForThreadMatcher(accountId: string, recipientAddress: string, embedding: number[]): Promise<Result<Thread | null, DbError>> {
    const cluster = getPrimaryThreadMatcherRegistry();
    const db = getDbForCluster(cluster);

    try {
      const threadId = await withRetry(async () => {
        return db.transaction(async (tx) => {
          // SET LOCAL does not support parameterized values in PostgreSQL —
          // accountId is an internal value from DDB (not user input), safe to interpolate.
          await tx.execute(sql.raw(`SET LOCAL app.current_account_id = '${accountId.replace(/'/g, "''")}'`));

          const result = await tx
            .select({ threadId: threadEmbeddings.threadId })
            .from(threadEmbeddings)
            .where(and(
              eq(threadEmbeddings.accountId, accountId),
              eq(threadEmbeddings.recipientAddress, recipientAddress),
              sql`${threadEmbeddings.embedding} <=> ${toVector(embedding)} < ${SIMILARITY_THRESHOLD}`,
            ))
            .orderBy(sql`${threadEmbeddings.embedding} <=> ${toVector(embedding)}`)
            .limit(1);

          return result[0]?.threadId ?? null;
        });
      }, this.logger, "findMatch");

      if (!threadId) return ok(null);

      const threadResult = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: threadPk(accountId, threadId), sk: ITEM_SK },
      }));

      if (!threadResult.Item) {
        this.logger.track(`Aurora matched threadId but DDB thread is missing — orphaned embedding. Treating as no match. accountId=${accountId}, threadId=${threadId}`, { code: "thread_matcher.ghost_thread", threadId, accountId, recipientAddress, matchedData: { threadId, accountId, recipientAddress } });
        return ok(null);
      }

      return ok(threadResult.Item as Thread);
    } catch (e) {
      return err(dbError(e));
    }
  }

  private async findMatchForCluster(opts: {
    registryId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
  }): Promise<Result<{ threadId: string } | null, DbError>> {
    const cluster = getRegistryById(opts.registryId);
    if (!cluster) return err(dbError(`Cluster "${opts.registryId}" not found in CLUSTER_REGISTRY`));
    const db = getDbForCluster(cluster);

    try {
      const result = await withRetry(async () => {
        return db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL app.current_account_id = '${opts.accountId.replace(/'/g, "''")}'`));

          const rows = await tx
            .select({ threadId: threadEmbeddings.threadId })
            .from(threadEmbeddings)
            .where(and(
              eq(threadEmbeddings.accountId, opts.accountId),
              eq(threadEmbeddings.recipientAddress, opts.recipientAddress),
              sql`${threadEmbeddings.embedding} <=> ${toVector(opts.embedding)} < ${SIMILARITY_THRESHOLD}`,
            ))
            .orderBy(sql`${threadEmbeddings.embedding} <=> ${toVector(opts.embedding)}`)
            .limit(1);

          const threadId = rows[0]?.threadId;
          if (!threadId) return null;
          return { threadId };
        });
      }, this.logger, "findMatchForCluster");
      return ok(result);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Vector search — account-scoped cosine similarity returning top-N threadIds
  // ---------------------------------------------------------------------------

  async searchByVector(accountId: string, embedding: number[], limit: number): Promise<Result<string[], DbError>> {
    const cluster = getPrimaryThreadMatcherRegistry();
    const db = getDbForCluster(cluster);

    try {
      const rows = await withRetry(async () => {
        return db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL app.current_account_id = '${accountId.replace(/'/g, "''")}'`));

          // With multi-row embeddings (one per signal), DISTINCT ON deduplicates at DB level:
          // inner query picks closest embedding per thread, outer sorts by global distance.
          const result = await tx.execute(sql`
            SELECT thread_id FROM (
              SELECT DISTINCT ON (thread_id) thread_id, embedding <=> ${toVector(embedding)} AS dist
              FROM thread_embeddings
              WHERE account_id = ${accountId}
                AND embedding <=> ${toVector(embedding)} < ${SIMILARITY_THRESHOLD}
              ORDER BY thread_id, embedding <=> ${toVector(embedding)}
            ) sub
            ORDER BY dist
            LIMIT ${limit}
          `);
          return result.rows as Array<{ thread_id: string }>;
        });
      }, this.logger, "searchByVector");

      return ok(rows.map(r => r.thread_id));
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Embedding existence check — used by healthcheck validation
  // ---------------------------------------------------------------------------

  async hasEmbedding(threadId: string): Promise<Result<boolean, DbError>> {
    const cluster = getPrimaryThreadMatcherRegistry();
    const db = getDbForCluster(cluster);

    try {
      const rows = await withRetry(async () => {
        return db
          .select({ threadId: threadEmbeddings.threadId })
          .from(threadEmbeddings)
          .where(eq(threadEmbeddings.threadId, threadId))
          .limit(1);
      }, this.logger, "hasEmbedding");
      return ok(rows.length > 0);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // MultiClusterAuroraWriter — upserts
  // ---------------------------------------------------------------------------

  async upsertEmbedding(threadId: string, embedding: number[], accountId: string, recipientAddress: string, signalId: string): Promise<Result<void, DbError>>;
  async upsertEmbedding(opts: { registryId: string; threadId: string; accountId: string; recipientAddress: string; embedding: number[]; signalId: string }): Promise<Result<void, DbError>>;
  async upsertEmbedding(
    threadIdOrOpts: string | { registryId: string; threadId: string; accountId: string; recipientAddress: string; embedding: number[]; signalId: string },
    embedding?: number[],
    accountId?: string,
    recipientAddress?: string,
    signalId?: string,
  ): Promise<Result<void, DbError>> {
    if (typeof threadIdOrOpts === "string") {
      const cluster = getPrimaryThreadMatcherRegistry();
      return this.upsertToCluster({
        registryId: cluster.registryId,
        threadId: threadIdOrOpts,
        accountId: accountId!,
        recipientAddress: recipientAddress!,
        embedding: embedding!,
        signalId: signalId!,
      });
    }
    return this.upsertToCluster(threadIdOrOpts);
  }

  private async upsertToCluster(opts: {
    registryId: string;
    threadId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
    signalId: string;
  }): Promise<Result<void, DbError>> {
    const cluster = getRegistryById(opts.registryId);
    if (!cluster) return err(dbError(`Cluster "${opts.registryId}" not found in CLUSTER_REGISTRY`));
    const db = getDbForCluster(cluster);

    try {
      await withRetry(async () => {
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL app.current_account_id = '${opts.accountId.replace(/'/g, "''")}'`));

          await tx
            .insert(threadEmbeddings)
            .values({
              signalId: opts.signalId,
              threadId: opts.threadId,
              accountId: opts.accountId,
              recipientAddress: opts.recipientAddress,
              embedding: toVector(opts.embedding),
              updatedAt: sql`now()`,
            });
        });
      }, this.logger, "upsertEmbedding");
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}

// ---------------------------------------------------------------------------
// Factory export — handler provides the logger
// ---------------------------------------------------------------------------

export function createSearchDatabase(logger: Logger): ThreadMatcher {
  return new ThreadMatcher(logger);
}
