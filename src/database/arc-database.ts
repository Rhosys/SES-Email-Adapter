import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, SIGNALS_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ListArcsParams } from "../api/app.js";
import type { Arc, Signal, AnySignal, EmailSignalData, Page, PageParams, ArcStatus, ArcUrgency, Workflow } from "../types/index.js";
import type { CalendarEventData } from "../types/calendar.js";

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const arcPk  = (accountId: string, id: string) => `ACCT#${accountId}#ARC#${id}`;
const sigPk  = (accountId: string, signalLookupId: string) => `ACCT#${accountId}#SIG#${signalLookupId}`;
const ITEM_SK = "#";
const gkeyPk = (accountId: string, key: string) => `GKEY#${accountId}#${key}`;

// ---------------------------------------------------------------------------
// UpdateArcFields — optional fields bag for updateArc
// ---------------------------------------------------------------------------

export interface UpdateArcFields {
  urgency?: ArcUrgency;
  labels?: string[];
  summary?: string;
  workflow?: Workflow;
  retentionDuration?: string;
  sentMessageIds?: string[];
  senderAddress?: string;
  recipientAddress?: string;
  subject?: string;
}

// ---------------------------------------------------------------------------
// Stale pending_send coercion — read-time only, DynamoDB record is NOT mutated
// ---------------------------------------------------------------------------

export const PENDING_SEND_STALE_HOURS = 4;

export function coerceStaleStatus(signal: Signal): Signal {
  if (signal.status !== "pending_send") return signal;
  const sendInitiatedAt = (signal.data as { sendInitiatedAt?: string }).sendInitiatedAt;
  if (!sendInitiatedAt) return { ...signal, status: "draft" };
  const elapsed = DateTime.utc().diff(DateTime.fromISO(sendInitiatedAt), "hours").hours;
  if (elapsed > PENDING_SEND_STALE_HOURS) return { ...signal, status: "draft" };
  return signal;
}

// ---------------------------------------------------------------------------
// ArcDatabase
// Owns: Arcs and Signals in SIGNALS_TABLE (DynamoDB)
// ---------------------------------------------------------------------------

export class ArcDatabase {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Signals
  // ---------------------------------------------------------------------------

