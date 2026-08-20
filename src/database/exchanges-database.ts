import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, ACCOUNTS_TABLE } from "./shared.js";
import { dbError, ok, err } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import { generateId } from "../utils/id.js";
import type { ExternalMailExchange } from "../types/index.js";
import type { Logger } from "../logger.js";

const pk = (accountId: string) => `ACCT#${accountId}`;

export class ExchangesDatabase {
  constructor(private readonly logger: Logger) {}

  async createExternalExchange(accountId: string, data: {
    platform: ExternalMailExchange["platform"];
    emailAddress: string;
    status: ExternalMailExchange["status"];
    nextSyncTime: string;
    syncCursor?: string;
    syncState?: Record<string, unknown>;
    lastSyncAt: string;
    expiresAt?: string;
    providerSubscriptionId?: string;
    userId?: string;
    connectionUserId?: string;
    connectionId?: string;
    errorReason?: string;
    imapConfig?: ExternalMailExchange["imapConfig"];
    jmapConfig?: ExternalMailExchange["jmapConfig"];
  }): Promise<Result<ExternalMailExchange, DbError>> {
    const now = DateTime.utc().toISO()!;
    const id = generateId("emx-");
    const item: ExternalMailExchange = {
      id,
      accountId,
      platform: data.platform,
      emailAddress: data.emailAddress,
      status: data.status,
      nextSyncTime: data.nextSyncTime,
      lastSyncAt: data.lastSyncAt,
      ...(data.syncCursor !== undefined ? { syncCursor: data.syncCursor } : {}),
      ...(data.syncState !== undefined ? { syncState: data.syncState } : {}),
      ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
      ...(data.providerSubscriptionId !== undefined ? { providerSubscriptionId: data.providerSubscriptionId } : {}),
      ...(data.userId !== undefined ? { userId: data.userId } : {}),
      ...(data.connectionUserId !== undefined ? { connectionUserId: data.connectionUserId } : {}),
      ...(data.connectionId !== undefined ? { connectionId: data.connectionId } : {}),
      ...(data.errorReason !== undefined ? { errorReason: data.errorReason } : {}),
      ...(data.imapConfig !== undefined ? { imapConfig: data.imapConfig } : {}),
      ...(data.jmapConfig !== undefined ? { jmapConfig: data.jmapConfig } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const dynamoItem: Record<string, unknown> = {
      ...item,
      pk: pk(accountId),
      sk: `EMX#${id}`,
      gsi1pk: `EMX#${data.status}`,
      gsi1sk: `${data.nextSyncTime}#${id}`,
    };
    try {
      await dynamo.send(new PutCommand({ TableName: ACCOUNTS_TABLE, Item: dynamoItem }));
      return ok(item);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getExternalExchange(accountId: string, emxId: string): Promise<Result<ExternalMailExchange | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `EMX#${emxId}` },
      }));
      return ok(res.Item as ExternalMailExchange | undefined ?? null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listExternalExchanges(accountId: string): Promise<Result<ExternalMailExchange[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "EMX#" },
      }));
      return ok((res.Items ?? []) as ExternalMailExchange[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateExternalExchange(accountId: string, emxId: string, status: ExternalMailExchange["status"], nextSyncTime: string, fields: Partial<Pick<ExternalMailExchange, "syncCursor" | "syncState" | "expiresAt" | "lastSyncAt" | "userId" | "connectionUserId" | "connectionId" | "consecutiveFailures" | "imapConfig" | "jmapConfig">> & { errorReason?: string; pushSubscriptionId?: string; providerSubscriptionId?: string; encryptionCertificateId?: string }, clearFields?: Array<"errorReason" | "providerSubscriptionId" | "pushSubscriptionId" | "encryptionCertificateId">): Promise<Result<ExternalMailExchange, DbError>> {
    const now = DateTime.utc().toISO()!;
    const names: Record<string, string> = { "#updatedAt": "updatedAt", "#status": "status", "#nextSyncTime": "nextSyncTime" };
    const values: Record<string, unknown> = { ":updatedAt": now, ":status": status, ":nextSyncTime": nextSyncTime };
    const setParts = ["#updatedAt = :updatedAt", "#status = :status", "#nextSyncTime = :nextSyncTime"];
    const removeParts: string[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }
      names[`#${key}`] = key;
      values[`:${key}`] = value;
      setParts.push(`#${key} = :${key}`);
    }

    // Explicit field removal via clearFields
    if (clearFields) {
      for (const key of clearFields) {
        names[`#${key}`] = key;
        removeParts.push(`#${key}`);
      }
    }

    // GSI1 management: always reflect status + nextSyncTime
    names["#gsi1pk"] = "gsi1pk";
    names["#gsi1sk"] = "gsi1sk";
    values[":gsi1pk"] = `EMX#${status}`;
    values[":gsi1sk"] = `${nextSyncTime}#${emxId}`;
    setParts.push("#gsi1pk = :gsi1pk", "#gsi1sk = :gsi1sk");

    let expression = `SET ${setParts.join(", ")}`;
    if (removeParts.length > 0) {
      expression += ` REMOVE ${removeParts.join(", ")}`;
    }

    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `EMX#${emxId}` },
        UpdateExpression: expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }));
      return ok(res.Attributes as ExternalMailExchange);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteExternalExchange(accountId: string, emxId: string): Promise<Result<void, DbError>> {
    try {
      await dynamo.send(new DeleteCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `EMX#${emxId}` },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listExchangesDue(horizon: string): Promise<Result<ExternalMailExchange[], DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "#gsi1pk = :pk AND #gsi1sk < :horizon",
        ExpressionAttributeNames: { "#gsi1pk": "gsi1pk", "#gsi1sk": "gsi1sk" },
        ExpressionAttributeValues: { ":pk": "EMX#active", ":horizon": `${horizon}~` },
      }));
      return ok((res.Items ?? []) as ExternalMailExchange[]);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async findExternalExchangeBySubscriptionId(subscriptionId: string): Promise<Result<ExternalMailExchange | null, DbError>> {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    let pageCount = 0;
    try {
      do {
        pageCount++;
        const res = await dynamo.send(new QueryCommand({
          TableName: ACCOUNTS_TABLE,
          IndexName: "gsi1",
          KeyConditionExpression: "#gsi1pk = :pk",
          FilterExpression: "#providerSubscriptionId = :subId",
          ExpressionAttributeNames: { "#gsi1pk": "gsi1pk", "#providerSubscriptionId": "providerSubscriptionId" },
          ExpressionAttributeValues: { ":pk": "EMX#active", ":subId": subscriptionId },
          ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
        }));
        const items = (res.Items ?? []) as ExternalMailExchange[];
        if (items.length > 0) {
          if (pageCount > 3) {
            this.logger.warn("findExternalExchangeBySubscriptionId required excessive pagination", { code: "emx.db.subscription_scan_slow", subscriptionId, pageCount, found: true });
          }
          return ok(items[0]!);
        }
        lastEvaluatedKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastEvaluatedKey);

      if (pageCount > 3) {
        this.logger.warn("findExternalExchangeBySubscriptionId required excessive pagination", { code: "emx.db.subscription_scan_slow", subscriptionId, pageCount, found: false });
      }
      return ok(null);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
