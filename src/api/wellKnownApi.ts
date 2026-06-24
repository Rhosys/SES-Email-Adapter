import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export class WellKnownApi {
  register(app: OpenAPIHono<AppEnv>, _helpers: RouteHelpers): void {
    // RFC 9727 — Well-Known URI for API Catalog
    app.use("/.well-known/*", async (c, next) => {
      await next();
      c.res.headers.set("Cache-Control", "public, max-age=3600");
    });
    app.doc("/.well-known/api-catalog", {
      openapi: "3.1.0",
      info: { title: "SES Email Adapter", version: "1.0.0" },
    });
    app.get("/", (c) => c.redirect("/.well-known/api-catalog", 301));
  }
}
