import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { IUserConfiguration } from "../types/index.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import type { AccessService } from "./accountsApi.js";
import { UserConfiguration } from "./schemas.js";
import { UpdateUserConfigurationRequest } from "./requests.js";
import { zParse } from "./validate.js";

export class UserApi {
  private readonly accountDb: AccountDatabase;
  private readonly access: AccessService;
  private readonly logger: Logger;

  constructor(accountDb: AccountDatabase, access: AccessService, logger: Logger) {
    this.accountDb = accountDb;
    this.access = access;
    this.logger = logger;
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
      if (result.isErr()) { this.logger.error("Failed to get user configuration", { code: "api.user.get_configuration_failed", error: result.error }); return err(c, 500, "Internal server error"); }
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

      this.logger.info("Updating user configuration", { code: "api.user.update_configuration", userId: jwtUserId });
      const body = await zParse(UpdateUserConfigurationRequest, c.req.raw);
      const update: Partial<IUserConfiguration> = {};
      if (body.postSendView !== undefined) { update.postSendView = body.postSendView; }
      const result = await this.accountDb.updateUserConfiguration(jwtUserId, update);
      if (result.isErr()) { this.logger.error("Failed to update user configuration", { code: "api.user.update_configuration_failed", error: result.error }); return err(c, 500, "Internal server error"); }
      this.logger.info("User configuration updated", { code: "api.user.configuration_updated", userId: jwtUserId });
      return c.json(result.value, 200);
    });

    // GET /users/:userId — top-level, not account-scoped. Resolves a bare userId (e.g.
    // from an audit log entry or another account's team list) into a display name +
    // picture. Deliberately excludes email — any authenticated caller can hit this, not
    // just users who share an account with the target.
    const getUserRoute = route({
      method: "get",
      path: "/users/{userId}",
      tags: ["Users"],
      request: { params: z.object({ userId: z.string() }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ name: z.string().optional(), picture: z.string().optional() }) } }, description: "User profile" },
      },
    });

    app.openapi(getUserRoute, async (c) => {
      c.set("authorizationVerified", true);
      if (!this.access) { this.logger.error("Service dependency not available.", { code: "api.users.get_profile.not_configured" }); return err(c, 501, "Not implemented"); }
      const userId = c.req.param("userId")!;
      const result = await this.access.getUserProfile(userId);
      if (result.isErr()) {
        this.logger.warn("Authress service unavailable while getting user profile.", { code: "api.authress_unavailable", userId, error: result.error });
        return err(c, 503, "Service temporarily unavailable");
      }
      const { name, picture } = result.value;
      return c.json({ ...(name ? { name } : {}), ...(picture ? { picture } : {}) }, 200);
    });
  }
}
