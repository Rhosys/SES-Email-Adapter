// ---------------------------------------------------------------------------
// Multi-Cluster Aurora Writer
// Per-cluster RDSDataClient cache with transactional RLS-scoped upserts.
// ---------------------------------------------------------------------------

import {
  RDSDataClient,
  BeginTransactionCommand,
  ExecuteStatementCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { getRegistryById, type ClusterRegistryEntry } from "../embedding/cluster-registry.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";

// ---------------------------------------------------------------------------
// Interface
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
// Transient error detection
// ---------------------------------------------------------------------------

function isTransientError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string; code?: string; $metadata?: { httpStatusCode?: number } };

  // RDS Data API transient error codes
  if (e.name === "StatementTimeoutException") return true;
  if (e.name === "ServiceUnavailableError") return true;
  if (e.name === "InternalServerErrorException") return true;
  if (e.code === "ThrottlingException") return true;
  if (e.name === "ThrottlingException") return true;

  // HTTP 5xx or 429
  const status = e.$metadata?.httpStatusCode;
  if (status != null && (status >= 500 || status === 429)) return true;

  // Connection/network errors
  if (e.name === "NetworkingError") return true;
  if (e.message?.includes("Connection reset")) return true;

  // Aurora Serverless auto-pause resuming
  if (e.message?.includes("resuming after being auto-paused")) return true;

  return false;
}

/** Aurora resuming from auto-pause can take 25–45s. Detect this specific case. */
function isAuroraResuming(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { message?: string };
  return e.message?.includes("resuming after being auto-paused") === true;
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
    } catch (err) {
      lastError = err;

      // On first encounter of auto-pause resume, switch to longer retry budget
      if (isAuroraResuming(err) && maxAttempts === MAX_ATTEMPTS) {
        maxAttempts = RESUME_MAX_ATTEMPTS;
        baseDelay = RESUME_BASE_DELAY_MS;
      }

      if (!isTransientError(err) || attempt === maxAttempts - 1) {
        throw err;
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

function getClientForCluster(_registryId: string): RDSDataClient {
  let client = clientCache.get(_registryId);
  if (!client) {
    client = new RDSDataClient({});
    clientCache.set(_registryId, client);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class MultiClusterAuroraWriterImpl implements MultiClusterAuroraWriter {
  async upsertEmbedding(opts: {
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

  async findMatch(opts: {
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
    } catch (err) {
      try {
        await client.send(new RollbackTransactionCommand({
          resourceArn: cluster.clusterArn,
          secretArn: cluster.secretArn,
          transactionId,
        }));
      } catch {
        // Rollback best-effort — the original error is more important
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export (matches existing ArcDatabase pattern)
// ---------------------------------------------------------------------------

export const multiClusterWriter = new MultiClusterAuroraWriterImpl();
