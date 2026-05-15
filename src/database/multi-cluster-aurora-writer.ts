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
import { CLUSTER_REGISTRY, getRegistryById, type ClusterRegistryEntry } from "../embedding/cluster-registry.js";

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
  }): Promise<void>;

  findMatch(opts: {
    registryId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
  }): Promise<{ arcId: string } | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.5;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

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

  return false;
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s
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
  }): Promise<void> {
    const cluster = resolveCluster(opts.registryId);
    const client = getClientForCluster(opts.registryId);

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
  }

  async findMatch(opts: {
    registryId: string;
    accountId: string;
    recipientAddress: string;
    embedding: number[];
  }): Promise<{ arcId: string } | null> {
    const cluster = resolveCluster(opts.registryId);
    const client = getClientForCluster(opts.registryId);

    return withRetry(async () => {
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
        sql: "SET LOCAL app.current_account_id = :accountId",
        parameters: [{ name: "accountId", value: { stringValue: accountId } }],
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
// Cluster resolution helper
// ---------------------------------------------------------------------------

function resolveCluster(registryId: string): ClusterRegistryEntry {
  const entry = getRegistryById(registryId);
  if (!entry) {
    throw new Error(`Cluster "${registryId}" not found in CLUSTER_REGISTRY`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Singleton export (matches existing ArcDatabase pattern)
// ---------------------------------------------------------------------------

export const multiClusterWriter = new MultiClusterAuroraWriterImpl();
