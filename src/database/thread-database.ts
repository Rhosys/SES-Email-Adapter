import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, SIGNALS_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import type { ListThreadsParams } from "../api/app.js";
import type { Thread, Signal, AnySignal, OutboundEmailSignalData, Page, PageParams, ThreadStatus, ThreadUrgency, Workflow } from "../types/index.js";
import type { CalendarEventData, CalendarRsvpResponse } from "../types/calendar.js";
import { retentionTtl } from "../retention.js";
import { buildSignalGsi3pk } from "../processor/message-id.js";

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
  sender?: { address: string; name?: string | undefined };
  recipientAddress?: string;
  subject?: string;
  followupAt?: string;
}

/**
 * Narrow projection returned by findSignalByEmailMessageId — a Message-ID lookup resolves to the
 * thread a reply belongs on, so callers only need the signal's threading identity, not its body.
 */
export type ThreadedSignalRef = Pick<Signal, "id" | "signalLookupId" | "threadId" | "accountId" | "status" | "source" | "type">;

// ---------------------------------------------------------------------------
// Stale pending_send coercion — read-time only, DynamoDB record is NOT mutated
// ---------------------------------------------------------------------------

export const PENDING_SEND_STALE_HOURS = 4;

export function coerceStaleStatus<T extends Signal | AnySignal>(signal: T): T {
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

/** Resolve the thread identifier from a DDB record. */
function resolveThreadId(record: Record<string, unknown>): string | undefined {
  return record.threadId as string | undefined;
}

function hydrateThreadObject(record: Omit<Thread, "threadId"> & { threadId?: string }): Thread {
  const r = record as Record<string, unknown>;
  const threadId = resolveThreadId(r);
  // Migrate legacy senderAddress → sender object at read time
  const sender = (r.sender as Thread["sender"] | undefined) ?? (r.senderAddress ? { address: r.senderAddress as string } : undefined);
  return { ...record, threadId, ...(sender ? { sender } : {}) } as Thread;
}

// Threads with a stale/placeholder lastSignalAt (e.g. never-updated legacy records) don't
// represent real activity — excluded from every read path that returns threads to a caller.
function signalItem(signal: AnySignal): Record<string, unknown> {
  let gsi1pk: string;
  if (signal.threadId) {
    gsi1pk = threadPk(signal.accountId, signal.threadId);
  } else if (signal.status === "quarantine_visible" || signal.status === "quarantine_hidden") {
    gsi1pk = `ACCT#${signal.accountId}#QUARANTINED`;
  } else {
    gsi1pk = `ACCT#${signal.accountId}#BLOCKED`;
  }
  // TTL is derived state: always createdAt + retentionDuration. Compute it here at the write
  // boundary and assign it last so it is authoritative. Absent/infinite retention → no ttl
  // attribute → the item never expires.
  const ttl = retentionTtl(signal.retentionDuration, signal.createdAt);
  return {
    ...signal,
    pk: sigPk(signal.accountId, signal.signalLookupId),
    sk: ITEM_SK,
    gsi1pk,
    gsi1sk: signal.id,
    ttl, // authoritative — undefined omits the attribute (DynamoDB drops undefined values)
  };
}

const MIN_LAST_SIGNAL_AT = "2000-01-01T00:00:00.000Z";
function hasRecentSignal(thread: Thread): boolean {
  return thread.lastSignalAt >= MIN_LAST_SIGNAL_AT;
}

// ---------------------------------------------------------------------------
// hydrateSignal — defaults fields that may be absent on legacy DDB items
// ---------------------------------------------------------------------------

function hydrateSignal<T extends { labels?: unknown }>(item: T): T {
  if (!item.labels) { return { ...item, labels: [] }; }
  return item;
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

  async getSignalById(accountId: string, signalId: string, threadId: string): Promise<Result<AnySignal | null, DbError>> {
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
      return ok(items[0] ? coerceStaleStatus(hydrateSignal(items[0] as AnySignal)) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getSignalByMessageId(accountId: string, signalLookupId: string): Promise<Result<Signal | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
      }));
      return ok(res.Item ? coerceStaleStatus(hydrateSignal(res.Item as Signal)) : null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async findSignalByEmailMessageId(gsi3pk: string): Promise<Result<ThreadedSignalRef | null, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi3",
        KeyConditionExpression: "gsi3pk = :val",
        ExpressionAttributeValues: { ":val": gsi3pk },
      }));
      const items = res.Items ?? [];
      if (items.length === 0) return ok(null);
      // GSI3 has no sort key, so DynamoDB returns matches in arbitrary partition order. When a Message-ID
      // collides across multiple signals we must pick deterministically: choose the oldest by createdAt —
      // the thread the Message-ID was first associated with — so retries always resolve the same way.
      const ordered = [...items].sort((a, b) => String((a as Partial<Signal>).createdAt ?? "").localeCompare(String((b as Partial<Signal>).createdAt ?? "")));
      // Signals with a nullish threadId are blocked/quarantined — they aren't threaded yet, so they are
      // not up for reply-threading validation and cannot be a consequential collision. Exclude them entirely.
      const threaded = ordered.filter(i => (i as Partial<Signal>).threadId != null);
      if (threaded.length > 1) {
        // A Message-ID is supposed to be globally unique, so GSI3 should hold at most one threaded signal per
        // key. Compare the colliding signals to decide whether the duplicate is consequential: if every match
        // resolves to the same threadId, the threading outcome is identical no matter which we pick, so it
        // is benign. Only differing threadIds change where a reply lands — that is the real integrity bug.
        const collisions = threaded.map(i => {
          const s = i as Partial<Signal>;
          return { id: s.id, signalLookupId: s.signalLookupId, threadId: s.threadId, status: s.status, source: s.source, type: s.type, createdAt: s.createdAt };
        });
        const distinctThreadIds = new Set(collisions.map(c => c.threadId));
        const sameThread = distinctThreadIds.size <= 1;
        const context = { code: "thread_database.email_message_id_not_unique", gsi3pk, count: threaded.length, sameThread, collisions };
        if (sameThread) {
          // Benign: all matches point at the same thread. Log for visibility, no developer action required.
          this.logger.warn("Multiple signal records share one Message-ID but resolve to the same thread — threading is unaffected. Logged for visibility; no developer action required.", context);
        } else {
          // Consequential: the matches point at different threads, so which one wins changes the thread a reply
          // is attached to. We deterministically take the oldest by createdAt. DEVELOPER REVIEW REQUIRED.
          this.logger.error("DEVELOPER REVIEW REQUIRED: multiple signal records share one Message-ID but resolve to DIFFERENT threads — the oldest by createdAt was chosen, but this indicates a data integrity bug that must be investigated.", context);
        }
      }
      return ok(ordered[0] as ThreadedSignalRef);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async saveSignal(signal: AnySignal): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new PutCommand({ TableName: SIGNALS_TABLE, Item: signalItem(signal) }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  /**
   * Save a calendar_event snapshot, keeping the account's RSVP. Every invite/update/cancel for an
   * event shares one row (signalLookupId is stable per event), so a plain put would erase an RSVP
   * recorded against an earlier snapshot. The carried RSVP is guarded by a condition so an RSVP
   * written between the read and the put is re-read rather than lost.
   */
  async saveCalendarEventSignal(signal: Signal<CalendarEventData>): Promise<Result<void, DbError>> {
    const key = { pk: sigPk(signal.accountId, signal.signalLookupId), sk: ITEM_SK };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const existing = await dynamo.send(new GetCommand({ TableName: SIGNALS_TABLE, Key: key }));
        const prior = (existing.Item?.["data"] as { rsvpResponse?: CalendarRsvpResponse } | undefined)?.rsvpResponse;
        const { rsvpResponse: _ignored, ...data } = signal.data;
        await dynamo.send(new PutCommand({
          TableName: SIGNALS_TABLE,
          Item: signalItem({ ...signal, data: { ...data, ...(prior ? { rsvpResponse: prior } : {}) } }),
          ...(prior
            ? { ConditionExpression: "#data.rsvpResponse.respondedAt = :at", ExpressionAttributeValues: { ":at": prior.respondedAt } }
            : { ConditionExpression: "attribute_not_exists(#data.rsvpResponse)" }),
          ExpressionAttributeNames: { "#data": "data" },
        }));
        return ok(undefined);
      } catch (e) {
        if (e instanceof Error && e.name === "ConditionalCheckFailedException") continue;
        return err(dbError(e));
      }
    }
    return err(dbError(new Error("Calendar event RSVP kept changing while saving the event; giving up after 3 attempts.")));
  }

  /**
   * Record the account's RSVP on the calendar_event row. Returns false when the row no longer
   * exists (e.g. expired between the caller's read and this write).
   *
   * When the RSVP was actually relayed to the organizer, `sentRsvp` carries the outbound SES
   * messageId and its amazonses.com Message-ID form. Both are persisted so a later bounce of that
   * reply — arriving as an inbound DSN whose In-Reply-To is the Message-ID form — resolves back to
   * this event via gsi3pk, instead of being misclassified as untrusted inbound mail.
   */
  async setCalendarEventRsvp(
    accountId: string,
    signalLookupId: string,
    rsvpResponse: CalendarRsvpResponse,
    sentRsvp?: { sesMessageId: string; outboundMsgId: string },
  ): Promise<Result<boolean, DbError>> {
    const setParts = ["#data.rsvpResponse = :rsvp"];
    const exprValues: Record<string, unknown> = { ":rsvp": rsvpResponse };
    if (sentRsvp) {
      setParts.push("#data.sesMessageId = :smid", "gsi3pk = :gsi3pk");
      exprValues[":smid"] = sentRsvp.sesMessageId;
      exprValues[":gsi3pk"] = buildSignalGsi3pk(accountId, sentRsvp.outboundMsgId);
    }
    try {
      await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#data": "data" },
        ExpressionAttributeValues: exprValues,
      }));
      return ok(true);
    } catch (e) {
      if (e instanceof Error && e.name === "ConditionalCheckFailedException") return ok(false);
      return err(dbError(e));
    }
  }

  async createSignal(signal: Signal): Promise<Result<Signal, DbError>> {
    const saveResult = await this.saveSignal(signal);
    if (saveResult.isErr()) return err(saveResult.error);
    return ok(signal);
  }

  async listSignals(accountId: string, threadId: string, params: PageParams): Promise<Result<Page<AnySignal>, DbError>> {
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
      const items = (res.Items ?? []).map(i => hydrateSignal(i as AnySignal));
      const page = items.slice(0, limit);
      const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) });
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listPreThreadSignals(accountId: string, partition: "quarantined" | "blocked", params: PageParams): Promise<Result<Page<Signal>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const gsi1pk = partition === "blocked" ? `ACCT#${accountId}#BLOCKED` : `ACCT#${accountId}#QUARANTINED`;
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
      return ok(hydrateSignal(result.Attributes as Signal));
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
    // TTL is derived state, computed here from the thread's retention. Per the product invariant it
    // is set once at creation and never refreshed (updateThread deliberately leaves it untouched).
    const ttl = retentionTtl(thread.retentionDuration, thread.createdAt);
    try {
      const item: Record<string, unknown> = {
        ...thread,
        threadId: thread.id,
        pk: threadPk(thread.accountId, thread.id),
        sk: ITEM_SK,
        gsi1pk: `ACCT#${thread.accountId}`,
        gsi1sk: `LASTACT#${thread.status}#${thread.lastSignalAt}#${thread.id}`,
        ttl, // authoritative — undefined omits the attribute (removeUndefinedValues)
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
    if (update.sender !== undefined) { setParts.push("sender = :sender"); exprValues[":sender"] = update.sender; }
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
      return ok(hydrateThreadObject(result.Attributes as Thread));
    } catch (e) {
      return err(dbError(e));
    }
  }

  /**
   * Gives a thread a bounded sweep TTL when it has none — used when a thread is emptied by reprocess
   * so an infinite-retention orphan doesn't linger forever. if_not_exists keeps any existing
   * retention-derived ttl untouched, so the caller never reads the DB-internal ttl to decide.
   *
   * The attribute_exists(pk) guard is load-bearing: without it a bare UpdateItem VIVIFIES a partial
   * thread item (pk/sk/ttl, no status), which a later getThread reads back with an undefined status —
   * exactly the state that made updateThread emit an UpdateExpression referencing an undefined :status.
   * A vanished thread needs no TTL, so the conditional miss is a benign no-op.
   */
  async setThreadTtlFallback(accountId: string, threadId: string, fallbackTtl: number): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: threadPk(accountId, threadId), sk: ITEM_SK },
        UpdateExpression: "SET #ttl = if_not_exists(#ttl, :fallback)",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":fallback": fallbackTtl },
      }));
      return ok(undefined);
    } catch (e) {
      if (e instanceof Error && e.name === "ConditionalCheckFailedException") return ok(undefined);
      return err(dbError(e));
    }
  }

  async updateSignal(accountId: string, signalLookupId: string, update: Partial<Pick<OutboundEmailSignalData, "subject" | "textBody" | "from" | "to" | "cc" | "bcc">>): Promise<Result<Signal, DbError>> {
    const now = DateTime.utc().toISO()!;
    const setParts: string[] = ["updatedAt = :now"];
    const exprValues: Record<string, unknown> = { ":now": now };
    const exprNames: Record<string, string> = {};

    if (update.subject !== undefined) { setParts.push("#data.#subject = :subject"); exprValues[":subject"] = update.subject; exprNames["#subject"] = "subject"; exprNames["#data"] = "data"; }
    if (update.textBody !== undefined) { setParts.push("#data.textBody = :textBody"); exprValues[":textBody"] = update.textBody; exprNames["#data"] = "data"; }
    if (update.from !== undefined) { setParts.push("#data.#from = :from"); exprValues[":from"] = update.from; exprNames["#from"] = "from"; exprNames["#data"] = "data"; }
    if (update.to !== undefined) { setParts.push("#data.#to = :to"); exprValues[":to"] = update.to; exprNames["#to"] = "to"; exprNames["#data"] = "data"; }
    if (update.cc !== undefined) { setParts.push("#data.#cc = :cc"); exprValues[":cc"] = update.cc; exprNames["#cc"] = "cc"; exprNames["#data"] = "data"; }
    if (update.bcc !== undefined) { setParts.push("#data.bcc = :bcc"); exprValues[":bcc"] = update.bcc; exprNames["#data"] = "data"; }

    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: SIGNALS_TABLE,
        Key: { pk: sigPk(accountId, signalLookupId), sk: ITEM_SK },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ExpressionAttributeValues: exprValues,
        ...(Object.keys(exprNames).length ? { ExpressionAttributeNames: exprNames } : {}),
        ReturnValues: "ALL_NEW",
      }));
      return ok(hydrateSignal(result.Attributes as Signal));
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
      return ok(hydrateSignal(result.Attributes as Signal));
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
      items = items.filter(hasRecentSignal);

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

  /** List active threads created on or after `sinceDate` (ISO date string, e.g. "2026-07-28"), newest first. */
  async listActiveThreadsSince(accountId: string, sinceDate: string): Promise<Result<Thread[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: SIGNALS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk >= :start",
        ExpressionAttributeValues: {
          ":pk": `ACCT#${accountId}`,
          ":start": `LASTACT#active#${sinceDate}`,
        },
        ScanIndexForward: false,
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
      return ok(calendarSignal ? hydrateSignal(calendarSignal as Signal<CalendarEventData>) : null);
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
      return ok((res.Items ?? []).map(i => hydrateThreadObject(i as Thread)).filter(hasRecentSignal));
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
      return ok(items.map(hydrateThreadObject).filter(hasRecentSignal));
    } catch (e) {
      return err(dbError(e));
    }
  }

}
