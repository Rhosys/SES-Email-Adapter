import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AuditDatabase } from "../database/audit-database.js";
import type { PageParams } from "../types/index.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export class AuditApi {
  constructor(private readonly auditDb: AuditDatabase) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { auditDb } = this;

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/audit",
      tags: ["Audit"],
      request: {
        params: z.object({ accountId: z.string() }),
        query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }),
      },
      middleware: [authz("audit:read", c => `accounts/${c.req.param("accountId")!}/audit`)] as const,
      responses: { 200: { content: { "application/json": { schema: z.object({}) } }, description: "List audit events" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const cursor = c.req.query("cursor");
      const rawLimit = c.req.query("limit");
      const params: PageParams = { ...(cursor ? { cursor } : {}), ...(rawLimit ? { limit: parseInt(rawLimit, 10) } : {}) };
      const result = await auditDb.listAuditEvents(accountId, params);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(result.value, 200);
    });
  }
}
