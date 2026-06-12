// ---------------------------------------------------------------------------
// ArcMatcher — single owner for all pgvector/Aurora operations.
// Implements both ArcMatcherPort (processor reads) and MultiClusterAuroraWriter
// (processor + reindex writes). One class, one withAccountContext, one truth.
// ---------------------------------------------------------------------------

import {
  RDSDataClient,
  BeginTransactionCommand,
  ExecuteStatementCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getRegistryById, getPrimaryArcMatcherRegistry, type ClusterRegistryEntry } from "../embedding/cluster-registry.js";
import { dynamo, SIGNALS_TABLE } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { ArcMatcherPort } from "../processor/processor.js";
import type { Arc } from "../types/index.js";

// ---------------------------------------------------------------------------
// Interface — re-exported so existing imports keep working
// ---------------------------------------------------------------------------

export interface MultiClusterAuroraWriter {
  upsertEmbedding(opts: {
    registryId: string;
    arcId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
  }): Promise<Result<void, DbError>>;

  findMatch(opts: {
    registryId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
  }): Promise<Result<{ arcId: string } | null, DbError>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.5;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

// Aurora auto-pause resume retry: exponential backoff up to 60s total
const RESUME_MAX_ATTEMPTS = 8;
const RESUME_BASE_DELAY_MS = 2000; // 2s, 4s, 8s, 8s, 8s, 8s, 8s, 8s = ~54s total

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
  const err = e as { name?: string; message?: string; code?: string; $metadata?: { httpStatusCode?: number } };

  if (err.name === "StatementTimeoutException") return true;
  if (err.name === "ServiceUnavailableError") return true;
  if (err.name === "InternalServerErrorException") return true;
  if (err.code === "ThrottlingException") return true;
  if (err.name === "ThrottlingException") return true;

  const status = err.$metadata?.httpStatusCode;
  if (status != null && (status >= 500 || status === 429)) return true;

