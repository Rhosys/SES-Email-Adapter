import { UpdateCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";
import { dynamo, RESOURCES_TABLE, encodeCursor, decodeCursor } from "./shared.js";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Resource, ResourceAsset, ResourceStatus, Workflow, Page, PageParams } from "../types/index.js";

// Key design:
// PK  = ACCT#<accountId>#THREAD#<threadId>
// SK  = <workflow>#<resourceKey>                (deterministic — no read-before-write needed)
// GSI1PK = ACCT#<accountId>#STATUS#<status>      (not split by workflow — resource volume per
//          account+status+date-range is small; a "what's due today across all workflows" query
//          fans in for free, and a single-workflow view filters the (small) result set in the
//          API layer instead of paying for a narrower key)
// GSI1SK = <expectedResolutionDate>              (ISO 8601 — sorts/ranges correctly as a string)

const threadPk = (accountId: string, threadId: string) => `ACCT#${accountId}#THREAD#${threadId}`;
const buildGsi1pk = (accountId: string, status: ResourceStatus) => `ACCT#${accountId}#STATUS#${status}`;

export interface SaveResourceParams {
  accountId: string;
  threadId: string;
  workflow: Workflow;
  resourceKey: string;
  expectedResolutionDate: string;
  ttl?: number;
  assets?: ResourceAsset[];
}

export interface ListResourcesParams extends PageParams {
  // Native gsi1sk range query on expectedResolutionDate — e.g. "packages arriving in the next 3 days".
  dateFrom?: string;
  dateTo?: string;
}

export class ResourceDatabase {
  // Deterministic sk means this is always the right item to write to — no lookup,
  // no upsert branching. A later signal for the same (threadId, workflow, resourceKey)
  // overwrites the date/ttl in place via the same key. Completion is never inferred here:
  // #status/gsi1pk are only ever set on first creation (if_not_exists) — a signal can never
  // change a resource's status once it exists. Only setResourceStatus (an explicit user
  // action) changes status after creation.
  async saveResource(params: SaveResourceParams): Promise<Result<Resource, DbError>> {
    const { accountId, threadId, workflow, resourceKey, expectedResolutionDate, ttl, assets } = params;
    const now = DateTime.utc().toISO()!;
    const sk = `${workflow}#${resourceKey}`;

    const setParts: string[] = [
      "createdAt = if_not_exists(createdAt, :now)",
      "accountId = :accountId",
      "threadId = :threadId",
      "workflow = :workflow",
      "resourceKey = :resourceKey",
      "#status = if_not_exists(#status, :defaultStatus)",
      "expectedResolutionDate = :erd",
      "updatedAt = :now",
      "gsi1pk = if_not_exists(gsi1pk, :defaultGsi1pk)",
      "gsi1sk = :erd",
    ];
    const exprNames: Record<string, string> = { "#status": "status" };
    const exprValues: Record<string, unknown> = {
      ":now": now,
      ":accountId": accountId,
      ":threadId": threadId,
      ":workflow": workflow,
      ":resourceKey": resourceKey,
      ":defaultStatus": "active" satisfies ResourceStatus,
      ":erd": expectedResolutionDate,
      ":defaultGsi1pk": buildGsi1pk(accountId, "active"),
    };

    if (ttl !== undefined) {
      setParts.push("#ttl = :ttl");
      exprNames["#ttl"] = "ttl";
      exprValues[":ttl"] = ttl;
    }

    if (assets && assets.length > 0) {
      setParts.push("assets = list_append(if_not_exists(assets, :emptyList), :newAssets)");
      exprValues[":emptyList"] = [];
      exprValues[":newAssets"] = assets;
    }

    const updateExpr = `SET ${setParts.join(", ")}`;

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

  // The only way a resource's status changes after creation — an explicit user action
  // (e.g. PATCH /accounts/:id/resources/:resourceId). Unconditional on VALUE: always wins
  // over whatever saveResource last wrote, and a later saveResource call can never undo it
  // (its #status/gsi1pk writes are if_not_exists-guarded). Conditional on EXISTENCE: guarded
  // by attribute_exists(pk) so a row that vanished (e.g. TTL expiry) between the caller's
  // existence check and this write is never silently recreated as a malformed partial item —
  // callers get ok(null) instead, mirroring getResource's not-found shape.
  async setResourceStatus(accountId: string, threadId: string, sk: string, status: ResourceStatus): Promise<Result<Resource | null, DbError>> {
    const now = DateTime.utc().toISO()!;

    const setParts: string[] = ["#status = :status", "gsi1pk = :gsi1pk", "updatedAt = :now"];
    const removeParts: string[] = [];
    if (status === "complete") {
      setParts.push("resolvedAt = :now");
    } else {
      removeParts.push("resolvedAt");
    }

    let updateExpr = `SET ${setParts.join(", ")}`;
    if (removeParts.length > 0) updateExpr += ` REMOVE ${removeParts.join(", ")}`;

    try {
      const result = await dynamo.send(new UpdateCommand({
        TableName: RESOURCES_TABLE,
        Key: { pk: threadPk(accountId, threadId), sk },
        UpdateExpression: updateExpr,
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status, ":gsi1pk": buildGsi1pk(accountId, status), ":now": now },
        ReturnValues: "ALL_NEW",
      }));
      return ok(result.Attributes as unknown as Resource);
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") return ok(null);
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

  // Scoped by accountId+status only — spans every resource workflow in one query. Callers
  // that want a single workflow (or a fixed set, e.g. "today across package/travel/events")
  // filter the (small) result set themselves rather than paying for a narrower GSI key.
  async listResources(
    accountId: string, status: ResourceStatus, params: ListResourcesParams,
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
          ":pk": buildGsi1pk(accountId, status),
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
