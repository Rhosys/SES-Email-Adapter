import type { Context, MiddlewareHandler } from "hono";
import type { AccessService, AuthContext } from "./app.js";
import type { Logger } from "../logger.js";

/**
 * Authorization middleware class that checks if the authenticated user has permission
 * to access a resource. Accepts an AccessService and Logger via constructor injection.
 *
 * Usage:
 *   const authzMiddleware = new AuthorizationMiddleware(access, logger);
 *   const authorize = authzMiddleware.authorize.bind(authzMiddleware);
 *   app.get("/accounts/:accountId/arcs", authorize("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs`), handler);
 */
export class AuthorizationMiddleware {
  constructor(
    private readonly access: AccessService,
    private readonly logger: Logger,
  ) {}

  /**
   * Returns a Hono middleware that checks if the authenticated user has permission
   * to access a resource.
   *
   * @param permission - The permission string to check (e.g., "arcs:read", "arcs:write", "accounts:read")
   * @param resourceUri - Either a static resource URI string or a function that builds the URI from route params
   * @returns Hono middleware that performs authorization check
   */
  authorize(permission: string, resourceUri: string | ((c: Context) => string)): MiddlewareHandler {
    return async (c, next) => {
      c.set("authorizationVerified", true);

      const auth = c.get("auth") as AuthContext | undefined;
      if (!auth?.userId) {
        c.status(401);
        return c.json({ title: "Unauthorized" });
      }

      const userId = auth.userId;
      const path = c.req.path;

      // Resolve resourceUri — either a static string or a function that builds it from route params
      const resolvedResourceUri = typeof resourceUri === "function" ? resourceUri(c) : resourceUri;

      try {
        await this.access.checkAccess(userId, resolvedResourceUri, permission);
        this.logger.trackPoint("authorization_check_passed");
        await next();
      } catch (error) {
        const status = (error as { status?: number }).status
          ?? (error as { response?: { status?: number } }).response?.status;

        if (status === 403) {
          this.logger.info("authorization.denied", { userId, resourceUri: resolvedResourceUri, permission, path });
          c.status(403);
          return c.json({ title: `Entity ${userId} is missing permission '${permission}' on '${resolvedResourceUri}'.`, errorCode: "AccessDenied" });
        }

        if (status === 404) {
          this.logger.warn("Authorization check returned 404 — resource or user not found in Authress. Users should always have access to resources they request — this indicates a misconfigured access record or a client bug sending requests to resources the user was never granted.", {
            code: "authorization.not_found",
            userId,
            resourceUri: resolvedResourceUri,
            permission,
            path,
          });
          c.status(403);
          return c.json({ title: `Entity ${userId} is missing permission '${permission}' on '${resolvedResourceUri}'.`, errorCode: "AccessDenied" });
        }

        // Any non-2XX, non-404 status is an SDK/service failure
        this.logger.error("Authorization SDK call failed unexpectedly. The Authress service returned an unhandled error. This request will be rejected with 500.", {
          code: "authorization.sdk_error",
          userId,
          resourceUri: resolvedResourceUri,
          permission,
          path,
          status,
          error,
        });
        c.status(500);
        return c.json({ title: "Internal Server Error" });
      }
    };
  }
}

/**
 * Creates an authorization middleware factory bound to an AccessService instance and logger.
 * This is a convenience wrapper around AuthorizationMiddleware for backward compatibility.
 *
 * Usage:
 *   const authorize = createAuthorize(access, logger);
 *   app.get("/accounts/:accountId/arcs", authorize("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs`), handler);
 */
export function createAuthorize(access: AccessService, logger: Logger) {
  const middleware = new AuthorizationMiddleware(access, logger);
  return middleware.authorize.bind(middleware);
}
