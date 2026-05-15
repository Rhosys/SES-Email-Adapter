import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createApp } from "./app.js";
import type { AccessService, AuthService } from "./app.js";
import { createAuthorize } from "./authorization-middleware.js";
import { createMockLogger } from "../testing/mock-logger.js";
import { okAsync } from "neverthrow";

/**
 * Authorization Coverage Test
 *
 * Inspects the Hono app's route registrations to verify that every account-scoped
 * route (containing :accountId in the path) has the authorize middleware registered.
 *
 * This test catches missing authorization at build time — if a developer adds a new
 * route with :accountId but forgets to add authz(), this test will fail.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */

function makeMockDeps() {
  const store = new Proxy({} as Record<string, unknown>, {
    get: () => vi.fn().mockResolvedValue(undefined),
  });

  const auth: AuthService = {
    verify: vi.fn().mockReturnValue(okAsync({ userId: "user-1", accountId: "acct-1" })),
  };

  const access: AccessService = {
    listUsers: vi.fn().mockReturnValue(okAsync([])),
    addUser: vi.fn().mockReturnValue(okAsync(undefined)),
    updateUserRole: vi.fn().mockReturnValue(okAsync(undefined)),
    removeUser: vi.fn().mockReturnValue(okAsync(undefined)),
    checkAccess: vi.fn().mockResolvedValue(undefined),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { store, auth, access, logger: createMockLogger() } as any;
}

/**
 * Routes that are explicitly exempted from requiring per-route authorization.
 * These are either non-account-scoped or handled by other mechanisms.
 */
const EXEMPTED_ROUTES = new Set([
  // Health check
  "GET /healthcheck",
  // OpenAPI spec
  "GET /",
  "GET /openapi.json",
  // CORS preflight — all OPTIONS requests
  // (handled by checking method below)
]);

describe("Authorization Coverage", () => {
  it("all account-scoped routes have authorize() middleware", () => {
    const deps = makeMockDeps();
    const app = createApp(deps);

    // Collect all routes from Hono's internal route registry
    const routes = app.routes;

    // Group handlers by method+path to find account-scoped routes
    // Each route entry has { basePath, path, method, handler }
    // When app.get("/path", middleware, handler) is called, both middleware and handler
    // get separate entries with the same path and method.
    const routeHandlers = new Map<string, { path: string; method: string; handlers: Function[] }>();

    for (const route of routes) {
      // Skip wildcard middleware registrations (global middleware like JWT, guard)
      if (route.path === "/*" || route.path === "*") continue;

      const key = `${route.method} ${route.path}`;
      if (!routeHandlers.has(key)) {
        routeHandlers.set(key, { path: route.path, method: route.method, handlers: [] });
      }
      routeHandlers.get(key)!.handlers.push(route.handler);
    }

    // Find all account-scoped routes (those with :accountId in the path)
    const accountRoutes = [...routeHandlers.entries()]
      .filter(([, { path }]) => path.includes(":accountId"))
      .filter(([key]) => {
        const method = key.split(" ")[0]!;
        // Exempt OPTIONS requests
        if (method === "OPTIONS") return false;
        // Exempt explicitly listed routes
        return !EXEMPTED_ROUTES.has(key);
      });

    // For each account-scoped route, verify at least one handler sets authorizationVerified
    // The authorize middleware contains `authorizationVerified` in its source code
    const missing: string[] = [];

    for (const [key, { handlers }] of accountRoutes) {
      const hasAuthorize = handlers.some((handler) => {
        const source = handler.toString();
        return source.includes("authorizationVerified");
      });

      if (!hasAuthorize) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      const message = [
        "The following account-scoped routes are missing authorize() middleware:",
        "",
        ...missing.map((route) => `  • ${route}`),
        "",
        "Add authz(permission, resourceUri) to each route, or add to EXEMPTED_ROUTES if intentionally unprotected.",
      ].join("\n");

      expect.fail(message);
    }
  });

  it("non-account-scoped routes are not flagged", () => {
    const deps = makeMockDeps();
    const app = createApp(deps);

    const routes = app.routes;

    // Build the same route map used by the main coverage test
    const routeHandlers = new Map<string, { path: string; method: string; handlers: Function[] }>();

    for (const route of routes) {
      if (route.path === "/*" || route.path === "*") continue;
      const key = `${route.method} ${route.path}`;
      if (!routeHandlers.has(key)) {
        routeHandlers.set(key, { path: route.path, method: route.method, handlers: [] });
      }
      routeHandlers.get(key)!.handlers.push(route.handler);
    }

    // Non-account routes should NOT be in the set of routes that require authorization
    const nonAccountRoutes = [...routeHandlers.entries()]
      .filter(([, { path }]) => !path.includes(":accountId"))
      .filter(([key]) => {
        const method = key.split(" ")[0]!;
        return method !== "OPTIONS" && method !== "ALL";
      });

    // Verify we have non-account routes (sanity check)
    expect(nonAccountRoutes.length).toBeGreaterThan(0);

    // Verify none of these would be flagged by the detection logic
    // (they shouldn't be, since they don't contain :accountId)
    for (const [key, { path }] of nonAccountRoutes) {
      expect(path).not.toContain(":accountId");
    }
  });

  it("account-scoped routes exist in the app", () => {
    const deps = makeMockDeps();
    const app = createApp(deps);

    const routes = app.routes;
    const accountRoutes = routes.filter((r) => r.path.includes(":accountId") && r.method !== "ALL");

    // Sanity check — we should have many account-scoped routes
    expect(accountRoutes.length).toBeGreaterThan(10);
  });

  it("detection logic catches a route missing authorization (negative test)", () => {
    // Create a minimal Hono app with an account-scoped route that has NO authorize() middleware
    const app = new Hono();

    // This route has :accountId but no authorization middleware
    app.get("/accounts/:accountId/unprotected", (c) => c.json({ data: "exposed" }));

    // Also add a properly protected route for comparison
    const access: AccessService = {
      listUsers: vi.fn().mockReturnValue(okAsync([])),
      addUser: vi.fn().mockReturnValue(okAsync(undefined)),
      updateUserRole: vi.fn().mockReturnValue(okAsync(undefined)),
      removeUser: vi.fn().mockReturnValue(okAsync(undefined)),
      checkAccess: vi.fn().mockResolvedValue(undefined),
    };
    const authz = createAuthorize(access, createMockLogger());
    app.get("/accounts/:accountId/protected", authz("arcs:read", (c) => `accounts/${c.req.param("accountId")}/arcs`), (c) => c.json({ data: "safe" }));

    // Run the same detection logic used in the main test
    const routes = app.routes;
    const routeHandlers = new Map<string, { path: string; method: string; handlers: Function[] }>();

    for (const route of routes) {
      if (route.path === "/*" || route.path === "*") continue;
      const key = `${route.method} ${route.path}`;
      if (!routeHandlers.has(key)) {
        routeHandlers.set(key, { path: route.path, method: route.method, handlers: [] });
      }
      routeHandlers.get(key)!.handlers.push(route.handler);
    }

    const accountRoutes = [...routeHandlers.entries()]
      .filter(([, { path }]) => path.includes(":accountId"))
      .filter(([key]) => {
        const method = key.split(" ")[0]!;
        return method !== "OPTIONS";
      });

    const missing: string[] = [];
    for (const [key, { handlers }] of accountRoutes) {
      const hasAuthorize = handlers.some((handler) => {
        const source = handler.toString();
        return source.includes("authorizationVerified");
      });
      if (!hasAuthorize) {
        missing.push(key);
      }
    }

    // The unprotected route SHOULD be detected as missing authorization
    expect(missing).toContain("GET /accounts/:accountId/unprotected");

    // The protected route should NOT be flagged
    expect(missing).not.toContain("GET /accounts/:accountId/protected");
  });
});
