import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Result } from "neverthrow";
import type { NotFoundError } from "../errors.js";
import { zParse } from "./validate.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

// ---------------------------------------------------------------------------
// Job Dispatcher interface (used by reindex route)
// ---------------------------------------------------------------------------

export interface JobDispatcher {
  dispatch(targetRegistryId: string, segmentCount?: number): Promise<Result<{
    jobId: string; targetRegistryId: string; modelId: string; segmentCount: number; startedAt: string;
  }, NotFoundError>>;
}

const ReindexRequest = z.object({
  targetRegistryId: z.string(),
  segmentCount: z.number().int().min(1).max(256).optional(),
});

export class AdminApi {
  constructor(private readonly jobDispatcher: JobDispatcher) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { jobDispatcher } = this;

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
}
