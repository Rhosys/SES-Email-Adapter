import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, SIGNALS_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ListThreadsParams } from "../api/app.js";
import type { Thread, Signal, AnySignal, EmailSignalData, OutboundEmailSignalData, Page, PageParams, ThreadStatus, ThreadUrgency, Workflow } from "../types/index.js";
import type { CalendarEventData } from "../types/calendar.js";

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const threadPk  = (accountId: string, id: string) => `ACCT#${accountId}#ARC#${id}`;
const sigPk  = (accountId: string, signalLookupId: string) => `ACCT#${accountId}#SIG#${signalLookupId}`;
const ITEM_SK = "#";
const buildThreadGsi3pk = (accountId: string, groupingKey: string) => `ACCT#${accountId}#GKEY#${groupingKey}`;

// ---------------------------------------------------------------------------
// UpdateThreadFields — optional fields bag for updateThread
// ---------------------------------------------------------------------------

export interface UpdateThreadFields {
  urgency?: ThreadUrgency;
  labels?: string[];
  summary?: string;
  workflow?: Workflow;
  retentionDuration?: string;
  sentMessageIds?: string[];
  senderAddress?: string;
  recipientAddress?: string;
  subject?: string;
  followupAt?: string;
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
// Persistence boundary — threadId-only write + universal read fallback
// ---------------------------------------------------------------------------

/** Resolve the thread identifier from a DDB record, falling back to legacy arcId attribute. */
function resolveThreadId(record: Record<string, unknown>): string | undefined {
  return (record.threadId as string | undefined) ?? (record.arcId as string | undefined);
}

function hydrateThreadObject<T>(record: T): T {
  const r = record as Record<string, unknown>;
  const threadId = resolveThreadId(r);
  if (threadId === undefined) return record;
  return { ...record, threadId };
}

// ---------------------------------------------------------------------------
// hydrateSignal — defaults fields that may be absent on legacy DDB items
// ---------------------------------------------------------------------------

function hydrateSignal<T>(item: T): T {
  const hydrated = hydrateThreadObject(item);
  const record = hydrated as Record<string, unknown>;
  if (!record["labels"]) { return { ...hydrated, labels: [] }; }
  return hydrated;
}

// ---------------------------------------------------------------------------
// ThreadDatabase
// Owns: Threads and Signals in SIGNALS_TABLE (DynamoDB)
// ---------------------------------------------------------------------------

export class ThreadDatabase {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Signals
  // ---------------------------------------------------------------------------

