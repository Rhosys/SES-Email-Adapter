import { RDSDataClient, ExecuteStatementCommand, BeginTransactionCommand, CommitTransactionCommand, RollbackTransactionCommand } from "@aws-sdk/client-rds-data";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ResultAsync } from "neverthrow";
import { dynamo, SIGNALS_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import { dbError } from "../errors.js";
import type { DbError } from "../errors.js";
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
// Error mapper for ResultAsync.fromPromise
// ---------------------------------------------------------------------------

const toDbError = (e: unknown): DbError => dbError(e instanceof Error ? e : new Error(String(e)));

// ---------------------------------------------------------------------------
// ArcDatabase
// Owns: Arcs and Signals in SIGNALS_TABLE, plus pgvector similarity search
// ---------------------------------------------------------------------------

export class ArcDatabase implements ArcMatcher {
  // ---------------------------------------------------------------------------
  // Signals
  // ---------------------------------------------------------------------------

  getSignalByMessageId(accountId: string, sesMessageId: string): ResultAsync<Pick<Signal, "id"> | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, `SES#${sesMessageId}`), sk: ITEM_SK },
        ProjectionExpression: "id",
      })).then(res => res.Item ? (res.Item as Pick<Signal, "id">) : null),
      toDbError,
    );
  }

  saveSignal(signal: Signal): ResultAsync<void, DbError> {
    let gsi1pk: string;
    if (signal.arcId) {
      gsi1pk = `ARCSIG#${signal.arcId}`;
    } else if (signal.status === "quarantine_visible" || signal.status === "quarantine_hidden") {
      gsi1pk = `QUARANTINED#${signal.accountId}`;
    } else {
      gsi1pk = `BLOCKED#${signal.accountId}`;
    }
    const gsi1sk = `RECV#${signal.receivedAt}#${signal.id}`;
    return ResultAsync.fromPromise(
      dynamo.send(new PutCommand({
        TableName: SIGNALS_TABLE,
        Item: {
          ...signal,
          pk: sigPk(signal.accountId, signal.id),
          sk: ITEM_SK,
          gsi1pk,
          gsi1sk,
        },
      })).then(() => undefined),
      toDbError,
    );
  }

  getSignal(accountId: string, id: string): ResultAsync<Signal | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, id), sk: ITEM_SK },
      })).then(res => res.Item ? (res.Item as Signal) : null),
      toDbError,
    );
  }

  listSignals(accountId: string, arcId: string, params: PageParams): ResultAsync<Page<Signal>, DbError> {
    const limit = Math.min(params.limit ?? 20, 100);
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `ARCSIG#${arcId}` },
        ScanIndexForward: false,
        Limit: limit + 1,
        ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
      })).then(res => {
        const items = (res.Items ?? []) as Signal[];
        const page = items.slice(0, limit);
        const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
        return { items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Signal>;
      }),
      toDbError,
    );
  }

  listPreArcSignals(accountId: string, status: "blocked" | "quarantined", params: PageParams): ResultAsync<Page<Signal>, DbError> {
    const limit = Math.min(params.limit ?? 20, 100);
    const gsi1pk = status === "quarantined" ? `QUARANTINED#${accountId}` : `BLOCKED#${accountId}`;
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": gsi1pk },
        ScanIndexForward: false,
        Limit: limit + 1,
        ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
      })).then(res => {
        const items = (res.Items ?? []) as Signal[];
        const page = items.slice(0, limit);
        const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
        return { items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Signal>;
      }),
      toDbError,
    );
  }

  blockSignal(accountId: string, signalId: string): ResultAsync<Signal, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
        UpdateExpression: "SET #status = :status, gsi1pk = :gsi1pk",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "blocked",
          ":gsi1pk": `BLOCKED#${accountId}`,
        },
        ReturnValues: "ALL_NEW",
      })).then(result => result.Attributes as unknown as Signal),
      toDbError,
    );
  }

  unblockSignal(accountId: string, signalId: string, arcId: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
        UpdateExpression: "SET arcId = :arcId, #status = :status, gsi1pk = :gsi1pk",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":arcId": arcId,
          ":status": "active",
          ":gsi1pk": `ARCSIG#${arcId}`,
        },
      })).then(() => undefined),
      toDbError,
    );
  }

  // ---------------------------------------------------------------------------
  // Arcs
  // ---------------------------------------------------------------------------

  getArc(accountId: string, id: string): ResultAsync<Arc | null, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: arcPk(accountId, id), sk: ITEM_SK },
      })).then(res => res.Item ? (res.Item as Arc) : null),
      toDbError,
    );
  }

  findArcByGroupingKey(accountId: string, key: string): ResultAsync<Arc | null, DbError> {
    return ResultAsync.fromPromise(
      (async () => {
        const result = await dynamo.send(new GetCommand({
          TableName: SIGNALS_TABLE,
          Key: { pk: gkeyPk(accountId, key), sk: "GKEY" },
          ProjectionExpression: "arcId",
        }));
        if (!result.Item) return null;
        const arcId = result.Item["arcId"] as string | undefined;
        if (!arcId) return null;
        const arcResult = await dynamo.send(new GetCommand({
          TableName: SIGNALS_TABLE,
          Key: { pk: arcPk(accountId, arcId), sk: ITEM_SK },
        }));
        return arcResult.Item ? (arcResult.Item as Arc) : null;
      })(),
      toDbError,
    );
  }

  saveArc(arc: Arc): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      (async () => {
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
      })(),
      toDbError,
    );
  }

  createArc(arc: Arc): ResultAsync<void, DbError> {
    return this.saveArc(arc);
  }

  updateArc(accountId: string, id: string, update: UpdateArcRequest): ResultAsync<Arc, DbError> {
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

    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: arcPk(accountId, id), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      })).then(result => result.Attributes as unknown as Arc),
      toDbError,
    );
  }

  updateSignal(accountId: string, id: string, update: Partial<Pick<Signal, "subject" | "textBody" | "from" | "to">>): ResultAsync<Signal, DbError> {
    const now = new Date().toISOString();
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.subject !== undefined) { setParts.push("#subject = :subject"); exprValues[":subject"] = update.subject; exprNames["#subject"] = "subject"; }
    if (update.textBody !== undefined) { setParts.push("textBody = :textBody"); exprValues[":textBody"] = update.textBody; }
    if (update.from !== undefined) { setParts.push("#from = :from"); exprValues[":from"] = update.from; exprNames["#from"] = "from"; }
    if (update.to !== undefined) { setParts.push("#to = :to"); exprValues[":to"] = update.to; exprNames["#to"] = "to"; }

    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, id), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      })).then(result => result.Attributes as unknown as Signal),
      toDbError,
    );
  }

  deleteSignal(accountId: string, id: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new DeleteCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, id), sk: ITEM_SK },
      })).then(() => undefined),
      toDbError,
    );
  }

  listArcs(accountId: string, params: ListArcsParams): ResultAsync<Page<Arc>, DbError> {
    const limit = Math.min(params.limit ?? 20, 100);
    const gsi1pk = `ACCT#${accountId}`;

    return ResultAsync.fromPromise(
      (async () => {
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
        return { items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Arc>;
      })(),
      toDbError,
    );
  }

  listActiveArcsBefore(accountId: string, beforeDate: string): ResultAsync<Arc[], DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": `ACCT#${accountId}`,
          ":start": "LASTACT#active#",
          ":end": `LASTACT#active#${beforeDate}#`,
        },
        ScanIndexForward: true,
      })).then(res => (res.Items ?? []) as Arc[]),
      toDbError,
    );
  }

  searchArcs(accountId: string, query: string, params: PageParams): ResultAsync<Page<Arc>, DbError> {
    const limit = Math.min(params.limit ?? 20, 100);
    return ResultAsync.fromPromise(
      dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "LASTACT#active#" },
        ScanIndexForward: false,
        Limit: 500,
        ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
      })).then(res => {
        const fetchedItems = (res.Items ?? []) as Arc[];
        if (fetchedItems.length > 200) {
          console.warn(JSON.stringify({
            level: "warn",
            message: "searchArcs.large_result_set",
            accountId,
            query,
            itemsFetched: fetchedItems.length,
            timestamp: new Date().toISOString(),
          }));
        }

        const q = query.toLowerCase();
        const items = fetchedItems.filter(
          (a) => a.summary.toLowerCase().includes(q) || a.workflow.toLowerCase().includes(q),
        );
        const page = items.slice(0, limit);
        const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
        return { items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Arc>;
      }),
      toDbError,
    );
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

  findMatch(accountId: string, recipientAddress: string, embedding: number[]): ResultAsync<Arc | null, DbError> {
    return ResultAsync.fromPromise(
      (async () => {
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
        if (!arcId) return null;
        const arcResult = await dynamo.send(new GetCommand({
          TableName: SIGNALS_TABLE,
          Key: { pk: arcPk(accountId, arcId), sk: ITEM_SK },
        }));
        return arcResult.Item ? (arcResult.Item as Arc) : null;
      })(),
      toDbError,
    );
  }

  upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      this.withAccountContext(accountId, (transactionId) =>
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
      ).then(() => undefined),
      toDbError,
    );
  }

  // ---------------------------------------------------------------------------
  // Embedding Cache (DynamoDB partial update for backfill/reindex)
  // ---------------------------------------------------------------------------

  addEmbeddingToCache(
    accountId: string,
    signalId: string,
    modelId: string,
    vector: number[],
  ): ResultAsync<void, DbError> {
    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
        UpdateExpression: "SET embeddings.#mid = :v",
        ExpressionAttributeNames: { "#mid": modelId },
        ExpressionAttributeValues: { ":v": vector },
      })).then(() => undefined),
      toDbError,
    );
  }

  updateSignalRetention(
    accountId: string,
    signalId: string,
    update: Partial<Pick<Signal, "s3Key" | "retentionDuration">>,
  ): ResultAsync<void, DbError> {
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

    if (setParts.length === 0) return ResultAsync.fromPromise(Promise.resolve(undefined), toDbError);

    return ResultAsync.fromPromise(
      dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
      })).then(() => undefined),
      toDbError,
    );
  }
}
