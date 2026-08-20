import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, ACCOUNTS_TABLE } from "./shared.js";
import { dbError, ok, err } from "../errors.js";
import type { Result, DbError } from "../errors.js";
import { generateId } from "../utils/id.js";
import type { ExternalMailExchange } from "../types/index.js";

const pk = (accountId: string) => `ACCT#${accountId}`;

export class ExchangesDatabase {
  async createExternalExchange(accountId: string, data: {
    platform: ExternalMailExchange["platform"];
    emailAddress: string;
    status: ExternalMailExchange["status"];
    syncCursor?: string;
    syncState?: Record<string, unknown>;
    lastSyncAt: string;
    nextSyncTime?: string;
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
      lastSyncAt: data.lastSyncAt,
      ...(data.syncCursor !== undefined ? { syncCursor: data.syncCursor } : {}),
      ...(data.syncState !== undefined ? { syncState: data.syncState } : {}),
      ...(data.nextSyncTime !== undefined ? { nextSyncTime: data.nextSyncTime } : {}),
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
    const dynamoItem: Record<string, unknown> = { ...item, pk: pk(accountId), sk: `EMX#${id}` };
    if (data.status === "active") {
      const sortValue = data.nextSyncTime ?? data.expiresAt;
      if (sortValue) {
        dynamoItem.gsi1pk = "EMX#active";
        dynamoItem.gsi1sk = `${sortValue}#${id}`;
      }
    }
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

  async updateExternalExchange(accountId: string, emxId: string, fields: Partial<Pick<ExternalMailExchange, "status" | "syncCursor" | "syncState" | "expiresAt" | "lastSyncAt" | "nextSyncTime" | "userId" | "connectionUserId" | "connectionId" | "consecutiveFailures">> & { errorReason?: string; pushSubscriptionId?: string; providerSubscriptionId?: string; encryptionCertificateId?: string }, clearFields?: Array<"errorReason" | "providerSubscriptionId" | "pushSubscriptionId" | "encryptionCertificateId">): Promise<Result<ExternalMailExchange, DbError>> {
    const now = DateTime.utc().toISO()!;
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Record<string, unknown> = { ":updatedAt": now };
    const setParts = ["#updatedAt = :updatedAt"];
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

    // GSI1 management: populate when active, remove otherwise
    if (fields.status === "active" && (fields.expiresAt || fields.nextSyncTime)) {
      const sortValue = fields.nextSyncTime ?? fields.expiresAt!;
      names["#gsi1pk"] = "gsi1pk";
      names["#gsi1sk"] = "gsi1sk";
      values[":gsi1pk"] = "EMX#active";
      values[":gsi1sk"] = `${sortValue}#${emxId}`;
      setParts.push("#gsi1pk = :gsi1pk", "#gsi1sk = :gsi1sk");
    } else if (fields.status && fields.status !== "active") {
      names["#gsi1pk"] = "gsi1pk";
      names["#gsi1sk"] = "gsi1sk";
      removeParts.push("#gsi1pk", "#gsi1sk");
    } else if ((fields.expiresAt || fields.nextSyncTime) && !fields.status) {
      // Renewal: update gsi1sk with new time (keep gsi1pk)
      const sortValue = fields.nextSyncTime ?? fields.expiresAt!;
      names["#gsi1sk"] = "gsi1sk";
      values[":gsi1sk"] = `${sortValue}#${emxId}`;
      setParts.push("#gsi1sk = :gsi1sk");
    }

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

  async updateExternalExchangeImapConfig(accountId: string, emxId: string, config: { host: string; tlsConfig: "TLS" | "DISABLED"; username: string; encryptedPassword: string }): Promise<Result<ExternalMailExchange, DbError>> {
    const now = DateTime.utc().toISO()!;
    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `EMX#${emxId}` },
        UpdateExpression: "SET #updatedAt = :updatedAt, #imapConfig = :config",
        ExpressionAttributeNames: { "#updatedAt": "updatedAt", "#imapConfig": "imapConfig" },
        ExpressionAttributeValues: { ":updatedAt": now, ":config": config },
        ReturnValues: "ALL_NEW",
      }));
      return ok(res.Attributes as ExternalMailExchange);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async updateExternalExchangeJmapConfig(accountId: string, emxId: string, config: { sessionUrl: string; username: string; encryptedPassword: string; apiUrl: string; downloadUrl: string; jmapAccountId: string; inboxId: string }): Promise<Result<ExternalMailExchange, DbError>> {
    const now = DateTime.utc().toISO()!;
    try {
      const res = await dynamo.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { pk: pk(accountId), sk: `EMX#${emxId}` },
        UpdateExpression: "SET #updatedAt = :updatedAt, #jmapConfig = :config",
        ExpressionAttributeNames: { "#updatedAt": "updatedAt", "#jmapConfig": "jmapConfig" },
        ExpressionAttributeValues: { ":updatedAt": now, ":config": config },
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

  async findExternalExchangeByEmail(accountId: string, emailAddress: string): Promise<Result<ExternalMailExchange | null, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        FilterExpression: "#emailAddress = :emailAddress",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#emailAddress": "emailAddress" },
        ExpressionAttributeValues: { ":pk": pk(accountId), ":prefix": "EMX#", ":emailAddress": emailAddress },
      }));
      const items = (res.Items ?? []) as ExternalMailExchange[];
      return ok(items[0] ?? null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async findExternalExchangeBySubscriptionId(subscriptionId: string): Promise<Result<ExternalMailExchange | null, DbError>> {
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: "#gsi1pk = :pk",
        FilterExpression: "#providerSubscriptionId = :subId",
        ExpressionAttributeNames: { "#gsi1pk": "gsi1pk", "#providerSubscriptionId": "providerSubscriptionId" },
        ExpressionAttributeValues: { ":pk": "EMX#active", ":subId": subscriptionId },
      }));
      const items = (res.Items ?? []) as ExternalMailExchange[];
      return ok(items[0] ?? null);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
