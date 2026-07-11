import { UpdateCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, RESOURCES_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Resource, ResourceStatus, Workflow, Page, PageParams } from "../types/index.js";

// Key design:
// PK  = ACCT#<accountId>#THREAD#<threadId>
// SK  = <workflow>#<resourceKey>                              (deterministic — no read-before-write needed)
// GSI1PK = ACCT#<accountId>#STATUS#<status>#WORKFLOW#<workflow>
// GSI1SK = <expectedResolutionDate>                            (ISO 8601 — sorts/ranges correctly as a string)

const threadPk = (accountId: string, threadId: string) => `ACCT#${accountId}#THREAD#${threadId}`;
const buildGsi1pk = (accountId: string, status: ResourceStatus, workflow: Workflow) =>
  `ACCT#${accountId}#STATUS#${status}#WORKFLOW#${workflow}`;

export interface SaveResourceParams {
  accountId: string;
  threadId: string;
  workflow: Workflow;
  resourceKey: string;
  expectedResolutionDate: string;
  terminal: boolean;
  ttl?: number;
}

export interface ListResourcesParams extends PageParams {
  // Native gsi1sk range query on expectedResolutionDate — e.g. "packages arriving in the next 3 days".
  dateFrom?: string;
  dateTo?: string;
}

export class ResourceDatabase {
  // Deterministic sk means this is always the right item to write to — no lookup,
  // no upsert branching. A later signal for the same (threadId, workflow, resourceKey)
  // just overwrites status/date/ttl in place via the same key.
  async saveResource(params: SaveResourceParams): Promise<Result<Resource, DbError>> {
    const { accountId, threadId, workflow, resourceKey, expectedResolutionDate, terminal, ttl } = params;
    const now = DateTime.utc().toISO()!;
    const status: ResourceStatus = terminal ? "complete" : "active";
    const sk = `${workflow}#${resourceKey}`;

    const setParts: string[] = [
      "createdAt = if_not_exists(createdAt, :now)",
      "accountId = :accountId",
      "threadId = :threadId",
      "workflow = :workflow",
      "resourceKey = :resourceKey",
      "#status = :status",
      "expectedResolutionDate = :erd",
      "updatedAt = :now",
      "gsi1pk = :gsi1pk",
      "gsi1sk = :erd",
    ];
    const exprNames: Record<string, string> = { "#status": "status" };
    const exprValues: Record<string, unknown> = {
      ":now": now,
      ":accountId": accountId,
      ":threadId": threadId,
      ":workflow": workflow,
      ":resourceKey": resourceKey,
      ":status": status,
      ":erd": expectedResolutionDate,
      ":gsi1pk": buildGsi1pk(accountId, status, workflow),
    };

    // Handles reactivation — e.g. a "return" signal arriving after a prior "delivered" completion.
    const removeParts: string[] = [];
    if (terminal) {
      setParts.push("resolvedAt = :now");
    } else {
      removeParts.push("resolvedAt");
    }
    if (ttl !== undefined) {
      setParts.push("#ttl = :ttl");
      exprNames["#ttl"] = "ttl";
      exprValues[":ttl"] = ttl;
    }

    let updateExpr = `SET ${setParts.join(", ")}`;
    if (removeParts.length > 0) updateExpr += ` REMOVE ${removeParts.join(", ")}`;

    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: RESOURCES_TABLE,
        Key: { pk: threadPk(accountId, threadId), sk },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }));
      return ok(result.Attributes as unknown as Resource);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async getResource(accountId: string, threadId: string, sk: string): Promise<Result<Resource | null, DbError>> {
    try {
      const res = await dynamo.send(new GetCommand({
        TableName: RESOURCES_TABLE,
        Key: { pk: threadPk(accountId, threadId), sk },
      }));
      return ok((res.Item as Resource) ?? null);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async listResources(
    accountId: string, workflow: Workflow, status: ResourceStatus, params: ListResourcesParams,
  ): Promise<Result<Page<Resource>, DbError>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const hasDateRange = params.dateFrom !== undefined && params.dateTo !== undefined;
    try {
      const res = await dynamo.send(new QueryCommand({
        TableName: RESOURCES_TABLE,
        IndexName: "gsi1",
        KeyConditionExpression: hasDateRange
          ? "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to"
          : "gsi1pk = :pk",
        ExpressionAttributeValues: {
          ":pk": buildGsi1pk(accountId, status, workflow),
          ...(hasDateRange ? { ":from": params.dateFrom, ":to": params.dateTo } : {}),
        },
        Limit: limit + 1,
        ...(params.cursor ? { ExclusiveStartKey: decodeCursor(params.cursor) } : {}),
      }));
      const items = (res.Items ?? []) as Resource[];
      const page = items.slice(0, limit);
      const nextKey = items.length > limit && res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null;
      return ok({ items: page, ...(nextKey ? { nextCursor: nextKey } : {}) } as Page<Resource>);
    } catch (e) {
      return err(dbError(e));
    }
  }
}
