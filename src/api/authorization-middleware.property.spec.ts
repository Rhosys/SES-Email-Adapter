// Feature: email-catcher-authz-checks, Property 1: Authorization middleware extracts account ID from path
// Feature: email-catcher-authz-checks, Property 2: Authorization middleware enforces permission level
// Feature: email-catcher-authz-checks, Property 3: Authorization short-circuits on failure
// Feature: email-catcher-authz-checks, Property 4: Authorization failure returns 403 with error code
// Feature: email-catcher-authz-checks, Property 5: Authress SDK failure returns 500 with logged error
// Feature: email-catcher-authz-checks, Property 6: Authorization failures are logged
// Feature: email-catcher-authz-checks, Property 7: Error responses sanitize internal details
//
// **Validates: Requirements 1.2, 1.3, 1.4, 2.2, 2.3, 2.4, 5.1, 5.2, 5.3, 5.4**

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { createAuthorize } from "./authorization-middleware.js";
import type { AccessService, AuthContext } from "./app.js";
import { propertyRunner } from "../testing/property-runner.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates valid account IDs (alphanumeric with hyphens, 3-36 chars) */
const arbAccountId = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,34}[a-zA-Z0-9]$/);

/** Generates valid user IDs (alphanumeric with hyphens/underscores, 3-36 chars) */
const arbUserId = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{1,34}[a-zA-Z0-9]$/);

/** Generates permission strings in the format "resource:action" */
const arbPermission = fc.tuple(
  fc.constantFrom("accounts", "arcs", "users", "signals", "views", "labels", "rules", "domains", "aliases", "management"),
  fc.constantFrom("read", "write"),
).map(([resource, action]) => `${resource}:${action}`);

/** Generates sub-resource path segments (e.g., "/arcs/arc-123") */
const arbSubPath = fc.oneof(
  fc.constant(""),
  fc.tuple(
    fc.constantFrom("arcs", "users", "signals", "views", "labels", "rules", "domains", "aliases"),
    fc.stringMatching(/^[a-zA-Z0-9-]{3,20}$/),
  ).map(([resource, id]) => `/${resource}/${id}`),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AppEnv = { Variables: { auth: AuthContext; authorizationVerified?: boolean } };

function makeAccess(overrides?: Partial<AccessService>): AccessService {
  return {
    listUsers: vi.fn().mockResolvedValue([]),
    addUser: vi.fn().mockResolvedValue(undefined),
    updateUserRole: vi.fn().mockResolvedValue(undefined),
    removeUser: vi.fn().mockResolvedValue(undefined),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 1: Authorization middleware extracts account ID from path
// ---------------------------------------------------------------------------

describe("Property 1: Authorization middleware extracts account ID from path", () => {
  it("correctly extracts accountId and constructs resourceUri for any valid accountId", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        async (accountId, userId, permission) => {
          const access = makeAccess();
          const authorize = createAuthorize(access);
          const app = new Hono<AppEnv>();

          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });

          app.get(
            "/accounts/:accountId",
            authorize(permission, c => `accounts/${c.req.param("accountId")}`),
            (c) => c.json({ ok: true }),
          );

          await app.request(`/accounts/${encodeURIComponent(accountId)}`);

          expect(access.checkAccess).toHaveBeenCalledWith(
            userId,
            `accounts/${accountId}`,
            permission,
          );
        },
      ),
    );
  });

  it("correctly extracts accountId with nested sub-resource paths", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        async (accountId, userId) => {
          const access = makeAccess();
          const authorize = createAuthorize(access);
          const app = new Hono<AppEnv>();

          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });

          app.get(
            "/accounts/:accountId/arcs/:arcId",
            authorize("arcs:read", c => `accounts/${c.req.param("accountId")}/arcs/${c.req.param("arcId")}`),
            (c) => c.json({ ok: true }),
          );

          const arcId = "arc-test-123";
          await app.request(`/accounts/${encodeURIComponent(accountId)}/arcs/${arcId}`);

          expect(access.checkAccess).toHaveBeenCalledWith(
            userId,
            `accounts/${accountId}/arcs/${arcId}`,
            "arcs:read",
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Authorization middleware enforces permission level
// ---------------------------------------------------------------------------

describe("Property 2: Authorization middleware enforces permission level", () => {
  it("uses the specified permission level when calling checkAccess", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        async (accountId, userId, permission) => {
          const access = makeAccess();
          const authorize = createAuthorize(access);
          const app = new Hono<AppEnv>();

          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });

          app.get(
            "/accounts/:accountId",
            authorize(permission, c => `accounts/${c.req.param("accountId")}`),
            (c) => c.json({ ok: true }),
          );

          await app.request(`/accounts/${encodeURIComponent(accountId)}`);

          // The exact permission passed to authorize() must be forwarded to checkAccess
          expect(access.checkAccess).toHaveBeenCalledWith(
            userId,
            expect.any(String),
            permission,
          );
        },
      ),
    );
  });

  it("different permissions on different routes are enforced independently", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        arbPermission,
        async (accountId, userId, readPerm, writePerm) => {
          const access = makeAccess();
          const authorize = createAuthorize(access);
          const app = new Hono<AppEnv>();

          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });

          app.get(
            "/accounts/:accountId/resource",
            authorize(readPerm, c => `accounts/${c.req.param("accountId")}/resource`),
            (c) => c.json({ ok: true }),
          );

          app.post(
            "/accounts/:accountId/resource",
            authorize(writePerm, c => `accounts/${c.req.param("accountId")}/resource`),
            (c) => c.json({ ok: true }),
          );

          await app.request(`/accounts/${encodeURIComponent(accountId)}/resource`, { method: "GET" });
          expect(access.checkAccess).toHaveBeenLastCalledWith(userId, expect.any(String), readPerm);

          await app.request(`/accounts/${encodeURIComponent(accountId)}/resource`, { method: "POST" });
          expect(access.checkAccess).toHaveBeenLastCalledWith(userId, expect.any(String), writePerm);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Authorization short-circuits on failure
