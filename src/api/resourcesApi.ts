import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { toApiResource, decodeResourceId } from "./transform.js";
import type { Workflow, ResourceStatus } from "../types/index.js";
import type { ListResourcesParams, ResourceDatabase } from "../database/resource-database.js";
import type { Logger } from "../logger.js";
import { Resource as ResourceSchema, ListResourcesResponse } from "./schemas.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import type { Pagination } from "../types/index.js";

function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: Pagination } {
  return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: Pagination };
}

// Read-only — resources are system-derived from signals, never created/edited directly via the API.
export class ResourcesApi {
  constructor(
    private readonly resourceDb: ResourceDatabase,
    private readonly logger: Logger,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { resourceDb, logger } = this;

    // -------------------------------------------------------------------------
    // 1. GET /accounts/{accountId}/resources — list resources, scoped by workflow+status
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/resources",
      tags: ["Resources"],
      request: {
        params: z.object({ accountId: z.string() }),
        query: z.object({
          workflow: z.string(),
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
      if (!workflow) return err(c, 400, "workflow query parameter is required");
      const status = (query["status"] ?? "active") as ResourceStatus;
      const params: ListResourcesParams = {
        ...(query["dateFrom"] ? { dateFrom: query["dateFrom"] } : {}),
        ...(query["dateTo"] ? { dateTo: query["dateTo"] } : {}),
        ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        ...(query["limit"] ? { limit: parseInt(query["limit"], 10) } : {}),
      };
      const result = await resourceDb.listResources(accountId, workflow as Workflow, status, params);
      if (result.isErr()) {
        logger.error("Failed to list resources.", { code: "api.resources.list_failed", error: result.error });
        return err(c, 500, "Internal Server Error");
      }
      return c.json(page("resources", result.value.items.map(toApiResource), result.value.nextCursor), 200);
    });

    // -------------------------------------------------------------------------
    // 2. GET /accounts/{accountId}/resources/{resourceId} — get one resource
    // -------------------------------------------------------------------------
    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/resources/{resourceId}",
      tags: ["Resources"],
      request: { params: z.object({ accountId: z.string(), resourceId: z.string() }) },
      middleware: [authz("resources:read", c => `accounts/${c.req.param("accountId")!}/resources`)] as const,
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
      return c.json(toApiResource(result.value), 200);
    });
  }
}
