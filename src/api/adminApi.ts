import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { JobDispatcher, AppEnv } from "./app.js";
import { zParse } from "./validate.js";
import { ErrorCode } from "./schemas.js";

type ErrorCodeLiteral = z.infer<typeof ErrorCode>;

export interface AdminApiDeps {
  jobDispatcher: JobDispatcher;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authz: (permission: string, resourceUri: string | ((c: Context<AppEnv>) => string)) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  err: (c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 501 | 503, title: string, errorCode?: ErrorCodeLiteral, details?: unknown) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: (config: any) => any;
}

const ReindexRequest = z.object({
  targetRegistryId: z.string(),
  segmentCount: z.number().int().min(1).max(256).optional(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAdminRoutes(app: OpenAPIHono<any>, deps: AdminApiDeps): void {
  const { jobDispatcher, authz, err, route } = deps;

  app.openapi(route({
    method: "post",
    path: "/reindex",
    tags: ["Admin"],
    request: {
      body: { content: { "application/json": { schema: ReindexRequest } } },
    },
    middleware: [authz("accounts:write", "accounts")] as const,
    responses: {
      202: { content: { "application/json": { schema: z.object({
        jobId: z.string(),
        targetRegistryId: z.string(),
        modelId: z.string(),
        segmentCount: z.number(),
        startedAt: z.string(),
      }) } }, description: "Reindex job dispatched" },
    },
  }), async (c) => {
    const body = await zParse(ReindexRequest, c.req.raw);
    const result = await jobDispatcher.dispatch(body.targetRegistryId, body.segmentCount);
    if (result.isErr()) return err(c, 404, "Cluster not found");
    return c.json(result.value, 202);
  });
}
