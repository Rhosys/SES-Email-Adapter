import { randomUUID } from "crypto";
import { Pool } from "pg";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, SIGNALS_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import type { ArcMatcher } from "../processor/processor.js";
import type { ListArcsParams, UpdateArcRequest, CreateViewRequest, UpdateViewRequest } from "../api/app.js";
import type { Arc, Signal, Page, PageParams } from "../types/index.js";

// ---------------------------------------------------------------------------
// pgvector pool (module-scoped, lazy, reused across warm Lambda invocations)
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.5;
let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({
    host: process.env["RDS_PROXY_ENDPOINT"],
    database: process.env["AURORA_DB_NAME"] ?? "signals",
    user: process.env["DB_USER"] ?? "lambda",
    password: process.env["DB_PASSWORD"],
    port: 5432,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  _pool.on("error", (err) => {
    console.error("pgvector pool error:", err);
    _pool = null;
  });
  return _pool;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const acctPk = (accountId: string) => `ACCT#${accountId}`;
const arcSk = (id: string) => `ARC#${id}`;
const sigSk = (id: string) => `SIG#${id}`;
const gkeyPk = (accountId: string, key: string) => `GKEY#${accountId}#${key}`;

// ---------------------------------------------------------------------------
// ArcDatabase
// Owns: Arcs and Signals in SIGNALS_TABLE, plus pgvector similarity search
// ---------------------------------------------------------------------------

export class ArcDatabase implements ArcMatcher {
  // ---------------------------------------------------------------------------
  // Signals
  // ---------------------------------------------------------------------------

  async getSignalByMessageId(accountId: string, sesMessageId: string): Promise<Pick<Signal, "id"> | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: acctPk(accountId), sk: sigSk(`SES#${sesMessageId}`) },
      ProjectionExpression: "id",
    }));
    return result.Item ? (result.Item as Pick<Signal, "id">) : null;
  }

  async saveSignal(signal: Signal): Promise<void> {
    const gsi1pk = signal.arcId ? `ARCSIG#${signal.arcId}` : `BLOCKED#${signal.accountId}`;
    const gsi1sk = `RECV#${signal.receivedAt}#${signal.id}`;
    await dynamo.send(new PutCommand({
      TableName: SIGNALS_TABLE,
      Item: {
        ...signal,
        pk: acctPk(signal.accountId),
        sk: sigSk(signal.id),
        gsi1pk,
        gsi1sk,
      },
    }));
  }

  async getSignal(accountId: string, id: string): Promise<Signal | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: acctPk(accountId), sk: sigSk(id) },
    }));
    return result.Item ? (result.Item as Signal) : null;
  }

  async listSignals(accountId: string, arcId: string, params: PageParams): Promise<Page<Signal>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const res = await dynamo.send(new QueryCommand({
      TableName: SIGNALS_TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": `ARCSIG#${arcId}` },
      ScanIndexForward: false,
      Limit: limit + 1,
      ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
    }));

    const items = (res.Items ?? []) as Signal[];
    const page = items.slice(0, limit);
    const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
    return { items: page, total: items.length, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  async unblockSignal(accountId: string, signalId: string, arcId: string): Promise<void> {
    await dynamo.send(new UpdateCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: acctPk(accountId), sk: sigSk(signalId) },
      UpdateExpression: "SET arcId = :arcId, #status = :status, gsi1pk = :gsi1pk",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":arcId": arcId,
        ":status": "active",
        ":gsi1pk": `ARCSIG#${arcId}`,
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Arcs
  // ---------------------------------------------------------------------------

  async getArc(accountId: string, id: string): Promise<Arc | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: acctPk(accountId), sk: arcSk(id) },
    }));
    return result.Item ? (result.Item as Arc) : null;
  }

  async findArcByGroupingKey(accountId: string, key: string): Promise<Arc | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: gkeyPk(accountId, key), sk: "GKEY" },
      ProjectionExpression: "arcId",
    }));
    if (!result.Item) return null;
    const arcId = result.Item["arcId"] as string | undefined;
    if (!arcId) return null;
    return this.getArc(accountId, arcId);
  }

  async saveArc(arc: Arc): Promise<void> {
    const writes: Promise<unknown>[] = [
      dynamo.send(new PutCommand({
        TableName: SIGNALS_TABLE,
        Item: {
          ...arc,
          pk: acctPk(arc.accountId),
          sk: arcSk(arc.id),
          gsi1pk: acctPk(arc.accountId),
          gsi1sk: `LASTACT#${arc.lastSignalAt}#${arc.id}`,
        },
      })),
    ];

    if (arc.groupingKey) {
      writes.push(dynamo.send(new PutCommand({
        TableName: SIGNALS_TABLE,
        Item: { pk: gkeyPk(arc.accountId, arc.groupingKey), sk: "GKEY", arcId: arc.id },
      })));
    }

    await Promise.all(writes);
  }

  async createArc(arc: Arc): Promise<void> {
    return this.saveArc(arc);
  }

  async updateArc(accountId: string, id: string, update: UpdateArcRequest): Promise<void> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.status !== undefined) {
      setParts.push("#status = :status");
      exprValues[":status"] = update.status;
      exprNames["#status"] = "status";
      if (update.status === "deleted") setParts.push("deletedAt = :now");
    }
    if (update.labels !== undefined) {
      setParts.push("labels = :labels");
      exprValues[":labels"] = update.labels;
    }

    await dynamo.send(new UpdateCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: acctPk(accountId), sk: arcSk(id) },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
  }

  async listArcs(accountId: string, params: ListArcsParams): Promise<Page<Arc>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const res = await dynamo.send(new QueryCommand({
      TableName: SIGNALS_TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
      ExpressionAttributeValues: { ":pk": acctPk(accountId), ":prefix": "LASTACT#" },
      ScanIndexForward: false,
      Limit: 200,
      ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
    }));

    let items = (res.Items ?? []) as Arc[];
    if (params.workflow) items = items.filter((a) => a.workflow === params.workflow);
    if (params.status) items = items.filter((a) => a.status === params.status);
    if (params.label) items = items.filter((a) => a.labels.includes(params.label!));

    const page = items.slice(0, limit);
    const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
    return { items: page, total: items.length, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  async searchArcs(accountId: string, query: string, params: PageParams): Promise<Page<Arc>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const res = await dynamo.send(new QueryCommand({
      TableName: SIGNALS_TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
      ExpressionAttributeValues: { ":pk": acctPk(accountId), ":prefix": "LASTACT#" },
      ScanIndexForward: false,
      Limit: 500,
      ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
    }));

    const q = query.toLowerCase();
    const items = ((res.Items ?? []) as Arc[]).filter(
      (a) => a.summary.toLowerCase().includes(q) || a.workflow.toLowerCase().includes(q),
    );
    const page = items.slice(0, limit);
    const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
    return { items: page, total: items.length, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  // ---------------------------------------------------------------------------
  // ArcMatcher (pgvector — internal implementation detail)
  // ---------------------------------------------------------------------------

  async findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Arc | null> {
    const pool = getPool();
    const vectorLiteral = `[${embedding.join(",")}]`;

    const res = await pool.query<{ arc_id: string }>(
      `SELECT arc_id
       FROM arc_embeddings
       WHERE account_id = $1 AND recipient_address = $2
         AND embedding <=> $3::vector < $4
       ORDER BY embedding <=> $3::vector
       LIMIT 1`,
      [accountId, recipientAddress, vectorLiteral, SIMILARITY_THRESHOLD],
    );

    if (!res.rows[0]) return null;
    return this.getArc(accountId, res.rows[0].arc_id);
  }

  async upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): Promise<void> {
    const pool = getPool();
    const vectorLiteral = `[${embedding.join(",")}]`;

    await pool.query(
      `INSERT INTO arc_embeddings (arc_id, account_id, recipient_address, embedding, updated_at)
       VALUES ($1, $2, $3, $4::vector, NOW())
       ON CONFLICT (arc_id) DO UPDATE
         SET embedding = EXCLUDED.embedding,
             updated_at = NOW()`,
      [arcId, accountId, recipientAddress, vectorLiteral],
    );
  }
}