  async getSignalById(accountId: string, signalId: string, arcId?: string): Promise<Result<Signal | null, DbError>> {
    try {
      if (arcId) {
        // Query the specific arc partition with gsi1sk = signalId
        const res = await dynamo.send(new QueryCommand({
          TableName: SIGNALS_TABLE,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :pk AND gsi1sk = :sk",
          ExpressionAttributeValues: { ":pk": `ACCT#${accountId}#ARC#${arcId}`, ":sk": signalId },
          Limit: 1,
        }));
        return ok(res.Items?.[0] ? coerceStaleStatus(res.Items[0] as Signal) : null);
      }

      // No arcId — query across all three GSI PK patterns
      const partitions = [
        `ACCT#${accountId}#QUARANTINED`,
        `ACCT#${accountId}#BLOCKED`,
      ];

      for (const pk of partitions) {
        const res = await dynamo.send(new QueryCommand({
          TableName: SIGNALS_TABLE,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :pk AND gsi1sk = :sk",
          ExpressionAttributeValues: { ":pk": pk, ":sk": signalId },
          Limit: 1,
        }));
        if (res.Items?.[0]) return ok(coerceStaleStatus(res.Items[0] as Signal));
      }

      // For user/system signals, signalLookupId === id — try direct table get
      const directRes = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalId), sk: ITEM_SK },
      }));
      return ok(directRes.Item ? coerceStaleStatus(directRes.Item as Signal) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getSignalByMessageId(accountId: string, sesMessageId: string): Promise<Result<Signal | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, `ses-${sesMessageId}`), sk: ITEM_SK },
      }));
      return ok(res.Item ? coerceStaleStatus(res.Item as Signal) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async findSignalByEmailMessageId(gsi2pk: string): Promise<Result<{ arcId?: string; id: string; signalLookupId: string; accountId: string; status: string; source: string; type: string } | null, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi2",
        KeyConditionExpression: "gsi2pk = :val",
        ExpressionAttributeValues: { ":val": gsi2pk },
        Limit: 1,
      }));
      if (!res.Items || res.Items.length === 0) return ok(null);
      const item = res.Items[0] as { arcId?: string; id: string; signalLookupId: string; accountId: string; status: string; source: string; type: string };
      return ok(item);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveSignal(signal: AnySignal): Promise<Result<void, DbError>> {
    let gsi1pk: string;
    if (signal.arcId) {
      gsi1pk = `ACCT#${signal.accountId}#ARC#${signal.arcId}`;
    } else if (signal.status === "quarantine_visible" || signal.status === "quarantine_hidden") {
      gsi1pk = `ACCT#${signal.accountId}#QUARANTINED`;
    } else {
      gsi1pk = `ACCT#${signal.accountId}#BLOCKED`;
    }
    const gsi1sk = signal.id;
    try {
      await dynamo.send(new PutCommand({
        TableName: SIGNALS_TABLE,
        Item: {
          ...signal,
          pk: sigPk(signal.accountId, signal.signalLookupId),
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

  async createSignal(signal: Signal): Promise<Result<Signal, DbError>> {
    const saveResult = await this.saveSignal(signal);
    if (saveResult.isErr()) return err(saveResult.error);
    return ok(signal);
  }

  async listSignals(accountId: string, arcId: string, params: PageParams): Promise<Result<Page<Signal>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `ACCT#${accountId}#ARC#${arcId}` },
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
    const gsi1pk = `ACCT#${accountId}#QUARANTINED`;
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

  async updateSignalStatus(accountId: string, signalLookupId: string, status: "block_hidden" | "block_reject" | "violate_report"): Promise<Result<Signal, DbError>> {
    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
        UpdateExpression: "SET #status = :status, gsi1pk = :gsi1pk",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":gsi1pk": `ACCT#${accountId}#BLOCKED`,
        },
        ReturnValues: "ALL_NEW",
      }));
      return ok(result.Attributes as unknown as Signal);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async unblockSignal(accountId: string, signalLookupId: string, arcId: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
        UpdateExpression: "SET arcId = :arcId, #status = :status, gsi1pk = :gsi1pk",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":arcId": arcId,
          ":status": "active",
          ":gsi1pk": `ACCT#${accountId}#ARC#${arcId}`,
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

  async fastFindArcByAlternativeLookupKey(accountId: string, key: string): Promise<Result<Arc | null, DbError>> {
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

  async updateArc(accountId: string, id: string, status: ArcStatus, lastSignalAt: string, update: UpdateArcFields): Promise<Result<Arc, DbError>> {
    const now = DateTime.utc().toISO()!;
    const setParts: string[] = [
      "updatedAt = :now",
      "#status = :status",
      "lastSignalAt = :lastSignalAt",
      "gsi1sk = :gsi1sk",
    ];
    const exprValues: Record<string, unknown> = {
      ":now": now,
      ":status": status,
      ":lastSignalAt": lastSignalAt,
      ":gsi1sk": `LASTACT#${status}#${lastSignalAt}#${id}`,
    };
    const exprNames: Record<string, string> = { "#status": "status" };

    if (update.labels !== undefined) { setParts.push("labels = :labels"); exprValues[":labels"] = update.labels; }
    if (update.urgency !== undefined) { setParts.push("urgency = :urgency"); exprValues[":urgency"] = update.urgency; }
    if (update.summary !== undefined) { setParts.push("summary = :summary"); exprValues[":summary"] = update.summary; }
    if (update.workflow !== undefined) { setParts.push("workflow = :workflow"); exprValues[":workflow"] = update.workflow; }
    if (update.retentionDuration !== undefined) { setParts.push("retentionDuration = :rd"); exprValues[":rd"] = update.retentionDuration; }
    if (update.sentMessageIds !== undefined) { setParts.push("sentMessageIds = :smids"); exprValues[":smids"] = update.sentMessageIds; }
    if (update.senderAddress !== undefined) { setParts.push("senderAddress = :senderAddress"); exprValues[":senderAddress"] = update.senderAddress; }
    if (update.recipientAddress !== undefined) { setParts.push("recipientAddress = :recipientAddress"); exprValues[":recipientAddress"] = update.recipientAddress; }
    if (update.subject !== undefined) { setParts.push("#subject = :subject"); exprValues[":subject"] = update.subject; exprNames["#subject"] = "subject"; }

    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: arcPk(accountId, id), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ExpressionAttributeNames: exprNames,
        ReturnValues: "ALL_NEW",
      }));
      return ok(result.Attributes as unknown as Arc);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateSignal(accountId: string, signalLookupId: string, update: Partial<Pick<EmailSignalData, "subject" | "textBody" | "from" | "to">>): Promise<Result<Signal, DbError>> {
    const now = DateTime.utc().toISO()!;
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.subject !== undefined) { setParts.push("#data.#subject = :subject"); exprValues[":subject"] = update.subject; exprNames["#subject"] = "subject"; exprNames["#data"] = "data"; }
    if (update.textBody !== undefined) { setParts.push("#data.textBody = :textBody"); exprValues[":textBody"] = update.textBody; exprNames["#data"] = "data"; }
    if (update.from !== undefined) { setParts.push("#data.#from = :from"); exprValues[":from"] = update.from; exprNames["#from"] = "from"; exprNames["#data"] = "data"; }
    if (update.to !== undefined) { setParts.push("#data.#to = :to"); exprValues[":to"] = update.to; exprNames["#to"] = "to"; exprNames["#data"] = "data"; }

    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
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

  async updateSignalSendStatus(
    accountId: string,
    signalLookupId: string,
    update: {
      status: "pending_send" | "sent" | "draft";
      sendInitiatedAt?: string | null;
      sentAt?: string;
      sesMessageId?: string;
      sendFailureReason?: string;
      gsi2pk?: string;
    },
  ): Promise<Result<Signal, DbError>> {
    const setParts: string[] = ["#status = :status", "updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":status": update.status, ":now": DateTime.utc().toISO()! };
    const exprNames: Record<string, string> = { "#status": "status", "#data": "data" };
    const removeParts: string[] = [];

    if (update.sendInitiatedAt === null) {
      removeParts.push("#data.sendInitiatedAt");
    } else if (update.sendInitiatedAt !== undefined) {
      setParts.push("#data.sendInitiatedAt = :sia");
      exprValues[":sia"] = update.sendInitiatedAt;
    }

    if (update.sentAt !== undefined) { setParts.push("#data.sentAt = :sentAt"); exprValues[":sentAt"] = update.sentAt; }
    if (update.sesMessageId !== undefined) { setParts.push("#data.sesMessageId = :smid"); exprValues[":smid"] = update.sesMessageId; }
    if (update.sendFailureReason !== undefined) { setParts.push("#data.sendFailureReason = :sfr"); exprValues[":sfr"] = update.sendFailureReason; }
    if (update.gsi2pk !== undefined) { setParts.push("gsi2pk = :gsi2pk"); exprValues[":gsi2pk"] = update.gsi2pk; }

    let updateExpr = `SET ${setParts.join(", ")}`;
    if (removeParts.length > 0) updateExpr += ` REMOVE ${removeParts.join(", ")}`;

    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
        UpdateExpression: updateExpr,
        ExpressionAttributeValues: exprValues,
        ExpressionAttributeNames: exprNames,
        ReturnValues: "ALL_NEW",
      }));
      return ok(result.Attributes as unknown as Signal);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteSignal(accountId: string, signalLookupId: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
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
        this.logger.track("Arc search query returned an unusually large result set before client-side filtering. DynamoDB scan fetched more items than expected for this account. Repeated occurrences indicate the account's active arc count exceeds efficient scan limits. Consider adding a filtered GSI or prompting the user to archive old arcs.", {
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
  // Embedding Cache (DynamoDB partial update for backfill/reindex)
  // ---------------------------------------------------------------------------

  async addEmbeddingToCache(
    accountId: string,
    signalLookupId: string,
    modelId: string,
    vector: number[],
  ): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
        UpdateExpression: "SET #data.embeddings.#mid = :v",
        ExpressionAttributeNames: { "#data": "data", "#mid": modelId },
        ExpressionAttributeValues: { ":v": vector },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateSignalRetention(
    accountId: string,
    signalLookupId: string,
    update: { s3Key?: string; retentionDuration?: string },
  ): Promise<Result<void, DbError>> {
    const setParts: string[] = [];
    const exprValues: Record<string, unknown> = {};
    const exprNames: Record<string, string> = {};

    if (update.s3Key !== undefined) {
      setParts.push("#data.s3Key = :s3Key");
      exprValues[":s3Key"] = update.s3Key;
      exprNames["#data"] = "data";
    }
    if (update.retentionDuration !== undefined) {
      setParts.push("retentionDuration = :rd");
      exprValues[":rd"] = update.retentionDuration;
    }

    if (setParts.length === 0) return ok(undefined);

    try {
      await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Onboarding — check if account has received at least one signal
  // ---------------------------------------------------------------------------

  async hasSignals(accountId: string): Promise<Result<boolean, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `ACCT#${accountId}` },
        Limit: 1,
        Select: "COUNT",
      }));
      return ok((res.Count ?? 0) > 0);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /**
   * Find the calendar_event signal on an arc that is linked to a given email signal.
   * Returns null if no linked calendar signal exists.
   */
  async getLinkedCalendarSignal(accountId: string, arcId: string, emailSignalId: string): Promise<Result<Signal<CalendarEventData> | null, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `ACCT#${accountId}#ARC#${arcId}` },
        ScanIndexForward: false,
      }));
      const signals = (res.Items ?? []) as unknown[];
      const calendarSignal = signals.find(
        (s) => {
          const sig = s as { type?: string; data?: { linkedSignalId?: string } };
          return sig.type === "calendar_event" && sig.data?.linkedSignalId === emailSignalId;
        },
      );
      return ok(calendarSignal ? (calendarSignal as unknown as Signal<CalendarEventData>) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /**
   * Find the most recent calendar_response signal on an arc for a given veventUid.
   * Returns the decision from the most recent response, or null if none exists.
   */
  async getLatestCalendarResponse(accountId: string, arcId: string, veventUid: string): Promise<Result<Signal<import("../types/calendar.js").CalendarResponseData> | null, DbError>> {
    try {
      // Query all signals on the arc (sorted newest-first via ScanIndexForward: false)
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `ACCT#${accountId}#ARC#${arcId}` },
        ScanIndexForward: false,
      }));
      const signals = (res.Items ?? []) as unknown[];
      const responseSignal = signals.find(
        (s) => {
          const sig = s as { type?: string; data?: { veventUid?: string } };
          return sig.type === "calendar_response" && sig.data?.veventUid === veventUid;
        },
      );
      return ok(responseSignal ? (responseSignal as unknown as Signal<import("../types/calendar.js").CalendarResponseData>) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
