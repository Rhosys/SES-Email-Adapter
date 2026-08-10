import type { Context, MiddlewareHandler } from "hono";
import type { Logger } from "../logger.js";

/**
 * Context variable key set by the notFound handler to signal that no route matched.
 * Used by the authorization guard to distinguish "route missing authorize()" from
 * "request hit a non-existent path" — the former is a 403, the latter a 404/405
 * already handled by notFound.
 */
export const ROUTE_NOT_FOUND_KEY = "routeNotFound" as const;

/**
 * Global middleware that runs AFTER route handlers.
 * For any route, verifies that the authorization middleware was executed
 * (by checking the context flag). If not, returns 403.
 *
 * This is the safety net — if someone forgets to add authorize() to a route,
 * the guard catches it at runtime.
 *
 * Explicit exceptions (always allowed without authorization):
 * - GET /healthcheck — health check endpoint
 * - OPTIONS * — CORS preflight requests
 * - GET / — OpenAPI specification
 */
export function authorizationGuard(logger?: Logger): MiddlewareHandler {
  return async (c, next) => {
    await next();

    // If the notFound handler already produced a 404/405 response, don't override it
    if (c.get(ROUTE_NOT_FOUND_KEY)) {
      return;
    }

    // Check if authorization was verified by the authorize() middleware
    const authorizationVerified = c.get("authorizationVerified");

    // If authorization was verified, allow the response to pass through
    if (authorizationVerified) {
      return;
    }

    // Check for explicit exceptions (routes that don't require authorization)
    const method = c.req.method;
    const path = c.req.path;

    // Exception 1: GET /healthcheck
    if (method === "GET" && path === "/healthcheck") {
      return;
    }

    // Exception 2: OPTIONS * (all OPTIONS requests)
    if (method === "OPTIONS") {
      return;
    }

    // Exception 3: GET / (OpenAPI specification)
    if (method === "GET" && path === "/") {
      return;
    }

    // Exception 4: Account list and creation — authentication alone is sufficient
    if (path === "/accounts" && (method === "GET" || method === "POST")) {
      return;
    }

    // Exception 5: Public one-click unsubscribe (RFC 8058) — the signed token is the credential
    if (method === "POST" && /^\/accounts\/[^/]+\/unsubscribe$/.test(path)) {
      return;
    }

    // Exception 6: External exchange webhooks — verified at application layer (HMAC, OIDC JWT)
    if (method === "POST" && path.startsWith("/external-exchanges/")) {
      return;
    }

    // No authorization verified and not an exception — a route is missing authorize() middleware
    logger?.critical("Authorization guard fired — a route is missing the authorize() middleware. This request was rejected but the route must be fixed.", {
      code: "authorization_guard.missing_middleware",
      method,
      path,
    });

    c.res = new Response(
      JSON.stringify({ title: "Forbidden", errorCode: "AccessDenied" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  };
}
