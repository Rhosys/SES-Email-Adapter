import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { zParse } from "./validate.js";
import { UpdateResourceRequest } from "./requests.js";
import { RESOURCE_WORKFLOWS, RESOURCE_STATUSES } from "../types/index.js";
import type { Resource as DbResource, ResourceWorkflow, ResourceStatus } from "../types/index.js";
import type { ListResourcesParams, ResourceDatabase } from "../database/resource-database.js";
import type { Logger } from "../logger.js";
import { Resource as ResourceSchema, ListResourcesResponse } from "./schemas.js";
import type * as Api from "./schemas.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import type { Pagination } from "../types/index.js";

// Public resource id is an opaque token encoding threadId + the item's own sk
// (workflow#resourceKey), so a direct-by-id lookup needs no secondary index —
// decode the id, reconstruct the DDB primary key, GetItem.
export function encodeResourceId(threadId: string, sk: string): string {
  return `res-${Buffer.from(`${threadId}:${sk}`).toString("base64url")}`;
}

function decodeResourceId(resourceId: string): { threadId: string; sk: string } | null {
  if (!resourceId.startsWith("res-")) return null;
  const decoded = Buffer.from(resourceId.slice(4), "base64url").toString("utf-8");
  const sepIndex = decoded.indexOf(":");
  if (sepIndex === -1) return null;
  return { threadId: decoded.slice(0, sepIndex), sk: decoded.slice(sepIndex + 1) };
}

