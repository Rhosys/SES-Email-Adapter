import { randomUUID } from "crypto";
import { Pool } from "pg";
import { Signer } from "@aws-sdk/rds-signer";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, SIGNALS_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import type { ArcMatcher } from "../processor/processor.js";
import type { ListArcsParams, UpdateArcRequest, CreateViewRequest, UpdateViewRequest } from "../api/app.js";
import type { Arc, Signal, Page, PageParams } from "../types/index.js";

// ---------------------------------------------------------------------------
// pgvector pool (module-scoped, lazy, reused across warm Lambda invocations)
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.5;
const RDS_HOST = process.env["RDS_PROXY_ENDPOINT"] ?? "";
const DB_USER  = process.env["DB_USER"] ?? "lambda";
const DB_NAME  = process.env["AURORA_DB_NAME"] ?? "signals";
const AWS_REGION = process.env["AWS_REGION"] ?? "eu-west-1";

const signer = new Signer({ hostname: RDS_HOST, port: 5432, region: AWS_REGION, username: DB_USER });

let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({
    host:     RDS_HOST,
    database: DB_NAME,
    user:     DB_USER,
    password: () => signer.getAuthToken(),
    port: 5432,
    ssl: { rejectUnauthorized: true },
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

const arcPk  = (accountId: string, id: string) => `ACCT#${accountId}#ARC#${id}`;
const sigPk  = (accountId: string, id: string) => `ACCT#${accountId}#SIG#${id}`;
const ITEM_SK = "#";
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
      Key: { pk: sigPk(accountId, `SES#${sesMessageId}`), sk: ITEM_SK },
      ProjectionExpression: "id",
    }));
    return result.Item ? (result.Item as Pick<Signal, "id">) : null;
  }

  async saveSignal(signal: Signal): Promise<void> {
    let gsi1pk: string;
    if (signal.arcId) {
      gsi1pk = `ARCSIG#${signal.arcId}`;
    } else if (signal.status === "quarantined") {
      gsi1pk = `QUARANTINED#${signal.accountId}`;
    } else {
      gsi1pk = `BLOCKED#${signal.accountId}`;
    }
    const gsi1sk = `RECV#${signal.receivedAt}#${signal.id}`;
    await dynamo.send(new PutCommand({
      TableName: SIGNALS_TABLE,
      Item: {
        ...signal,
        pk: sigPk(signal.accountId, signal.id),
        sk: ITEM_SK,
        gsi1pk,
        gsi1sk,
      },
    }));
  }

  async getSignal(accountId: string, id: string): Promise<Signal | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: sigPk(accountId, id), sk: ITEM_SK },
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
    return { items: page, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  async listPreArcSignals(accountId: string, status: "blocked" | "quarantined", params: PageParams): Promise<Page<Signal>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const gsi1pk = status === "quarantined" ? `QUARANTINED#${accountId}` : `BLOCKED#${accountId}`;
    const res = await dynamo.send(new QueryCommand({
      TableName: SIGNALS_TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": gsi1pk },
      ScanIndexForward: false,
      Limit: limit + 1,
      ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
    }));
    const items = (res.Items ?? []) as Signal[];
    const page = items.slice(0, limit);
    const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
    return { items: page, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  async blockSignal(accountId: string, signalId: string): Promise<Signal> {
    await dynamo.send(new UpdateCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
      UpdateExpression: "SET #status = :status, gsi1pk = :gsi1pk",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "blocked",
        ":gsi1pk": `BLOCKED#${accountId}`,
      },
    }));
    return (await this.getSignal(accountId, signalId))!;
  }

  async unblockSignal(accountId: string, signalId: string, arcId: string): Promise<void> {
    await dynamo.send(new UpdateCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
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
      Key: { pk: arcPk(accountId, id), sk: ITEM_SK },
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
          pk: arcPk(arc.accountId, arc.id),
          sk: ITEM_SK,
          gsi1pk: `ACCT#${arc.accountId}`,
          gsi1sk: `LASTACT#${arc.status}#${arc.lastSignalAt}#${arc.id}`,
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

  async updateArc(accountId: string, id: string, update: UpdateArcRequest): Promise<Arc> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.status !== undefined) {
      setParts.push("#status = :status");
      exprValues[":status"] = update.status;
      exprNames["#status"] = "status";
      if (update.status === "deleted") setParts.push("deletedAt = :now");
      // Fetch current arc to reconstruct gsi1sk with new status
      const current = await this.getArc(accountId, id);
      if (current) {
        setParts.push("gsi1sk = :gsi1sk");
        exprValues[":gsi1sk"] = `LASTACT#${update.status}#${current.lastSignalAt}#${id}`;
      }
    }
    if (update.labels !== undefined) {
      setParts.push("labels = :labels");
      exprValues[":labels"] = update.labels;
    }
    if (update.urgency !== undefined) {
      setParts.push("urgency = :urgency");
      exprValues[":urgency"] = update.urgency;
    }

    await dynamo.send(new UpdateCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: arcPk(accountId, id), sk: ITEM_SK },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
    return (await this.getArc(accountId, id))!;
  }

  async updateSignal(accountId: string, id: string, update: Partial<Pick<Signal, "subject" | "textBody" | "from" | "to">>): Promise<Signal> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.subject !== undefined) { setParts.push("#subject = :subject"); exprValues[":subject"] = update.subject; exprNames["#subject"] = "subject"; }
    if (update.textBody !== undefined) { setParts.push("textBody = :textBody"); exprValues[":textBody"] = update.textBody; }
    if (update.from !== undefined) { setParts.push("#from = :from"); exprValues[":from"] = update.from; exprNames["#from"] = "from"; }
    if (update.to !== undefined) { setParts.push("#to = :to"); exprValues[":to"] = update.to; exprNames["#to"] = "to"; }

    await dynamo.send(new UpdateCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: sigPk(accountId, id), sk: ITEM_SK },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
    }));
    return (await this.getSignal(accountId, id))!;
  }

  async deleteSignal(accountId: string, id: string): Promise<void> {
    await dynamo.send(new DeleteCommand({
      TableName: SIGNALS_TABLE,
      Key: { pk: sigPk(accountId, id), sk: ITEM_SK },
    }));
  }

  async listArcs(accountId: string, params: ListArcsParams): Promise<Page<Arc>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const gsi1pk = `ACCT#${accountId}`;

    let items: Arc[];
    let lastKey: Record<string, unknown> | undefined;

    if (params.status) {
      // Single query — status is encoded in gsi1sk prefix for efficient reads
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
        ExpressionAttributeValues: { ":pk": gsi1pk, ":prefix": `LASTACT#${params.status}#` },
        ScanIndexForward: false,
        Limit: limit + 1,
        ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
      }));
      items = (res.Items ?? []) as Arc[];
      lastKey = res.LastEvaluatedKey;
    } else {
      // Multi-status view: parallel queries per status, merge by lastSignalAt
      const statuses: Array<"active" | "archived" | "deleted"> = ["active", "archived", "deleted"];
      const results = await Promise.all(statuses.map(s =>
        dynamo.send(new QueryCommand({
          TableName: SIGNALS_TABLE,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
          ExpressionAttributeValues: { ":pk": gsi1pk, ":prefix": `LASTACT#${s}#` },
          ScanIndexForward: false,
          Limit: limit + 1,
        }))
      ));
      items = results.flatMap(r => (r.Items ?? []) as Arc[]);
      items.sort((a, b) => b.lastSignalAt.localeCompare(a.lastSignalAt));
      lastKey = undefined; // no cursor for multi-status merge
    }

    if (params.workflow) items = items.filter((a) => a.workflow === params.workflow);
    if (params.label) items = items.filter((a) => a.labels.includes(params.label!));

    const page = items.slice(0, limit);
    const nextKey = items.length > limit && lastKey ? encodeCursor(lastKey) : null;
    return { items: page, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  async searchArcs(accountId: string, query: string, params: PageParams): Promise<Page<Arc>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const res = await dynamo.send(new QueryCommand({
      TableName: SIGNALS_TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "LASTACT#active#" },
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
    return { items: page, ...(nextKey ? { nextCursor: nextKey } : {}) };
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
