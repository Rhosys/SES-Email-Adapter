import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { AccountDatabase } from "../database/account-database.js";
import type { IUserConfiguration } from "../types/index.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import { UserConfiguration } from "./schemas.js";
import { UpdateUserConfigurationRequest } from "./requests.js";
import { zParse } from "./validate.js";

export class UserApi {
  private readonly accountDb: AccountDatabase;

  constructor(accountDb: AccountDatabase) {
    this.accountDb = accountDb;
  }

  register(app: OpenAPIHono<AppEnv>, { err, route }: RouteHelpers) {
    // GET /user/:userId/configuration
    const getConfigRoute = route({
      method: "get",
      path: "/user/{userId}/configuration",
      request: { params: z.object({ userId: z.string() }) },
      responses: {
        200: { content: { "application/json": { schema: UserConfiguration } }, description: "User configuration" },
      },
    });

    app.openapi(getConfigRoute, async (c) => {
      const jwtUserId = c.var.auth.userId;
      const pathUserId = c.req.param("userId");
      if (jwtUserId !== pathUserId) return err(c, 403, "Forbidden");
      c.set("authorizationVerified", true);

      const result = await this.accountDb.getUserConfiguration(jwtUserId);
      if (result.isErr()) return err(c, 500, "Internal server error");
      return c.json(result.value, 200);
    });

    // PATCH /user/:userId/configuration
    const patchConfigRoute = route({
      method: "patch",
      path: "/user/{userId}/configuration",
      request: {
        params: z.object({ userId: z.string() }),
      },
      responses: {
        200: { content: { "application/json": { schema: UserConfiguration } }, description: "Updated user configuration" },
      },
    });

    app.openapi(patchConfigRoute, async (c) => {
      const jwtUserId = c.var.auth.userId;
      const pathUserId = c.req.param("userId");
      if (jwtUserId !== pathUserId) return err(c, 403, "Forbidden");
      c.set("authorizationVerified", true);

      const body = await zParse(UpdateUserConfigurationRequest, c.req.raw);
      const update: Partial<IUserConfiguration> = {};
      if (body.postSendView !== undefined) { update.postSendView = body.postSendView; }
      const result = await this.accountDb.updateUserConfiguration(jwtUserId, update);
      if (result.isErr()) return err(c, 500, "Internal server error");
      return c.json(result.value, 200);
    });
  }
}