// Assets backed by a stored file (pkpass) are exposed as a CDN download URL, never as a
// storage key — the API must not reveal where or how content is stored. Built the same way
// as signal attachment URLs so both surfaces serve the same object through one convention.
function toApiResource(resource: DbResource, contentCdnBaseUrl: string): Api.Resource {
  return {
    resourceId: encodeResourceId(resource.threadId, `${resource.workflow}#${resource.resourceKey}`),
    threadId: resource.threadId,
    workflow: resource.workflow as Api.Resource["workflow"],
    status: resource.status as Api.Resource["status"],
    expectedResolutionDate: resource.expectedResolutionDate,
    ...(resource.displayDate ? { displayDate: resource.displayDate } : {}),
    ...(resource.resolvedAt ? { resolvedAt: resource.resolvedAt } : {}),
    assets: (resource.assets ?? []).map(a => ({
      type: a.type as Api.ResourceAsset["type"],
      label: a.label,
      rawValue: a.rawValue,
      sourceSignalId: a.sourceSignalId,
      ...(a.s3Key ? { url: `${contentCdnBaseUrl}/${a.s3Key}` } : {}),
      extractedAt: a.extractedAt,
    })),
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

// Resources are system-derived from signals (never created via the API), but status is
// user-owned — PATCH is the only mutation, and the only thing it can change is status.
export class ResourcesApi {
  constructor(
    private readonly resourceDb: ResourceDatabase,
    private readonly logger: Logger,
    private readonly contentCdnBaseUrl: string,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { resourceDb, logger, contentCdnBaseUrl } = this;

    // -------------------------------------------------------------------------
    // 1. GET /accounts/{accountId}/resources — list resources, scoped by status, optionally
    //    filtered to one workflow. Omitting workflow spans every resource workflow in a single
    //    query (e.g. "everything due today/this week" for the UI banner) — the GSI is keyed by
    //    accountId+status only, so a workflow filter is applied to the result set here rather
    //    than narrowing the DB query.
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/resources",
      tags: ["Resources"],
      request: {
        params: z.object({ accountId: z.string() }),
        query: z.object({
          workflow: z.string().optional(),
          status: z.string().optional(),
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.string().optional(),
        }),
      },
      middleware: [authz("resources:read", c => `accounts/${c.req.param("accountId")!}/resources`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListResourcesResponse } }, description: "List resources" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const query = c.req.query();
      const workflow = query["workflow"];
      if (workflow !== undefined && !RESOURCE_WORKFLOWS.includes(workflow as ResourceWorkflow)) return err(c, 400, "Invalid workflow");
      const statusRaw = query["status"];
      if (statusRaw !== undefined && statusRaw !== "all" && !RESOURCE_STATUSES.includes(statusRaw as ResourceStatus)) return err(c, 400, "Invalid status");
      const params: ListResourcesParams = {
        ...(query["dateFrom"] ? { dateFrom: query["dateFrom"] } : {}),
        ...(query["dateTo"] ? { dateTo: query["dateTo"] } : {}),
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };

      // When no status is specified (or explicitly "all"), query both partitions in parallel
      // and merge by expectedResolutionDate. Pagination is not supported for the merged case.
      const statuses: ResourceStatus[] = (!statusRaw || statusRaw === "all")
        ? [...RESOURCE_STATUSES]
        : [statusRaw as ResourceStatus];

      const results = await Promise.all(statuses.map(s => resourceDb.listResources(accountId, s, params)));
      const firstError = results.find(r => r.isErr());
      if (firstError?.isErr()) {
        logger.error("Failed to list resources.", { code: "api.resources.list_failed", error: firstError.error });
        return err(c, 500, "Internal Server Error");
      }

      const merged = results.flatMap(r => (r.isOk() ? r.value.items : []));
      merged.sort((a, b) => a.expectedResolutionDate.localeCompare(b.expectedResolutionDate));
      const items = workflow ? merged.filter(r => r.workflow === workflow) : merged;
      const nextCursor = statuses.length === 1 && results[0]!.isOk() ? results[0]!.value.nextCursor : undefined;
      return c.json(page("resources", items.map(r => toApiResource(r, contentCdnBaseUrl)), nextCursor), 200);
    });

    // -------------------------------------------------------------------------
    // 1b. GET /accounts/{accountId}/threads/{threadId}/resources — all resources for a thread
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/threads/{threadId}/resources",
      tags: ["Resources"],
      request: { params: z.object({ accountId: z.string(), threadId: z.string() }) },
      middleware: [authz("resources:read", c => `accounts/${c.req.param("accountId")!}/threads/${c.req.param("threadId")!}/resources`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListResourcesResponse } }, description: "List resources for thread" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const threadId = c.req.param("threadId")!;
      const result = await resourceDb.listResourcesByThread(accountId, threadId);
      if (result.isErr()) {
        logger.error("Failed to list resources by thread.", { code: "api.resources.list_by_thread_failed", error: result.error });
        return err(c, 500, "Internal Server Error");
      }
      return c.json(page("resources", result.value.map(r => toApiResource(r, contentCdnBaseUrl))), 200);
    });

    // -------------------------------------------------------------------------
    // 2. GET /accounts/{accountId}/resources/{resourceId} — get one resource
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/resources/{resourceId}",
      tags: ["Resources"],
      request: { params: z.object({ accountId: z.string(), resourceId: z.string() }) },
      middleware: [authz("resources:read", c => `accounts/${c.req.param("accountId")!}/resources/${c.req.param("resourceId")!}`)] as const,
      responses: {
        200: { content: { "application/json": { schema: ResourceSchema } }, description: "Get resource" },
      },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const decoded = decodeResourceId(c.req.param("resourceId")!);
      if (!decoded) return err(c, 404, "Resource not found");
      const result = await resourceDb.getResource(accountId, decoded.threadId, decoded.sk);
      if (result.isErr()) {
        logger.error("Failed to get resource.", { code: "api.resources.get_failed", error: result.error });
        return err(c, 500, "Internal Server Error");
      }
      if (!result.value || result.value.accountId !== accountId) return err(c, 404, "Resource not found");
      return c.json(toApiResource(result.value, contentCdnBaseUrl), 200);
    });

    // -------------------------------------------------------------------------
    // 3. PATCH /accounts/{accountId}/resources/{resourceId} — set status (the only mutation)
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/resources/{resourceId}",
      tags: ["Resources"],
      request: { params: z.object({ accountId: z.string(), resourceId: z.string() }) },
      middleware: [authz("resources:write", c => `accounts/${c.req.param("accountId")!}/resources/${c.req.param("resourceId")!}`)] as const,
      responses: {
        200: { content: { "application/json": { schema: ResourceSchema } }, description: "Update resource status" },
      },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const resourceId = c.req.param("resourceId")!;
      logger.info("Updating resource status", { code: "api.resources.update", accountId, resourceId });
      const decoded = decodeResourceId(resourceId);
      if (!decoded) return err(c, 404, "Resource not found");

      const existingResult = await resourceDb.getResource(accountId, decoded.threadId, decoded.sk);
      if (existingResult.isErr()) {
        logger.error(`Failed to get resource for update: ${existingResult.error.message}`, { code: "api.resources.patch_get_failed", error: existingResult.error });
        return err(c, 500, "Internal Server Error");
      }
      if (!existingResult.value || existingResult.value.accountId !== accountId) return err(c, 404, "Resource not found");

      const body = await zParse(UpdateResourceRequest, c.req.raw);
      const result = await resourceDb.setResourceStatus(accountId, decoded.threadId, decoded.sk, body.status as ResourceStatus);
      if (result.isErr()) {
        logger.error(`Failed to update resource status: ${result.error.message}`, { code: "api.resources.patch_failed", error: result.error });
        return err(c, 500, "Internal Server Error");
      }
      // Row disappeared between the existence-check GET above and this write (e.g. TTL expiry) —
      // the ConditionExpression on setResourceStatus stopped it from being silently recreated.
      if (!result.value) return err(c, 404, "Resource not found");
      logger.info("Resource status updated", { code: "api.resources.updated", accountId, resourceId, status: body.status });
      return c.json(toApiResource(result.value, contentCdnBaseUrl), 200);
    });

  }
}
