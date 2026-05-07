import { randomUUID } from "crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, AUDIT_TABLE, encodeCursor, decodeCursor } from "./shared.js";
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

export class AuditDatabase {
  async saveAuditEvent(event: Omit<AuditEvent, "eventId" | "timestamp">): Promise<void> {
    const timestamp = new Date().toISOString();
    const eventId = randomUUID();
    const item: AuditEvent = { ...event, eventId, timestamp };
    await dynamo.send(new PutCommand({
      TableName: AUDIT_TABLE,
      Item: {
        ...item,
        pk: `AUDIT#${event.accountId}`,
        sk: `${timestamp}#${eventId}`,
        gsi1pk: `RESOURCE#${event.resourceType}#${event.resourceId}`,
        gsi1sk: timestamp,
      },
    }));
  }

  async listAuditEvents(accountId: string, params: PageParams): Promise<Page<AuditEvent>> {
    const limit = Math.min(params.limit ?? 50, 200);
    const res = await dynamo.send(new QueryCommand({
      TableName: AUDIT_TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `AUDIT#${accountId}` },
      ScanIndexForward: false,
      Limit: limit + 1,
      ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
    }));
    const items = (res.Items ?? []) as AuditEvent[];
    const page = items.slice(0, limit);
    const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
    return { items: page, ...(nextKey ? { nextCursor: nextKey } : {}) };
  }

  async listResourceHistory(resourceType: AuditResourceType, resourceId: string): Promise<AuditEvent[]> {
    const res = await dynamo.send(new QueryCommand({
      TableName: AUDIT_TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": `RESOURCE#${resourceType}#${resourceId}` },
      ScanIndexForward: false,
    }));
    return (res.Items ?? []) as AuditEvent[];
  }
}