  if (err.name === "NetworkingError") return true;
  if (err.message?.includes("Connection reset")) return true;
  if (err.message?.includes("resuming after being auto-paused")) return true;

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
// Per-cluster client cache
// ---------------------------------------------------------------------------

const clientCache = new Map<string, RDSDataClient>();

function getClientForCluster(registryId: string): RDSDataClient {
  let client = clientCache.get(registryId);
  if (!client) {
    client = new RDSDataClient({});
    clientCache.set(registryId, client);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ArcMatcher implements ArcMatcherPort, MultiClusterAuroraWriter {

  // ---------------------------------------------------------------------------
  // ArcMatcher — processor reads (uses primary cluster, returns full Arc)
  // ---------------------------------------------------------------------------

  async findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Result<Arc | null, DbError>>;
  async findMatch(opts: { registryId: string; accountId: string; recipientAddress: string; embedding: number[] }): Promise<Result<{ arcId: string } | null, DbError>>;
  async findMatch(
    accountIdOrOpts: string | { registryId: string; accountId: string; recipientAddress: string; embedding: number[] },
    recipientAddress?: string,
    embedding?: number[],
  ): Promise<Result<Arc | null, DbError> | Result<{ arcId: string } | null, DbError>> {
    // Dispatch based on call signature
    if (typeof accountIdOrOpts === "string") {
      return this.findMatchForArcMatcher(accountIdOrOpts, recipientAddress!, embedding!);
    }
    return this.findMatchForCluster(accountIdOrOpts);
  }

  private async findMatchForArcMatcher(accountId: string, recipientAddress: string, embedding: number[]): Promise<Result<Arc | null, DbError>> {
    const cluster = getPrimaryArcMatcherRegistry();
    const client = getClientForCluster(cluster.registryId);

    try {
      const arcId = await withRetry(async () => {
        return this.withAccountContext(client, cluster, accountId, async (transactionId) => {
          const res = await client.send(new ExecuteStatementCommand({
            resourceArn: cluster.clusterArn,
            secretArn: cluster.secretArn,
            database: cluster.databaseName,
            transactionId,
            sql: `SELECT arc_id FROM arc_embeddings
                  WHERE account_id = :accountId AND recipient_address = :recipient
                    AND embedding <=> :embedding::vector < :threshold
                  ORDER BY embedding <=> :embedding::vector
                  LIMIT 1`,
            parameters: [
              { name: "accountId", value: { stringValue: accountId } },
              { name: "recipient", value: { stringValue: recipientAddress } },
              { name: "embedding", value: { stringValue: `[${embedding.join(",")}]` } },
              { name: "threshold", value: { doubleValue: SIMILARITY_THRESHOLD } },
            ],
          }));
          return res.records?.[0]?.[0]?.stringValue ?? null;
        });
      });

      if (!arcId) return ok(null);

      const arcResult = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: arcPk(accountId, arcId), sk: ITEM_SK },
      }));
      return ok(arcResult.Item ? (arcResult.Item as Arc) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  private async findMatchForCluster(opts: {
    registryId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
  }): Promise<Result<{ arcId: string } | null, DbError>> {
    const cluster = getRegistryById(opts.registryId);
    if (!cluster) return err(dbError(`Cluster "${opts.registryId}" not found in CLUSTER_REGISTRY`));
    const client = getClientForCluster(opts.registryId);

    try {
      const result = await withRetry(async () => {
        const res = await this.withAccountContext(client, cluster, opts.accountId, async (transactionId) => {
          return client.send(new ExecuteStatementCommand({
            resourceArn: cluster.clusterArn,
            secretArn: cluster.secretArn,
            database: cluster.databaseName,
            transactionId,
            sql: `SELECT arc_id FROM arc_embeddings
                  WHERE account_id = :accountId AND recipient_address = :recipient
                    AND embedding <=> :embedding::vector < :threshold
                  ORDER BY embedding <=> :embedding::vector
                  LIMIT 1`,
            parameters: [
              { name: "accountId", value: { stringValue: opts.accountId } },
              { name: "recipient", value: { stringValue: opts.recipientAddress } },
              { name: "embedding", value: { stringValue: `[${opts.embedding.join(",")}]` } },
              { name: "threshold", value: { doubleValue: SIMILARITY_THRESHOLD } },
            ],
          }));
        });

        const arcId = res.records?.[0]?.[0]?.stringValue;
        if (!arcId) return null;
        return { arcId };
      });
      return ok(result);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // ArcMatcher.upsertEmbedding — processor legacy interface (flat args, primary cluster)
  // ---------------------------------------------------------------------------

  async upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): Promise<Result<void, DbError>>;
  async upsertEmbedding(opts: { registryId: string; arcId: string; accountId: string; recipientAddress: string; embedding: number[] }): Promise<Result<void, DbError>>;
  async upsertEmbedding(
    arcIdOrOpts: string | { registryId: string; arcId: string; accountId: string; recipientAddress: string; embedding: number[] },
    embedding?: number[],
    accountId?: string,
    recipientAddress?: string,
  ): Promise<Result<void, DbError>> {
    if (typeof arcIdOrOpts === "string") {
      const cluster = getPrimaryArcMatcherRegistry();
      return this.upsertToCluster({
        registryId: cluster.registryId,
        arcId: arcIdOrOpts,
        accountId: accountId!,
        recipientAddress: recipientAddress!,
        embedding: embedding!,
      });
    }
    return this.upsertToCluster(arcIdOrOpts);
  }

  private async upsertToCluster(opts: {
    registryId: string;
    arcId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
  }): Promise<Result<void, DbError>> {
    const cluster = getRegistryById(opts.registryId);
    if (!cluster) return err(dbError(`Cluster "${opts.registryId}" not found in CLUSTER_REGISTRY`));
    const client = getClientForCluster(opts.registryId);

    try {
      await withRetry(async () => {
        await this.withAccountContext(client, cluster, opts.accountId, async (transactionId) => {
          await client.send(new ExecuteStatementCommand({
            resourceArn: cluster.clusterArn,
            secretArn: cluster.secretArn,
            database: cluster.databaseName,
            transactionId,
            sql: `INSERT INTO arc_embeddings (arc_id, account_id, recipient_address, embedding, updated_at)
                  VALUES (:arcId, :accountId, :recipient, :embedding::vector, NOW())
                  ON CONFLICT (arc_id, account_id, recipient_address) DO UPDATE
                    SET embedding = EXCLUDED.embedding, updated_at = NOW()`,
            parameters: [
              { name: "arcId", value: { stringValue: opts.arcId } },
              { name: "accountId", value: { stringValue: opts.accountId } },
              { name: "recipient", value: { stringValue: opts.recipientAddress } },
              { name: "embedding", value: { stringValue: `[${opts.embedding.join(",")}]` } },
            ],
          }));
        });
      });
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Transaction helper — BEGIN → SET LOCAL → fn → COMMIT (rollback on error)
  // ---------------------------------------------------------------------------

  private async withAccountContext<T>(
    client: RDSDataClient,
    cluster: ClusterRegistryEntry,
    accountId: string,
    fn: (transactionId: string) => Promise<T>,
  ): Promise<T> {
    const { transactionId } = await client.send(new BeginTransactionCommand({
      resourceArn: cluster.clusterArn,
      secretArn: cluster.secretArn,
      database: cluster.databaseName,
    }));

    try {
      await client.send(new ExecuteStatementCommand({
        resourceArn: cluster.clusterArn,
        secretArn: cluster.secretArn,
        database: cluster.databaseName,
        transactionId,
        // SET LOCAL does not support parameterized values in PostgreSQL —
        // accountId is an internal value from DDB (not user input), safe to interpolate.
        sql: `SET LOCAL app.current_account_id = '${accountId.replace(/'/g, "''")}'`,
      }));

      const result = await fn(transactionId!);

      await client.send(new CommitTransactionCommand({
        resourceArn: cluster.clusterArn,
        secretArn: cluster.secretArn,
        transactionId,
      }));

      return result;
    } catch (e) {
      try {
        await client.send(new RollbackTransactionCommand({
          resourceArn: cluster.clusterArn,
          secretArn: cluster.secretArn,
          transactionId,
        }));
      } catch {
        // Rollback best-effort — the original error is more important
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const searchDatabase = new ArcMatcher();