// ---------------------------------------------------------------------------

describe("Property 3: Authorization short-circuits on failure", () => {
  it("does NOT execute the route handler when authorization fails", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        async (accountId, userId, permission) => {
          const authError = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
          const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(authError) });
          const authorize = createAuthorize(access);
          const handlerSpy = vi.fn((c: any) => c.json({ ok: true }));

          const app = new Hono<AppEnv>();
          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });
          app.get("/accounts/:accountId", authorize(permission, c => `accounts/${c.req.param("accountId")}`), handlerSpy);

          await app.request(`/accounts/${encodeURIComponent(accountId)}`);

          expect(handlerSpy).not.toHaveBeenCalled();
        },
      ),
    );
  });

  it("does NOT execute the route handler when SDK throws non-403 error", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        fc.string({ minLength: 1, maxLength: 50 }),
        async (accountId, userId, permission, errorMessage) => {
          const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(new Error(errorMessage)) });
          const authorize = createAuthorize(access);
          const handlerSpy = vi.fn((c: any) => c.json({ ok: true }));

          const app = new Hono<AppEnv>();
          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });
          app.get("/accounts/:accountId", authorize(permission, c => `accounts/${c.req.param("accountId")}`), handlerSpy);

          await app.request(`/accounts/${encodeURIComponent(accountId)}`);

          expect(handlerSpy).not.toHaveBeenCalled();
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Authorization failure returns 403 with error code
// ---------------------------------------------------------------------------

