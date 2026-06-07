import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createAuthorize } from "../../src/api/authorization-middleware.js";
import type { AccessService, AuthContext } from "../../src/api/app.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { ok } from "neverthrow";

type AppEnv = { Variables: { auth: AuthContext; authorizationVerified?: boolean } };

function makeAccess(): AccessService {
  return {
    listUsers: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    listAccountsForUser: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    addUser: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateUserRole: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    removeUser: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    createInvite: vi.fn().mockReturnValue(Promise.resolve(ok({ inviteId: "inv-test" }))),
  };
}

function createTestApp(access: AccessService, logger: MockLogger) {
  const authorize = createAuthorize(access, logger);
  const app = new Hono<AppEnv>();

  // Simulate JWT middleware setting auth context
  app.use("*", async (c, next) => {
    c.set("auth", { accountId: "acct-123", userId: "user-456" });
    await next();
  });

  // Route with dynamic resourceUri function
  app.get(
    "/accounts/:accountId",
    authorize("accounts:read", c => `accounts/${c.req.param("accountId")}`),
    (c) => c.json({ ok: true }),
  );

  // Route with nested dynamic resourceUri
  app.get(
    "/accounts/:accountId/arcs/:id",
    authorize("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("id")}`),
    (c) => c.json({ arc: c.req.param("id") }),
  );

  // Route with static string resourceUri
  app.get(
    "/accounts",
    authorize("accounts:read", "accounts"),
    (c) => c.json({ accounts: [] }),
  );

  return app;
}

describe("authorize() middleware", () => {
  let access: AccessService;
  let logger: MockLogger;

  beforeEach(() => {
    access = makeAccess();
    logger = createMockLogger();
  });

  it("calls checkAccess with resolved resourceUri and permission", async () => {
    const app = createTestApp(access, logger);
    await app.request("/accounts/acct-123");
    expect(access.checkAccess).toHaveBeenCalledWith("user-456", "accounts/acct-123", "accounts:read");
  });

  it("calls checkAccess with dynamic resourceUri from function", async () => {
    const app = createTestApp(access, logger);
    await app.request("/accounts/acct-123/arcs/arc-789");
    expect(access.checkAccess).toHaveBeenCalledWith("user-456", "accounts/acct-123/arcs/arc-789", "arcs:read");
  });

  it("calls checkAccess with static string resourceUri", async () => {
    const app = createTestApp(access, logger);
    await app.request("/accounts");
    expect(access.checkAccess).toHaveBeenCalledWith("user-456", "accounts", "accounts:read");
  });

  it("sets authorizationVerified and calls next on success", async () => {
    const app = createTestApp(access, logger);
    const res = await app.request("/accounts/acct-123");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 403 with AccessDenied on Authress 403 error", async () => {
    const authError = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
    vi.mocked(access.checkAccess).mockRejectedValueOnce(authError);

    const app = createTestApp(access, logger);
    const res = await app.request("/accounts/acct-123");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ title: "Entity user-456 is missing permission 'accounts:read' on 'accounts/acct-123'.", errorCode: "AccessDenied" });
  });

  it("returns 403 when error has status property directly (Authress SDK v3)", async () => {
    const authError = Object.assign(new Error("Forbidden"), { status: 403 });
    vi.mocked(access.checkAccess).mockRejectedValueOnce(authError);

    const app = createTestApp(access, logger);
    const res = await app.request("/accounts/acct-123");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ title: "Entity user-456 is missing permission 'accounts:read' on 'accounts/acct-123'.", errorCode: "AccessDenied" });
  });

  it("returns 500 on SDK error (non-403)", async () => {
    vi.mocked(access.checkAccess).mockRejectedValueOnce(new Error("Network timeout"));

    const app = createTestApp(access, logger);
    const res = await app.request("/accounts/acct-123");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ title: "Internal Server Error" });
  });

  it("logs info on authorization failure", async () => {
    const authError = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
    vi.mocked(access.checkAccess).mockRejectedValueOnce(authError);

    const app = createTestApp(access, logger);
    await app.request("/accounts/acct-123");

    const infoCall = logger.calls.find(c => c.method === "info" && c.message === "authorization.denied");
    expect(infoCall).toBeDefined();
    expect(infoCall!.context).toMatchObject({
      userId: "user-456",
      resourceUri: "accounts/acct-123",
      permission: "accounts:read",
      path: "/accounts/acct-123",
    });
  });

  it("logs error on SDK failure", async () => {
    vi.mocked(access.checkAccess).mockRejectedValueOnce(new Error("Connection refused"));

    const app = createTestApp(access, logger);
    await app.request("/accounts/acct-123");

    const errorCall = logger.calls.find(c => c.method === "error" && c.context?.code === "authorization.sdk_error");
    expect(errorCall).toBeDefined();
    expect(errorCall!.context).toMatchObject({
      code: "authorization.sdk_error",
      userId: "user-456",
      resourceUri: "accounts/acct-123",
      permission: "accounts:read",
      path: "/accounts/acct-123",
      error: expect.objectContaining({ message: "Connection refused" }),
    });
  });

  it("does not execute route handler on authorization failure", async () => {
    const authError = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
    vi.mocked(access.checkAccess).mockRejectedValueOnce(authError);

    const authorize = createAuthorize(access, logger);
    const handlerSpy = vi.fn((c: any) => c.json({ ok: true }));
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("auth", { accountId: "acct-123", userId: "user-456" });
      await next();
    });
    app.get("/test", authorize("test:read", "resource"), handlerSpy);

    await app.request("/test");
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when auth context is missing", async () => {
    const authorize = createAuthorize(access, logger);
    const app = new Hono<AppEnv>();
    // No auth middleware — auth context not set
    app.get("/test", authorize("test:read", "resource"), (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ title: "Unauthorized" });
  });

  it("does not expose internal details in error responses", async () => {
    const sdkError = new Error("https://api.authress.io/v1/users/user-456/resources/accounts%2Facct-123/permissions/accounts:read failed");
    vi.mocked(access.checkAccess).mockRejectedValueOnce(sdkError);

    const app = createTestApp(access, logger);
    const res = await app.request("/accounts/acct-123");
    const body = await res.json();

    // Response should not contain internal URLs or service names
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("authress");
    expect(bodyStr).not.toContain("api.authress.io");
    expect(body).toEqual({ title: "Internal Server Error" });
  });
});
