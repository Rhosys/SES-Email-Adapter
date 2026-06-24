import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AuditDatabase } from "../database/audit-database.js";
import type { PageParams } from "../types/index.js";
import type { AppEnv } from "./app.js";
import { ErrorCode } from "./schemas.js";

type ErrorCodeLiteral = z.infer<typeof ErrorCode>;

export interface AuditApiDeps {
  auditDb: AuditDatabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authz: (permission: string, resourceUri: string | ((c: Context<AppEnv>) => string)) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  err: (c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 501 | 503, title: string, errorCode?: ErrorCodeLiteral, details?: unknown) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: (config: any) => any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAuditRoutes(app: OpenAPIHono<any>, deps: AuditApiDeps): void {
  const { auditDb, authz, err, route } = deps;

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
