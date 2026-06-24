import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { zParse } from "./validate.js";
import { toApiView } from "./transform.js";
import { CreateViewRequest, UpdateViewRequest } from "./requests.js";
import { View as ViewSchema, ListViewsResponse } from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export class ViewsApi {
  constructor(private readonly accountDb: AccountDatabase) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb } = this;

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
      if (viewsResult.isErr()) return err(c, 500, "Internal Server Error");
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
      const body = await zParse(CreateViewRequest, c.req.raw);
      const viewResult = await accountDb.createView(accountId, body);
      if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
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
      const viewResult = await accountDb.getView(accountId, c.req.param("id")!);
      if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
      const view = viewResult.value;
      if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
      const body = await zParse(UpdateViewRequest, c.req.raw);
      const updateResult = await accountDb.updateView(accountId, view.id, body);
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
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
      const viewResult = await accountDb.getView(accountId, c.req.param("id")!);
      if (viewResult.isErr()) return err(c, 500, "Internal Server Error");
      const view = viewResult.value;
      if (!view) return err(c, 404, "View not found", "VIEW_NOT_FOUND");
      const deleteResult = await accountDb.deleteView(accountId, view.id);
      if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
      return new Response(null, { status: 204 });
    });
  }
}
