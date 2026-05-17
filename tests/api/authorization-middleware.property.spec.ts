import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createAuthorize } from "../../src/api/authorization-middleware.js";
import type { AccessService, AuthContext } from "../../src/api/app.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { ok } from "neverthrow";

type AppEnv = { Variables: { auth: AuthContext; authorizationVerified?: boolean } };

function makeAccess(overrides?: Partial<AccessService>): AccessService {
  return {
    listUsers: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    listAccountsForUser: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    addUser: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateUserRole: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    removeUser: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Authorization middleware extracts account ID from path", () => {
  it("constructs correct resourceUri from path params", async () => {
    const access = makeAccess();
    const authorize = createAuthorize(access, createMockLogger());
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-abc", userId: "user-xyz" }); await next(); });
    app.get("/accounts/:accountId", authorize("accounts:read", (c) => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

    await app.request("/accounts/acct-abc");
    expect(access.checkAccess).toHaveBeenCalledWith("user-xyz", "accounts/acct-abc", "accounts:read");
  });

  it("handles nested sub-resource paths", async () => {
    const access = makeAccess();
    const authorize = createAuthorize(access, createMockLogger());
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-abc", userId: "user-xyz" }); await next(); });
    app.get("/accounts/:accountId/arcs/:arcId", authorize("arcs:read", (c) => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}`), (c) => c.json({ ok: true }));

    await app.request("/accounts/acct-abc/arcs/arc-123");
    expect(access.checkAccess).toHaveBeenCalledWith("user-xyz", "accounts/acct-abc/arcs/arc-123", "arcs:read");
  });
});

describe("Authorization middleware enforces permission level", () => {
  const permissions = ["accounts:read", "arcs:write", "signals:read", "management:write"];

  it.each(permissions.map((p) => ({ permission: p })))("forwards $permission to checkAccess", async ({ permission }) => {
    const access = makeAccess();
    const authorize = createAuthorize(access, createMockLogger());
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-1", userId: "user-1" }); await next(); });
    app.get("/accounts/:accountId", authorize(permission, (c) => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

    await app.request("/accounts/acct-1");
    expect(access.checkAccess).toHaveBeenCalledWith("user-1", expect.any(String), permission);
  });
});

describe("Authorization short-circuits on failure", () => {
  it("does NOT execute route handler when authorization fails (403)", async () => {
    const authError = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
    const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(authError) });
    const authorize = createAuthorize(access, createMockLogger());
    const handlerSpy = vi.fn((c: any) => c.json({ ok: true }));

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-1", userId: "user-1" }); await next(); });
    app.get("/accounts/:accountId", authorize("accounts:read", (c) => `accounts/${c.req.param("accountId")}`), handlerSpy);

    await app.request("/accounts/acct-1");
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it("does NOT execute route handler when SDK throws non-403 error", async () => {
    const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(new Error("connection timeout")) });
    const authorize = createAuthorize(access, createMockLogger());
    const handlerSpy = vi.fn((c: any) => c.json({ ok: true }));

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-1", userId: "user-1" }); await next(); });
    app.get("/accounts/:accountId", authorize("accounts:read", (c) => `accounts/${c.req.param("accountId")}`), handlerSpy);

    await app.request("/accounts/acct-1");
    expect(handlerSpy).not.toHaveBeenCalled();
  });
});

describe("Authorization failure returns 403 with error code", () => {
  it("returns { title: 'Forbidden', errorCode: 'AccessDenied' } for 403 from SDK", async () => {
    const authError = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
    const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(authError) });
    const authorize = createAuthorize(access, createMockLogger());

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-1", userId: "user-1" }); await next(); });
    app.get("/accounts/:accountId", authorize("accounts:read", (c) => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

    const res = await app.request("/accounts/acct-1");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ title: "Forbidden", errorCode: "AccessDenied" });
  });
});

describe("Authress SDK failure returns 500 with logged error", () => {
  const nonForbiddenStatuses = [400, 401, 429, 500, 502, 503];

  it.each(nonForbiddenStatuses.map((s) => ({ statusCode: s })))("status=$statusCode → returns 500 and logs error", async ({ statusCode }) => {
    const error = Object.assign(new Error("SDK failure"), { response: { status: statusCode } });
    const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(error) });
    const logger = createMockLogger();
    const authorize = createAuthorize(access, logger);

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-1", userId: "user-1" }); await next(); });
    app.get("/accounts/:accountId", authorize("accounts:read", (c) => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

    const res = await app.request("/accounts/acct-1");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ title: "Internal Server Error" });

    const errorCall = logger.calls.find((c) => c.method === "error" && c.context?.code === "authorization.sdk_error");
    expect(errorCall).toBeDefined();
  });

  it("status=404 → returns 403 and logs warn", async () => {
    const error = Object.assign(new Error("Not found"), { response: { status: 404 } });
    const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(error) });
    const logger = createMockLogger();
    const authorize = createAuthorize(access, logger);

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-1", userId: "user-1" }); await next(); });
    app.get("/accounts/:accountId", authorize("accounts:read", (c) => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

    const res = await app.request("/accounts/acct-1");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ title: "Forbidden", errorCode: "AccessDenied" });

    const warnCall = logger.calls.find((c) => c.method === "warn" && c.context?.code === "authorization.not_found");
    expect(warnCall).toBeDefined();
  });
});

describe("Authorization failures are logged", () => {
  it("logs userId, resourceUri, permission, and path on 403", async () => {
    const authError = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
    const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(authError) });
    const logger = createMockLogger();
    const authorize = createAuthorize(access, logger);

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-1", userId: "user-1" }); await next(); });
    app.get("/accounts/:accountId", authorize("accounts:read", (c) => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

    await app.request("/accounts/acct-1");

    const infoCall = logger.calls.find((c) => c.method === "info" && c.message === "authorization.denied");
    expect(infoCall).toBeDefined();
    expect(infoCall!.context).toMatchObject({
      userId: "user-1",
      resourceUri: "accounts/acct-1",
      permission: "accounts:read",
      path: "/accounts/acct-1",
    });
  });
});

describe("Error responses sanitize internal details", () => {
  const internalErrors = [
    "https://api.authress.io/v1/users/user-123/resources/accounts%2Facct-123/permissions/accounts:read failed",
    "ECONNREFUSED 10.0.3.42:443 authress-internal-service",
    "Error at AuthressClient.authorizeUser (/node_modules/@authress/sdk/src/index.js:123:45)",
  ];

  it.each(internalErrors.map((msg) => ({ msg })))("500 response does not expose: $msg", async ({ msg }) => {
    const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(new Error(msg)) });
    const authorize = createAuthorize(access, createMockLogger());

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-1", userId: "user-1" }); await next(); });
    app.get("/accounts/:accountId", authorize("accounts:read", (c) => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

    const res = await app.request("/accounts/acct-1");
    const body = await res.json();
    const bodyStr = JSON.stringify(body);

    expect(bodyStr).not.toMatch(/https?:\/\//);
    expect(bodyStr.toLowerCase()).not.toContain("authress");
    expect(bodyStr).not.toMatch(/at\s+\w+.*\(.*:\d+:\d+\)/);
    expect(body).toEqual({ title: "Internal Server Error" });
  });

  it.each(internalErrors.map((msg) => ({ msg })))("403 response does not expose: $msg", async ({ msg }) => {
    const authError = Object.assign(new Error(msg), { response: { status: 403 } });
    const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(authError) });
    const authorize = createAuthorize(access, createMockLogger());

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", { accountId: "acct-1", userId: "user-1" }); await next(); });
    app.get("/accounts/:accountId", authorize("accounts:read", (c) => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

    const res = await app.request("/accounts/acct-1");
    const body = await res.json();
    const bodyStr = JSON.stringify(body);

    expect(bodyStr).not.toMatch(/https?:\/\//);
    expect(bodyStr.toLowerCase()).not.toContain("authress");
    expect(body).toEqual({ title: "Forbidden", errorCode: "AccessDenied" });
  });
});
