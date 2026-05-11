import type { Context, MiddlewareHandler } from "hono";
import type { AccessService, AuthContext } from "./app.js";

/**
 * Creates an authorization middleware factory bound to an AccessService instance.
 *
 * Usage:
 *   const authorize = createAuthorize(access);
 *   app.get("/accounts/:accountId/arcs", authorize("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs`), handler);
 */
export function createAuthorize(access: AccessService) {
  /**
   * Authorization middleware that checks if the authenticated user has permission
   * to access a resource.
   *
   * @param permission - The permission string to check (e.g., "arcs:read", "arcs:write", "accounts:read")
   * @param resourceUri - Either a static resource URI string or a function that builds the URI from route params
   * @returns Hono middleware that performs authorization check
   */
  return function authorize(permission: string, resourceUri: string | ((c: Context) => string)): MiddlewareHandler {
    return async (c, next) => {
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
        await access.checkAccess(userId, resolvedResourceUri, permission);
        // Authorization successful — set flag for guard to check
        c.set("authorizationVerified", true);
        await next();
      } catch (error) {
        // Check if this is a 403 authorization failure (Authress SDK throws with response.status)
        const status = (error as { status?: number }).status
          ?? (error as { response?: { status?: number } }).response?.status;

        if (status === 403) {
          console.warn("Authorization failed", {
            userId,
            resourceUri: resolvedResourceUri,
            permission,
            path,
          });
          c.status(403);
          return c.json({ title: "Forbidden", errorCode: "AccessDenied" });
        }

        // Any other error is an SDK/service failure
        console.error("Authress SDK call failed", {
          userId,
          resourceUri: resolvedResourceUri,
          permission,
          path,
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        });
        c.status(500);
        return c.json({ title: "Internal Server Error" });
      }
    };
  };
}

/**
 * Standalone authorize middleware that retrieves the AccessService from c.env.
 * Use this when the access service is set on the Hono environment bindings,
 * or use createAuthorize() for a closure-based approach.
 *
 * @param permission - The permission string to check (e.g., "arcs:read", "arcs:write")
 * @param resourceUri - Either a static resource URI string or a function that builds the URI from route params
 */
export function authorize(permission: string, resourceUri: string | ((c: Context) => string)): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth") as AuthContext | undefined;
    if (!auth?.userId) {
      c.status(401);
      return c.json({ title: "Unauthorized" });
    }

    const userId = auth.userId;
    const path = c.req.path;

    // Resolve resourceUri — either a static string or a function that builds it from route params
    const resolvedResourceUri = typeof resourceUri === "function" ? resourceUri(c) : resourceUri;

    // Get access service from env
    const access = (c.env as { access?: AccessService })?.access;
    if (!access) {
      console.error("AccessService not available in context env");
      c.status(500);
      return c.json({ title: "Internal Server Error" });
    }

    try {
      await access.checkAccess(userId, resolvedResourceUri, permission);
      // Authorization successful — set flag for guard to check
      c.set("authorizationVerified", true);
      await next();
    } catch (error) {
      // Check if this is a 403 authorization failure (Authress SDK throws with response.status)
      const status = (error as { status?: number }).status
        ?? (error as { response?: { status?: number } }).response?.status;

      if (status === 403) {
        console.warn("Authorization failed", {
          userId,
          resourceUri: resolvedResourceUri,
          permission,
          path,
        });
        c.status(403);
        return c.json({ title: "Forbidden", errorCode: "AccessDenied" });
      }

      // Any other error is an SDK/service failure
      console.error("Authress SDK call failed", {
        userId,
        resourceUri: resolvedResourceUri,
        permission,
        path,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      });
      c.status(500);
      return c.json({ title: "Internal Server Error" });
    }
  };
}