  async getSignalById(accountId: string, signalId: string, threadId: string): Promise<Result<Signal | null, DbError>> {
    try {
      const gsi1pk = threadId === "QUARANTINED" ? `ACCT#${accountId}#QUARANTINED`
        : threadId === "BLOCKED" ? `ACCT#${accountId}#BLOCKED`
        : threadPk(accountId, threadId);

      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk = :sk",
        ExpressionAttributeValues: { ":pk": gsi1pk, ":sk": signalId },
      }));
      const items = res.Items ?? [];
      if (items.length > 1) {
        this.logger.error("Signal id is supposed to be unique within a thread but more than one record was found. Returning the first, but this indicates a data integrity bug.", { code: "thread_database.signal_not_unique", accountId, signalId, threadId, count: items.length });
      }
      return ok(items[0] ? coerceStaleStatus(hydrateSignal(items[0] as Signal)) : null);
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
      return ok(res.Item ? coerceStaleStatus(hydrateSignal(res.Item as Signal)) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async findSignalByEmailMessageId(gsi3pk: string): Promise<Result<{ threadId?: string; id: string; signalLookupId: string; accountId: string; status: string; source: string; type: string } | null, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi3",
        KeyConditionExpression: "gsi3pk = :val",
        ExpressionAttributeValues: { ":val": gsi3pk },
      }));
      const items = res.Items ?? [];
      if (items.length === 0) return ok(null);
      if (items.length > 1) {
        this.logger.error("Email message id is supposed to be globally unique but more than one signal record was found. Returning the first, but this indicates a data integrity bug.", { code: "thread_database.email_message_id_not_unique", gsi3pk, count: items.length });
      }
      const item = hydrateThreadObject(items[0] as { threadId?: string; arcId?: string; id: string; signalLookupId: string; accountId: string; status: string; source: string; type: string });
      return ok(item as { threadId?: string; id: string; signalLookupId: string; accountId: string; status: string; source: string; type: string });
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveSignal(signal: AnySignal): Promise<Result<void, DbError>> {
    let gsi1pk: string;
    if (signal.threadId) {
      gsi1pk = threadPk(signal.accountId, signal.threadId);
    } else if (signal.status === "quarantine_visible" || signal.status === "quarantine_hidden") {
      gsi1pk = `ACCT#${signal.accountId}#QUARANTINED`;
    } else {
      gsi1pk = `ACCT#${signal.accountId}#BLOCKED`;
    }
    const gsi1sk = signal.id;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { arcId: _arcId, ...rest } = signal as AnySignal & { arcId?: string };
    try {
      await dynamo.send(new PutCommand({
        TableName: SIGNALS_TABLE,
        Item: {
          ...rest,
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

  async listSignals(accountId: string, threadId: string, params: PageParams): Promise<Result<Page<Signal>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": threadPk(accountId, threadId) },
        ScanIndexForward: false,
        Limit: limit + 1,
        ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
      }));
      const items = (res.Items ?? []).map(i => hydrateSignal(i as Signal));
      const page = items.slice(0, limit);
      const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Signal>);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listPreThreadSignals(accountId: string, status: "quarantined" | "blocked", params: PageParams): Promise<Result<Page<Signal>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const gsi1pk = status === "blocked" ? `ACCT#${accountId}#BLOCKED` : `ACCT#${accountId}#QUARANTINED`;
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
      const items = (res.Items ?? []).map(i => hydrateSignal(i as Signal));
      const page = items.slice(0, limit);
      const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Signal>);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateSignalStatus(accountId: string, signalLookupId: string, status: "block_hidden" | "block_reject" | "report_violation"): Promise<Result<Signal, DbError>> {
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
      return ok(hydrateSignal(result.Attributes as unknown as Signal));
    } catch (e) {
      return err(dbError(e));
    }
  }

  async unblockSignal(accountId: string, signalLookupId: string, threadId: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
        UpdateExpression: "SET threadId = :threadId, #status = :status, gsi1pk = :gsi1pk",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":threadId": threadId,
          ":status": "active",
          ":gsi1pk": threadPk(accountId, threadId),
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Threads
  // ---------------------------------------------------------------------------

  async getThread(accountId: string, id: string): Promise<Result<Thread | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: threadPk(accountId, id), sk: ITEM_SK },
      }));
      return ok(res.Item ? hydrateThreadObject(res.Item as Thread) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async findThreadByGroupingKey(accountId: string, key: string): Promise<Result<Thread | null, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi3",
        KeyConditionExpression: "gsi3pk = :val",
        ExpressionAttributeValues: { ":val": buildThreadGsi3pk(accountId, key) },
      }));
      const items = res.Items ?? [];
      if (items.length === 0) return ok(null);
      if (items.length > 1) {
        this.logger.error("Thread grouping key is supposed to be unique per account but more than one thread record was found. Returning the first, but this indicates a data integrity bug.", { code: "thread_database.grouping_key_not_unique", accountId, key, count: items.length });
      }
      return ok(hydrateThreadObject(items[0] as Thread));
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveThread(thread: Thread): Promise<Result<void, DbError>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { arcId: _arcId, ...rest } = thread as Thread & { arcId?: string };
    try {
      const item: Record<string, unknown> = {
        ...rest,
        threadId: thread.id,
        pk: threadPk(thread.accountId, thread.id),
        sk: ITEM_SK,
        gsi1pk: `ACCT#${thread.accountId}`,
        gsi1sk: `LASTACT#${thread.status}#${thread.lastSignalAt}#${thread.id}`,
      };

      if (thread.groupingKey) {
        item.gsi3pk = buildThreadGsi3pk(thread.accountId, thread.groupingKey);
      }

      await dynamo.send(new PutCommand({
        TableName: SIGNALS_TABLE,
        Item: item,
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async createThread(thread: Thread): Promise<Result<void, DbError>> {
    return this.saveThread(thread);
  }

  async updateThread(accountId: string, id: string, status: ThreadStatus, lastSignalAt: string, update: UpdateThreadFields): Promise<Result<Thread, DbError>> {
    const now = DateTime.utc().toISO()!;
    const setParts: string[] = [
      "updatedAt = :now",
      "#status = :status",
      "lastSignalAt = :lastSignalAt",
      "gsi1sk = :gsi1sk",
      "threadId = :threadId",
    ];
    const exprValues: Record<string, unknown> = {
      ":now": now,
      ":status": status,
      ":lastSignalAt": lastSignalAt,
      ":gsi1sk": `LASTACT#${status}#${lastSignalAt}#${id}`,
      ":threadId": id,
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
    if (update.followupAt !== undefined) { setParts.push("followupAt = :followupAt"); exprValues[":followupAt"] = update.followupAt; }

    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: threadPk(accountId, id), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ExpressionAttributeNames: exprNames,
        ReturnValues: "ALL_NEW",
      }));
      return ok(hydrateThreadObject(result.Attributes as unknown as Thread));
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateSignal(accountId: string, signalLookupId: string, update: Partial<Pick<OutboundEmailSignalData, "subject" | "textBody" | "from" | "to">>): Promise<Result<Signal, DbError>> {
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
      return ok(hydrateSignal(result.Attributes as unknown as Signal));
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
      gsi3pk?: string;
      threadId?: string;
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
    if (update.gsi3pk !== undefined) { setParts.push("gsi3pk = :gsi3pk"); exprValues[":gsi3pk"] = update.gsi3pk; }
    if (update.threadId !== undefined) { setParts.push("threadId = :threadId"); exprValues[":threadId"] = update.threadId; }

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
      return ok(hydrateSignal(result.Attributes as unknown as Signal));
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

  async listThreads(accountId: string, params: ListThreadsParams): Promise<Result<Page<Thread>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const gsi1pk = `ACCT#${accountId}`;

    try {
      let items: Thread[];
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
        items = (res.Items ?? []) as Thread[];
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
        items = results.flatMap(r => (r.Items ?? []) as Thread[]);
        items.sort((a, b) => b.lastSignalAt.localeCompare(a.lastSignalAt));
        lastKey = undefined;
      }

      if (params.workflow) items = items.filter((a) => a.workflow === params.workflow);
      if (params.label) items = items.filter((a) => a.labels.includes(params.label!));

      const page = items.slice(0, limit).map(hydrateThreadObject);
      const nextKey = items.length > limit && lastKey ? encodeCursor(lastKey) : null;
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Thread>);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listActiveThreadsBefore(accountId: string, beforeDate: string): Promise<Result<Thread[], DbError>> {
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
      return ok((res.Items ?? []).map(i => hydrateThreadObject(i as Thread)));
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
   * Find the calendar_event signal on a thread that is linked to a given email signal.
   * Returns null if no linked calendar signal exists.
   */
  async getLinkedCalendarSignal(accountId: string, threadId: string, emailSignalId: string): Promise<Result<Signal<CalendarEventData> | null, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": threadPk(accountId, threadId) },
        ScanIndexForward: false,
      }));
      const signals = (res.Items ?? []) as unknown[];
      const calendarSignal = signals.find(
        (s) => {
          const sig = s as { type?: string; data?: { linkedSignalId?: string } };
          return sig.type === "calendar_event" && sig.data?.linkedSignalId === emailSignalId;
        },
      );
      return ok(calendarSignal ? hydrateSignal(calendarSignal as unknown as Signal<CalendarEventData>) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /**
   * Find the most recent calendar_response signal on a thread for a given veventUid.
   * Returns the decision from the most recent response, or null if none exists.
   */
  async getLatestCalendarResponse(accountId: string, threadId: string, veventUid: string): Promise<Result<Signal<import("../types/calendar.js").CalendarResponseData> | null, DbError>> {
    try {
      // Query all signals on the thread (sorted newest-first via ScanIndexForward: false)
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": threadPk(accountId, threadId) },
        ScanIndexForward: false,
      }));
      const signals = (res.Items ?? []) as unknown[];
      const responseSignal = signals.find(
        (s) => {
          const sig = s as { type?: string; data?: { veventUid?: string } };
          return sig.type === "calendar_response" && sig.data?.veventUid === veventUid;
        },
      );
      return ok(responseSignal ? hydrateSignal(responseSignal as unknown as Signal<import("../types/calendar.js").CalendarResponseData>) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listActiveThreads(accountId: string, limit: number): Promise<Result<Thread[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `ACCT#${accountId}`, ":prefix": "LASTACT#active#" },
        ScanIndexForward: false,
        Limit: limit,
      }));
      return ok((res.Items ?? []).map(i => hydrateThreadObject(i as Thread)));
    } catch (e) {
      return err(dbError(e));
    }
  }

  async batchGetThreads(accountId: string, threadIds: string[]): Promise<Result<Thread[], DbError>> {
    if (threadIds.length === 0) return ok([]);
    try {
      const keys = threadIds.map(id => ({ pk: threadPk(accountId, id), sk: ITEM_SK }));
      const res = await dynamo.send(new BatchGetCommand({
        RequestItems: { [SIGNALS_TABLE]: { Keys: keys } },
      }));
      const items = (res.Responses?.[SIGNALS_TABLE] ?? []) as Thread[];
      return ok(items.map(hydrateThreadObject));
    } catch (e) {
      return err(dbError(e));
    }
  }

  async countQuarantined(accountId: string): Promise<Result<number, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `ACCT#${accountId}#QUARANTINED` },
        Select: "COUNT",
      }));
      return ok(res.Count ?? 0);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
