import type { MiddlewareHandler } from "hono";
import type { Logger } from "../logger.js";

export const ROUTE_NOT_FOUND_KEY = "routeNotFound" as const;

export function authorizationGuard(logger?: Logger): MiddlewareHandler {
  return async (c, next) => {
    await next();

    if (c.get(ROUTE_NOT_FOUND_KEY)) return;
    if (c.get("authorizationVerified")) return;

    // CORS preflight never carries credentials
    if (c.req.method === "OPTIONS") return;

    logger?.critical("Authorization guard fired — a route is missing the authorize() middleware.", {
      code: "authorization_guard.missing_middleware",
      method: c.req.method,
      path: c.req.path,
    });

    c.res = new Response(
      JSON.stringify({ title: "Forbidden", errorCode: "AccessDenied" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  };
}
