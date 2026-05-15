import { randomUUID } from "crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, AUDIT_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Page, PageParams } from "../types/index.js";

export type AuditResourceType =
  | "rule"
  | "alias"
  | "domain"
  | "account"
  | "label"
  | "view"
  | "template"
  | "forwarding_address";

export type AuditAction = "created" | "updated" | "deleted" | "reordered";

export interface AuditEvent {
  eventId: string;
  accountId: string;
  userId: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  timestamp: string;
  before?: unknown;
  after?: unknown;
  ttl?: number;
}

// Key design:
// PK  = AUDIT#<accountId>
// SK  = <resourceType>#<resourceId>#<timestamp>#<eventId>   (resource-scoped range; use begins_with for history)
// GSI1PK = AUDIT#<accountId>
// GSI1SK = <timestamp>#<eventId>                            (time-ordered account activity feed)

export class AuditDatabase {
  async saveAuditEvent(event: Omit<AuditEvent, "eventId" | "timestamp">): Promise<Result<void, DbError>> {
    const timestamp = new Date().toISOString();
    const eventId = randomUUID();
    const item: AuditEvent = { ...event, eventId, timestamp };
    try {
      await dynamo.send(new PutCommand({
        TableName: AUDIT_TABLE,
        Item: {
          ...item,
          pk: `AUDIT#${event.accountId}`,
          sk: `${event.resourceType}#${event.resourceId}#${timestamp}#${eventId}`,
          gsi1pk: `AUDIT#${event.accountId}`,
          gsi1sk: `${timestamp}#${eventId}`,
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // Time-ordered feed for the account — uses GSI1
  async listAuditEvents(accountId: string, params: PageParams): Promise<Result<Page<AuditEvent>, DbError>> {
    const limit = Math.min(params.limit ?? 50, 200);
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: AUDIT_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `AUDIT#${accountId}` },
        ScanIndexForward: false,
        Limit: limit + 1,
        ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
      }));
      const items = (res.Items ?? []) as AuditEvent[];
      const page = items.slice(0, limit);
      const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<AuditEvent>);
    } catch (e) {
      return err(dbError(e));
    }
  }

  // History for a specific resource — uses main table SK with begins_with
  async listResourceHistory(accountId: string, resourceType: AuditResourceType, resourceId: string): Promise<Result<AuditEvent[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: AUDIT_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `AUDIT#${accountId}`,
          ":prefix": `${resourceType}#${resourceId}#`,
        },
        ScanIndexForward: false,
      }));
      return ok((res.Items ?? []) as AuditEvent[]);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
