import { RDSDataClient, ExecuteStatementCommand, BeginTransactionCommand, CommitTransactionCommand, RollbackTransactionCommand } from "@aws-sdk/client-rds-data";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, SIGNALS_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ArcMatcher } from "../processor/processor.js";
import type { ListArcsParams, UpdateArcRequest } from "../api/app.js";
import type { Arc, Signal, Page, PageParams } from "../types/index.js";

// ---------------------------------------------------------------------------
// Aurora Data API client (stateless — no connection pool needed)
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.5;
const CLUSTER_ARN = process.env["AURORA_CLUSTER_ARN"] ?? "";
const SECRET_ARN  = process.env["AURORA_SECRET_ARN"]  ?? "";
const DB_NAME     = process.env["AURORA_DB_NAME"]      ?? "signals";

const rdsData = new RDSDataClient({});

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
  private readonly logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Signals
  // ---------------------------------------------------------------------------

  async getSignalByMessageId(accountId: string, sesMessageId: string): Promise<Result<Signal | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, `SES#${sesMessageId}`), sk: ITEM_SK },
      }));
      return ok(res.Item ? (res.Item as Signal) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveSignal(signal: Signal): Promise<Result<void, DbError>> {
    let gsi1pk: string;
    if (signal.arcId) {
      gsi1pk = `ARCSIG#${signal.arcId}`;
    } else if (signal.status === "quarantine_visible" || signal.status === "quarantine_hidden") {
      gsi1pk = `QUARANTINED#${signal.accountId}`;
    } else {
      // block_hidden, block_reject, violate_report — no GSI needed (write-only, never queried by status)
      gsi1pk = `BLOCKED#${signal.accountId}`;
    }
    const gsi1sk = `RECV#${signal.receivedAt}#${signal.id}`;
    try {
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
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getSignal(accountId: string, id: string): Promise<Result<Signal | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, id), sk: ITEM_SK },
      }));
      return ok(res.Item ? (res.Item as Signal) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listSignals(accountId: string, arcId: string, params: PageParams): Promise<Result<Page<Signal>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    try {
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
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Signal>);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listPreArcSignals(accountId: string, _status: "quarantined", params: PageParams): Promise<Result<Page<Signal>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const gsi1pk = `QUARANTINED#${accountId}`;
    try {
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
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Signal>);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateSignalStatus(accountId: string, signalId: string, status: "block_hidden" | "block_reject" | "violate_report"): Promise<Result<Signal, DbError>> {
    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
        UpdateExpression: "SET #status = :status, gsi1pk = :gsi1pk",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":gsi1pk": `BLOCKED#${accountId}`,
        },
        ReturnValues: "ALL_NEW",
      }));
      return ok(result.Attributes as unknown as Signal);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async unblockSignal(accountId: string, signalId: string, arcId: string): Promise<Result<void, DbError>> {
    try {
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
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Arcs
  // ---------------------------------------------------------------------------

  async getArc(accountId: string, id: string): Promise<Result<Arc | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: arcPk(accountId, id), sk: ITEM_SK },
      }));
      return ok(res.Item ? (res.Item as Arc) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async findArcByGroupingKey(accountId: string, key: string): Promise<Result<Arc | null, DbError>> {
    try {
      const result = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: gkeyPk(accountId, key), sk: "GKEY" },
        ProjectionExpression: "arcId",
      }));
      if (!result.Item) return ok(null);
      const arcId = result.Item["arcId"] as string | undefined;
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

  async saveArc(arc: Arc): Promise<Result<void, DbError>> {
    try {
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
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async createArc(arc: Arc): Promise<Result<void, DbError>> {
    return this.saveArc(arc);
  }

  async updateArc(accountId: string, id: string, update: UpdateArcRequest): Promise<Result<Arc, DbError>> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.status !== undefined) {
      setParts.push("#status = :status");
      exprValues[":status"] = update.status;
      exprNames["#status"] = "status";
      if (update.status === "deleted") setParts.push("deletedAt = :now");
      if (update.lastSignalAt) {
        setParts.push("gsi1sk = :gsi1sk");
        exprValues[":gsi1sk"] = `LASTACT#${update.status}#${update.lastSignalAt}#${id}`;
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

    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: arcPk(accountId, id), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      }));
      return ok(result.Attributes as unknown as Arc);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateSignal(accountId: string, id: string, update: Partial<Pick<Signal, "subject" | "textBody" | "from" | "to">>): Promise<Result<Signal, DbError>> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.subject !== undefined) { setParts.push("#subject = :subject"); exprValues[":subject"] = update.subject; exprNames["#subject"] = "subject"; }
    if (update.textBody !== undefined) { setParts.push("textBody = :textBody"); exprValues[":textBody"] = update.textBody; }
    if (update.from !== undefined) { setParts.push("#from = :from"); exprValues[":from"] = update.from; exprNames["#from"] = "from"; }
    if (update.to !== undefined) { setParts.push("#to = :to"); exprValues[":to"] = update.to; exprNames["#to"] = "to"; }

    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, id), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      }));
      return ok(result.Attributes as unknown as Signal);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteSignal(accountId: string, id: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, id), sk: ITEM_SK },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listArcs(accountId: string, params: ListArcsParams): Promise<Result<Page<Arc>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const gsi1pk = `ACCT#${accountId}`;

    try {
      let items: Arc[];
      let lastKey: Record<string, unknown> | undefined;

      if (params.status) {
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
        lastKey = undefined;
      }

      if (params.workflow) items = items.filter((a) => a.workflow === params.workflow);
      if (params.label) items = items.filter((a) => a.labels.includes(params.label!));

      const page = items.slice(0, limit);
      const nextKey = items.length > limit && lastKey ? encodeCursor(lastKey) : null;
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Arc>);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listActiveArcsBefore(accountId: string, beforeDate: string): Promise<Result<Arc[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": `ACCT#${accountId}`,
          ":start": "LASTACT#active#",
          ":end": `LASTACT#active#${beforeDate}#`,
        },
        ScanIndexForward: true,
      }));
      return ok((res.Items ?? []) as Arc[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async searchArcs(accountId: string, query: string, params: PageParams): Promise<Result<Page<Arc>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "LASTACT#active#" },
        ScanIndexForward: false,
        Limit: 500,
        ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
      }));
      const fetchedItems = (res.Items ?? []) as Arc[];
      if (fetchedItems.length > 200) {
        this.logger?.track("Arc search query returned an unusually large result set before client-side filtering. DynamoDB scan fetched more items than expected for this account. Repeated occurrences indicate the account's active arc count exceeds efficient scan limits. Consider adding a filtered GSI or prompting the user to archive old arcs.", {
          code: "arc_database.search_arcs.large_result_set",
          accountId,
          query,
          itemsFetched: fetchedItems.length,
        });
      }

      const q = query.toLowerCase();
      const items = fetchedItems.filter(
        (a) => a.summary.toLowerCase().includes(q) || a.workflow.toLowerCase().includes(q),
      );
      const page = items.slice(0, limit);
      const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Arc>);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // ArcMatcher (pgvector via Aurora Data API)
  // ---------------------------------------------------------------------------

  // Wraps a Data API call in an explicit transaction so SET LOCAL is scoped
  // to that transaction — required for the RLS policy to apply correctly.
  private async withAccountContext<T>(accountId: string, fn: (transactionId: string) => Promise<T>): Promise<T> {
    const { transactionId } = await rdsData.send(new BeginTransactionCommand({
      resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, database: DB_NAME,
    }));
    try {
      await rdsData.send(new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, database: DB_NAME,
        transactionId,
        sql: "SET LOCAL app.current_account_id = :accountId",
        parameters: [{ name: "accountId", value: { stringValue: accountId } }],
      }));
      const result = await fn(transactionId!);
      await rdsData.send(new CommitTransactionCommand({
        resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, transactionId,
      }));
      return result;
    } catch (err) {
      try {
        await rdsData.send(new RollbackTransactionCommand({
          resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, transactionId,
        }));
      } catch { /* rollback best-effort */ }
      throw err;
    }
  }

  async findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Result<Arc | null, DbError>> {
    try {
      const res = await this.withAccountContext(accountId, (transactionId) =>
        rdsData.send(new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, database: DB_NAME,
          transactionId,
          sql: `SELECT arc_id FROM arc_embeddings
                WHERE account_id = :accountId AND recipient_address = :recipient
                  AND embedding <=> :embedding::vector < :threshold
                ORDER BY embedding <=> :embedding::vector
                LIMIT 1`,
          parameters: [
            { name: "accountId",  value: { stringValue: accountId } },
            { name: "recipient",  value: { stringValue: recipientAddress } },
            { name: "embedding",  value: { stringValue: `[${embedding.join(",")}]` } },
            { name: "threshold",  value: { doubleValue: SIMILARITY_THRESHOLD } },
          ],
        })),
      );
      const arcId = res.records?.[0]?.[0]?.stringValue;
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

  async upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): Promise<Result<void, DbError>> {
    try {
      await this.withAccountContext(accountId, (transactionId) =>
        rdsData.send(new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN, secretArn: SECRET_ARN, database: DB_NAME,
          transactionId,
          sql: `INSERT INTO arc_embeddings (arc_id, account_id, recipient_address, embedding, updated_at)
                VALUES (:arcId, :accountId, :recipient, :embedding::vector, NOW())
                ON CONFLICT (arc_id) DO UPDATE
                  SET embedding = EXCLUDED.embedding, updated_at = NOW()`,
          parameters: [
            { name: "arcId",     value: { stringValue: arcId } },
            { name: "accountId", value: { stringValue: accountId } },
            { name: "recipient", value: { stringValue: recipientAddress } },
            { name: "embedding", value: { stringValue: `[${embedding.join(",")}]` } },
          ],
        })),
      );
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Embedding Cache (DynamoDB partial update for backfill/reindex)
  // ---------------------------------------------------------------------------

  async addEmbeddingToCache(
    accountId: string,
    signalId: string,
    modelId: string,
    vector: number[],
  ): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
        UpdateExpression: "SET embeddings.#mid = :v",
        ExpressionAttributeNames: { "#mid": modelId },
        ExpressionAttributeValues: { ":v": vector },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateSignalRetention(
    accountId: string,
    signalId: string,
    update: Partial<Pick<Signal, "s3Key" | "retentionDuration">>,
  ): Promise<Result<void, DbError>> {
    const setParts: string[] = [];
    const exprValues: Record<string, unknown> = {};

    if (update.s3Key !== undefined) {
      setParts.push("s3Key = :s3Key");
      exprValues[":s3Key"] = update.s3Key;
    }
    if (update.retentionDuration !== undefined) {
      setParts.push("retentionDuration = :rd");
      exprValues[":rd"] = update.retentionDuration;
    }

    if (setParts.length === 0) return ok(undefined);

    try {
      await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