describe("Property 4: Authorization failure returns 403 with error code", () => {
  it("returns HTTP 403 with { title: 'Forbidden', errorCode: 'AccessDenied' } for any unauthorized request", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        fc.constantFrom(
          // Authress SDK v2 style (response.status)
          (msg: string) => Object.assign(new Error(msg), { response: { status: 403 } }),
          // Authress SDK v3 style (status directly)
          (msg: string) => Object.assign(new Error(msg), { status: 403 }),
        ),
        async (accountId, userId, permission, makeError) => {
          const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(makeError("Forbidden")) });
          const authorize = createAuthorize(access);

          const app = new Hono<AppEnv>();
          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });
          app.get("/accounts/:accountId", authorize(permission, c => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

          const res = await app.request(`/accounts/${encodeURIComponent(accountId)}`);

          expect(res.status).toBe(403);
          const body = await res.json();
          expect(body).toEqual({ title: "Forbidden", errorCode: "AccessDenied" });
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Authress SDK failure returns 500 with logged error
// ---------------------------------------------------------------------------

describe("Property 5: Authress SDK failure returns 500 with logged error", () => {
  it("returns HTTP 500 with { title: 'Internal Server Error' } for any SDK failure (non-403)", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.constantFrom(400, 401, 404, 408, 429, 500, 502, 503),
        async (accountId, userId, permission, errorMessage, statusCode) => {
          // Create an error that is NOT a 403 — all generated status codes are non-403
          const error = Object.assign(new Error(errorMessage), { response: { status: statusCode } });
          const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(error) });
          const authorize = createAuthorize(access);

          const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          const app = new Hono<AppEnv>();
          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });
          app.get("/accounts/:accountId", authorize(permission, c => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

          const res = await app.request(`/accounts/${encodeURIComponent(accountId)}`);

          expect(res.status).toBe(500);
          const body = await res.json();
          expect(body).toEqual({ title: "Internal Server Error" });

          // Verify error was logged
          expect(errorSpy).toHaveBeenCalledWith("Authress SDK call failed", expect.objectContaining({
            userId,
            permission,
          }));

          errorSpy.mockRestore();
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Authorization failures are logged
// ---------------------------------------------------------------------------

describe("Property 6: Authorization failures are logged", () => {
  it("logs with userId, resourceUri, permission, and path for any authorization failure", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        async (accountId, userId, permission) => {
          const authError = Object.assign(new Error("Forbidden"), { response: { status: 403 } });
          const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(authError) });
          const authorize = createAuthorize(access);

          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const app = new Hono<AppEnv>();
          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });
          app.get("/accounts/:accountId", authorize(permission, c => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

          await app.request(`/accounts/${encodeURIComponent(accountId)}`);

          expect(warnSpy).toHaveBeenCalledWith("Authorization failed", expect.objectContaining({
            userId,
            resourceUri: `accounts/${accountId}`,
            permission,
            path: `/accounts/${encodeURIComponent(accountId)}`,
          }));

          warnSpy.mockRestore();
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Error responses sanitize internal details
// ---------------------------------------------------------------------------

describe("Property 7: Error responses sanitize internal details", () => {
  /** Generates error messages that contain internal details that should NOT leak */
  const arbInternalErrorMessage = fc.oneof(
    fc.constant("https://api.authress.io/v1/users/user-123/resources/accounts%2Facct-123/permissions/accounts:read failed"),
    fc.constant("ECONNREFUSED 10.0.3.42:443 authress-internal-service"),
    fc.constant("Error at AuthressClient.authorizeUser (/node_modules/@authress/sdk/src/index.js:123:45)"),
    fc.tuple(
      fc.constantFrom("https://", "http://"),
      fc.stringMatching(/^[a-z0-9.-]{3,30}$/),
      fc.constantFrom(".authress.io", ".internal.svc", ".amazonaws.com", ".local"),
      fc.constantFrom("/v1/users", "/api/check", "/permissions"),
    ).map(([proto, host, domain, path]) => `${proto}${host}${domain}${path} connection failed`),
    fc.tuple(
      fc.constantFrom("Error at ", "TypeError at ", "ReferenceError at "),
      fc.stringMatching(/^[A-Za-z.]+$/),
      fc.constant(" ("),
      fc.stringMatching(/^\/[a-z/]+\.js$/),
      fc.constant(":"),
      fc.nat({ max: 999 }),
      fc.constant(")"),
    ).map(parts => parts.join("")),
  );

  it("does NOT expose internal URLs, service names, or stack traces in error responses", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        arbInternalErrorMessage,
        async (accountId, userId, permission, errorMessage) => {
          const error = new Error(errorMessage);
          const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(error) });
          const authorize = createAuthorize(access);

          const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          const app = new Hono<AppEnv>();
          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });
          app.get("/accounts/:accountId", authorize(permission, c => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

          const res = await app.request(`/accounts/${encodeURIComponent(accountId)}`);
          const body = await res.json();
          const bodyStr = JSON.stringify(body);

          // Must not contain internal URLs
          expect(bodyStr).not.toMatch(/https?:\/\//);
          // Must not contain authress references
          expect(bodyStr.toLowerCase()).not.toContain("authress");
          // Must not contain stack traces
          expect(bodyStr).not.toMatch(/at\s+\w+.*\(.*:\d+:\d+\)/);
          // Must not contain internal service names
          expect(bodyStr).not.toContain(".internal.");
          expect(bodyStr).not.toContain(".svc");
          expect(bodyStr).not.toContain(".local");
          // Must not contain file paths
          expect(bodyStr).not.toMatch(/\/node_modules\//);
          // Response should be the sanitized error
          expect(body).toEqual({ title: "Internal Server Error" });

          errorSpy.mockRestore();
        },
      ),
    );
  });

  it("does NOT expose internal details in 403 responses either", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbUserId,
        arbPermission,
        arbInternalErrorMessage,
        async (accountId, userId, permission, errorMessage) => {
          const authError = Object.assign(new Error(errorMessage), { response: { status: 403 } });
          const access = makeAccess({ checkAccess: vi.fn().mockRejectedValue(authError) });
          const authorize = createAuthorize(access);

          const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
          const app = new Hono<AppEnv>();
          app.use("*", async (c, next) => {
            c.set("auth", { accountId, userId });
            await next();
          });
          app.get("/accounts/:accountId", authorize(permission, c => `accounts/${c.req.param("accountId")}`), (c) => c.json({ ok: true }));

          const res = await app.request(`/accounts/${encodeURIComponent(accountId)}`);
          const body = await res.json();
          const bodyStr = JSON.stringify(body);

          // Must not contain internal URLs or service details
          expect(bodyStr).not.toMatch(/https?:\/\//);
          expect(bodyStr.toLowerCase()).not.toContain("authress");
          expect(bodyStr).not.toMatch(/at\s+\w+.*\(.*:\d+:\d+\)/);
          // Response should be the sanitized 403
          expect(body).toEqual({ title: "Forbidden", errorCode: "AccessDenied" });

          warnSpy.mockRestore();
        },
      ),
    );
  });
});
