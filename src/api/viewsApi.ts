import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { zParse } from "./validate.js";
import { CreateViewRequest, UpdateViewRequest } from "./requests.js";
import { View as ViewSchema, ListViewsResponse } from "./schemas.js";
import type * as Api from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { View as DbView } from "../types/index.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

function toApiView(view: DbView): Api.View {
  return {
    viewId: view.id,
    name: view.name,
    ...(view.icon ? { icon: view.icon } : {}),
    ...(view.color ? { color: view.color } : {}),
    ...(view.workflow ? { workflow: view.workflow as Api.View["workflow"] } : {}),
    labels: view.labels,
    sortField: view.sortField as Api.View["sortField"],
    sortDirection: view.sortDirection as Api.View["sortDirection"],
    position: view.position,
    ...(view.layout ? { layout: view.layout as unknown[] } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

export class ViewsApi {
  constructor(private readonly accountDb: AccountDatabase, private readonly logger: Logger) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, logger } = this;

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/views",
      tags: ["Views"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("views:read", c => `accounts/${c.req.param("accountId")!}/views`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListViewsResponse } }, description: "List views" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const viewsResult = await accountDb.listViews(accountId);
      if (viewsResult.isErr()) { logger.error("Failed to list views", { code: "api.views.list_failed", error: viewsResult.error }); return err(c, 500, "Internal Server Error"); }
      return c.json({ views: viewsResult.value.map(toApiView) }, 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/views",
      tags: ["Views"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("views:write", c => `accounts/${c.req.param("accountId")!}/views`)] as const,
      responses: { 201: { content: { "application/json": { schema: ViewSchema } }, description: "View created" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      logger.info("Creating view", { code: "api.views.create", accountId });
      const body = await zParse(CreateViewRequest, c.req.raw);
      const viewResult = await accountDb.createView(accountId, body);
      if (viewResult.isErr()) { logger.error("Failed to create view", { code: "api.views.create_failed", error: viewResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("View created", { code: "api.views.created", accountId, viewId: viewResult.value.id });
      return c.json(toApiView(viewResult.value), 201);
    });

    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/views/{id}",
      tags: ["Views"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("views:write", c => `accounts/${c.req.param("accountId")!}/views/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: ViewSchema } }, description: "Update view" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const viewId = c.req.param("id")!;
      logger.info("Updating view", { code: "api.views.update", accountId, viewId });
      const viewResult = await accountDb.getView(accountId, viewId);
      if (viewResult.isErr()) { logger.error("Failed to get view for patch", { code: "api.views.patch.get_failed", error: viewResult.error }); return err(c, 500, "Internal Server Error"); }
      const view = viewResult.value;
      if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
      const body = await zParse(UpdateViewRequest, c.req.raw);
      const updateResult = await accountDb.updateView(accountId, view.id, body);
      if (updateResult.isErr()) { logger.error("Failed to update view", { code: "api.views.patch.update_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("View updated", { code: "api.views.updated", accountId, viewId });
      return c.json(toApiView(updateResult.value), 200);
    });

    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/views/{id}",
      tags: ["Views"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("views:write", c => `accounts/${c.req.param("accountId")!}/views/${c.req.param("id")!}`)] as const,
      responses: { 204: { description: "View deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const viewId = c.req.param("id")!;
      logger.info("Deleting view", { code: "api.views.delete", accountId, viewId });
      const viewResult = await accountDb.getView(accountId, viewId);
      if (viewResult.isErr()) { logger.error("Failed to get view for delete", { code: "api.views.delete.get_failed", error: viewResult.error }); return err(c, 500, "Internal Server Error"); }
      const view = viewResult.value;
      if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
      const deleteResult = await accountDb.deleteView(accountId, view.id);
      if (deleteResult.isErr()) { logger.error("Failed to delete view", { code: "api.views.delete_failed", error: deleteResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("View deleted", { code: "api.views.deleted", accountId, viewId });
      return new Response(null, { status: 204 });
    });
  }
}
