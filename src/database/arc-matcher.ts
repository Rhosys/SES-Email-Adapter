// ---------------------------------------------------------------------------
// ArcMatcher — single owner for all pgvector/Aurora operations.
// Implements both ArcMatcherPort (processor reads) and MultiClusterAuroraWriter
// (processor + reindex writes). Uses Drizzle ORM for type-safe queries.
// ---------------------------------------------------------------------------

import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import { eq, and, sql } from "drizzle-orm";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getRegistryById, getPrimaryArcMatcherRegistry, type ClusterRegistryEntry } from "../embedding/cluster-registry.js";
import { arcEmbeddings } from "./schema.js";
import { dynamo, SIGNALS_TABLE } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { ArcMatcherPort } from "../processor/processor.js";
import type { Arc } from "../types/index.js";
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

const arcPk = (accountId: string, id: string) => `ACCT#${accountId}#ARC#${id}`;
const ITEM_SK = "#";

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

function isTransientError(e: unknown): boolean {
  if (e == null || typeof e !== "object") return false;
  const error = e as { name?: string; message?: string; code?: string; $metadata?: { httpStatusCode?: number } };

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
  if (e == null || typeof e !== "object") return false;
  return (e as { message?: string }).message?.includes("resuming after being auto-paused") === true;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
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
      }

      if (!isTransientError(e) || attempt === maxAttempts - 1) {
        throw e;
      }
      const delayMs = Math.min(baseDelay * Math.pow(2, attempt), 8000);
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

export class ArcMatcher implements ArcMatcherPort, MultiClusterAuroraWriter {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // ArcMatcherPort — processor reads (uses primary cluster, returns full Arc)
  // ---------------------------------------------------------------------------

  async findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Result<Arc | null, DbError>>;
  async findMatch(opts: { registryId: string; accountId: string; recipientAddress: string; embedding: number[] }): Promise<Result<{ threadId: string } | null, DbError>>;
  async findMatch(
    accountIdOrOpts: string | { registryId: string; accountId: string; recipientAddress: string; embedding: number[] },
    recipientAddress?: string,
    embedding?: number[],
  ): Promise<Result<Arc | null, DbError> | Result<{ threadId: string } | null, DbError>> {
    if (typeof accountIdOrOpts === "string") {
      return this.findMatchForArcMatcher(accountIdOrOpts, recipientAddress!, embedding!);
    }
    return this.findMatchForCluster(accountIdOrOpts);
  }

  private async findMatchForArcMatcher(accountId: string, recipientAddress: string, embedding: number[]): Promise<Result<Arc | null, DbError>> {
    const cluster = getPrimaryArcMatcherRegistry();
    const db = getDbForCluster(cluster);

    try {
      const arcId = await withRetry(async () => {
        return db.transaction(async (tx) => {
          // SET LOCAL does not support parameterized values in PostgreSQL —
          // accountId is an internal value from DDB (not user input), safe to interpolate.
          await tx.execute(sql.raw(`SET LOCAL app.current_account_id = '${accountId.replace(/'/g, "''")}'`));

          const result = await tx
            .select({ arcId: arcEmbeddings.arcId })
            .from(arcEmbeddings)
            .where(and(
              eq(arcEmbeddings.accountId, accountId),
              eq(arcEmbeddings.recipientAddress, recipientAddress),
              sql`${arcEmbeddings.embedding} <=> ${toVector(embedding)} < ${SIMILARITY_THRESHOLD}`,
            ))
            .orderBy(sql`${arcEmbeddings.embedding} <=> ${toVector(embedding)}`)
            .limit(1);

          return result[0]?.arcId ?? null;
        });
      });

      if (!arcId) return ok(null);

      const arcResult = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: arcPk(accountId, arcId), sk: ITEM_SK },
      }));

      if (!arcResult.Item) {
        this.logger.track("Aurora matched threadId but DDB thread is missing — orphaned embedding. Treating as no match.", { code: "thread_matcher.ghost_thread", arcId, accountId, recipientAddress });
        return ok(null);
      }

      return ok(arcResult.Item as Arc);
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
            .select({ arcId: arcEmbeddings.arcId })
            .from(arcEmbeddings)
            .where(and(
              eq(arcEmbeddings.accountId, opts.accountId),
              eq(arcEmbeddings.recipientAddress, opts.recipientAddress),
              sql`${arcEmbeddings.embedding} <=> ${toVector(opts.embedding)} < ${SIMILARITY_THRESHOLD}`,
            ))
            .orderBy(sql`${arcEmbeddings.embedding} <=> ${toVector(opts.embedding)}`)
            .limit(1);

          const arcId = rows[0]?.arcId;
          if (!arcId) return null;
          return { threadId: arcId };
        });
      });
      return ok(result);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // MultiClusterAuroraWriter — upserts
  // ---------------------------------------------------------------------------

  async upsertEmbedding(threadId: string, embedding: number[], accountId: string, recipientAddress: string): Promise<Result<void, DbError>>;
  async upsertEmbedding(opts: { registryId: string; threadId: string; accountId: string; recipientAddress: string; embedding: number[] }): Promise<Result<void, DbError>>;
  async upsertEmbedding(
    threadIdOrOpts: string | { registryId: string; threadId: string; accountId: string; recipientAddress: string; embedding: number[] },
    embedding?: number[],
    accountId?: string,
    recipientAddress?: string,
  ): Promise<Result<void, DbError>> {
    if (typeof threadIdOrOpts === "string") {
      const cluster = getPrimaryArcMatcherRegistry();
      return this.upsertToCluster({
        registryId: cluster.registryId,
        threadId: threadIdOrOpts,
        accountId: accountId!,
        recipientAddress: recipientAddress!,
        embedding: embedding!,
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
  }): Promise<Result<void, DbError>> {
    const cluster = getRegistryById(opts.registryId);
    if (!cluster) return err(dbError(`Cluster "${opts.registryId}" not found in CLUSTER_REGISTRY`));
    const db = getDbForCluster(cluster);

    try {
      await withRetry(async () => {
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL app.current_account_id = '${opts.accountId.replace(/'/g, "''")}'`));

          await tx
            .insert(arcEmbeddings)
            .values({
              arcId: opts.threadId,
              accountId: opts.accountId,
              recipientAddress: opts.recipientAddress,
              embedding: toVector(opts.embedding),
              updatedAt: sql`now()`,
            })
            .onConflictDoUpdate({
              target: [arcEmbeddings.arcId, arcEmbeddings.accountId, arcEmbeddings.recipientAddress],
              set: {
                embedding: sql`EXCLUDED.embedding`,
                updatedAt: sql`now()`,
              },
            });
        });
      });
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}

// ---------------------------------------------------------------------------
// Factory export — handler provides the logger
// ---------------------------------------------------------------------------

export function createSearchDatabase(logger: Logger): ArcMatcher {
  return new ArcMatcher(logger);
}
