import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authorizationGuard } from "../../src/api/authorization-guard.js";

describe("Authorization guard blocks unprotected routes", () => {
  const methods = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
  const subResources = ["arcs", "signals", "views", "labels", "rules", "domains", "aliases"] as const;

  it.each(methods.map((m) => ({ method: m })))("$method — returns 403 when authorizationVerified flag is NOT set", async ({ method }) => {
    const app = new Hono();
    app.use("/accounts/:accountId/*", authorizationGuard());
    app.on(method, "/accounts/:accountId/arcs/:id", (c) => c.json({ ok: true }));

    const res = await app.request("/accounts/acct-test-123/arcs/item-1", { method });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ title: "Forbidden", errorCode: "AccessDenied" });
  });

  it("returns 403 when authorizationVerified is explicitly set to false", async () => {
    type AppEnv = { Variables: { authorizationVerified?: boolean } };
    const app = new Hono<AppEnv>();
    app.use("/accounts/:accountId/*", authorizationGuard());
    app.get("/accounts/:accountId/signals/:id", (c) => {
      c.set("authorizationVerified", false);
      return c.json({ ok: true });
    });

    const res = await app.request("/accounts/acct-test-123/signals/item-1");
    expect(res.status).toBe(403);
  });
});

describe("Authorization guard passes when middleware ran", () => {
  it("allows response through when authorizationVerified is true", async () => {
    type AppEnv = { Variables: { authorizationVerified?: boolean } };
    const app = new Hono<AppEnv>();
    app.use("/accounts/:accountId/*", authorizationGuard());
    app.use("/accounts/:accountId/*", async (c, next) => {
      c.set("authorizationVerified", true);
      await next();
    });
    app.get("/accounts/:accountId/arcs/:id", (c) => c.json({ value: 42 }));

    const res = await app.request("/accounts/acct-test-123/arcs/item-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 42 });
  });

  const statusCodes = [200, 201, 400, 404, 409, 422] as const;

  it.each(statusCodes.map((s) => ({ statusCode: s })))("preserves original response status $statusCode when authorized", async ({ statusCode }) => {
    type AppEnv = { Variables: { authorizationVerified?: boolean } };
    const app = new Hono<AppEnv>();
    app.use("/accounts/:accountId/*", authorizationGuard());
    app.use("/accounts/:accountId/*", async (c, next) => {
      c.set("authorizationVerified", true);
      await next();
    });
    app.get("/accounts/:accountId/views/:id", (c) => {
      c.status(statusCode as any);
      return c.json({ status: statusCode });
    });

    const res = await app.request("/accounts/acct-test-123/views/item-1");
    expect(res.status).toBe(statusCode);
    expect(await res.json()).toEqual({ status: statusCode });
  });
});
