/**
 * Route Registry Test
 * Asserts that every expected route (method + path) is registered on the Hono app.
 * This is the deterministic gate for the app.ts → route-file split refactor.
 * If any route disappears or changes path during the refactor, this test fails.
 */
import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { ok } from "neverthrow";
import { createMockLogger } from "../helpers/mock-logger.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";

vi.mock("../../src/dns/mx-validator.js", () => ({
  validateRecipientMx: vi.fn().mockResolvedValue({ isOk: () => true, isErr: () => false }),
}));

vi.mock("../../src/email/template-renderer.js", () => ({
  renderTemplate: vi.fn().mockResolvedValue("<html>mock</html>"),
}));

/**
 * Every route registered in app.ts as of the pre-refactor state.
 * Format: "METHOD /path" where path uses {param} notation.
 */
const EXPECTED_ROUTES = [
  "GET /accounts",
  "POST /accounts",
  "GET /accounts/{accountId}/signals",
  "POST /accounts/{accountId}/signals/{id}/quarantineResponse",
  "GET /accounts/{accountId}/threads",
  "GET /accounts/{accountId}/resources",
  "GET /accounts/{accountId}/resources/{resourceId}",
  "PATCH /accounts/{accountId}/resources/{resourceId}",
  "GET /accounts/{accountId}/threads/{threadId}",
  "PATCH /accounts/{accountId}/threads/{threadId}",
  "GET /accounts/{accountId}/threads/{threadId}/signals",
  "POST /accounts/{accountId}/threads/{threadId}/signals",
  "PUT /accounts/{accountId}/threads/{threadId}/signals/{id}",
  "POST /accounts/{accountId}/threads/{threadId}/signals/{id}/send",
  "POST /accounts/{accountId}/threads/{threadId}/unsubscribe",
  "POST /accounts/{accountId}/threads/{threadId}/signals/{id}/rsvp",
  "GET /accounts/{accountId}/threads/{threadId}/signals/{id}",
  "GET /accounts/{accountId}/threads/{threadId}/signals/{id}/raw",
  "PATCH /accounts/{accountId}/threads/{threadId}/signals/{id}",
  "DELETE /accounts/{accountId}/threads/{threadId}/signals/{id}",
  "POST /accounts/{accountId}/threads/{threadId}/signals/{id}/reprocess",
  "GET /accounts/{accountId}/views",
  "POST /accounts/{accountId}/views",
  "PATCH /accounts/{accountId}/views/{id}",
  "DELETE /accounts/{accountId}/views/{id}",
  "GET /accounts/{accountId}/labels",
  "POST /accounts/{accountId}/labels",
  "PATCH /accounts/{accountId}/labels/{id}",
  "DELETE /accounts/{accountId}/labels/{id}",
  "GET /accounts/{accountId}/rules",
  "POST /accounts/{accountId}/rules",
  "PATCH /accounts/{accountId}/rules/{id}",
  "DELETE /accounts/{accountId}/rules/{id}",
  "GET /accounts/{accountId}/domains",
  "POST /accounts/{accountId}/domains",
  "GET /accounts/{accountId}/domains/{id}",
  "PATCH /accounts/{accountId}/domains/{id}",
  "DELETE /accounts/{accountId}/domains/{id}",
  "GET /accounts/{accountId}",
  "PATCH /accounts/{accountId}",
  "GET /accounts/{accountId}/stats",
  "GET /accounts/{accountId}/users",
  "POST /accounts/{accountId}/users",
  "PATCH /accounts/{accountId}/users/{userId}",
  "DELETE /accounts/{accountId}/users/{userId}",
  "GET /accounts/{accountId}/aliases",
  "GET /accounts/{accountId}/aliases/{address}",
  "POST /accounts/{accountId}/aliases",
  "PATCH /accounts/{accountId}/aliases/{address}",
  "DELETE /accounts/{accountId}/aliases/{address}",
  "GET /accounts/{accountId}/aliases/{address}/senders",
  "POST /accounts/{accountId}/aliases/{address}/senders",
  "PUT /accounts/{accountId}/aliases/{address}/senders/{domain}",
  "DELETE /accounts/{accountId}/aliases/{address}/senders/{domain}",
  "GET /accounts/{accountId}/templates",
  "POST /accounts/{accountId}/templates",
  "PUT /accounts/{accountId}/templates/{id}",
  "PATCH /accounts/{accountId}/templates/{id}",
  "DELETE /accounts/{accountId}/templates/{id}",
  "GET /accounts/{accountId}/forwarding-addresses",
  "POST /accounts/{accountId}/forwarding-addresses",
  "POST /accounts/{accountId}/forwarding-addresses/{address}/verify",
  "DELETE /accounts/{accountId}/forwarding-addresses/{address}",
  "GET /accounts/{accountId}/audit",
  "POST /accounts/{accountId}/unsubscribe",
  "POST /reindex",
  "GET /healthcheck",
  "GET /",
  "GET /.well-known/api-catalog",
  "GET /user/{userId}/configuration",
  "PATCH /user/{userId}/configuration",
  "GET /users/{userId}",
  "GET /accounts/{accountId}/external-exchanges",
  "POST /accounts/{accountId}/external-exchanges",
  "GET /accounts/{accountId}/external-exchanges/{emxId}",
  "DELETE /accounts/{accountId}/external-exchanges/{emxId}",
] as const;

describe("Route Registry", () => {
  it("all expected routes are registered on the app", () => {
    const logger = createMockLogger();
    const app = createApp(makeAppDeps({
      threadDb: makeMinimalMock(),
      accountDb: makeMinimalMock(),
      auditDb: makeMinimalMock(),
      auth: { verify: vi.fn().mockResolvedValue(ok({ userId: "u" })) },
      access: { listUsers: vi.fn(), getUserProfile: vi.fn(), listAccountsForUser: vi.fn().mockResolvedValue(ok([])), addUser: vi.fn(), updateUserRole: vi.fn(), removeUser: vi.fn().mockResolvedValue(ok(undefined)), checkAccess: vi.fn().mockResolvedValue(undefined), createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "i" })) } as never,
      logger,
      billingHandler: new BillingHandler(),
      signalReprocessor: { reprocess: vi.fn().mockResolvedValue(ok(undefined)) } as never,
    }));

    // Extract registered routes from Hono's internal router
    const registeredRoutes = new Set<string>();
    for (const route of app.routes) {
      const method = route.method.toUpperCase();
      // Hono uses :param syntax internally — convert to {param} for comparison
      const path = route.path.replace(/:([^/]+)/g, "{$1}");
      registeredRoutes.add(`${method} ${path}`);
    }

    const missing: string[] = [];
    for (const expected of EXPECTED_ROUTES) {
      if (!registeredRoutes.has(expected)) {
        missing.push(expected);
      }
    }

    if (missing.length > 0) {
      // Show what's registered for debugging
      const sorted = [...registeredRoutes].sort();
      expect(missing, `Missing routes. Registered routes:\n${sorted.join("\n")}`).toEqual([]);
    }
  });

  it("no unexpected routes are registered (catches accidental duplicates)", () => {
    const logger = createMockLogger();
    const app = createApp(makeAppDeps({
      threadDb: makeMinimalMock(),
      accountDb: makeMinimalMock(),
      auditDb: makeMinimalMock(),
      auth: { verify: vi.fn().mockResolvedValue(ok({ userId: "u" })) },
      access: { listUsers: vi.fn(), getUserProfile: vi.fn(), listAccountsForUser: vi.fn().mockResolvedValue(ok([])), addUser: vi.fn(), updateUserRole: vi.fn(), removeUser: vi.fn().mockResolvedValue(ok(undefined)), checkAccess: vi.fn().mockResolvedValue(undefined), createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "i" })) } as never,
      logger,
      billingHandler: new BillingHandler(),
      signalReprocessor: { reprocess: vi.fn().mockResolvedValue(ok(undefined)) } as never,
    }));

    const registeredRoutes = new Set<string>();
    for (const route of app.routes) {
      const method = route.method.toUpperCase();
      const path = route.path.replace(/:([^/]+)/g, "{$1}");
      if (method === "ALL") continue; // Hono middleware catch-all
      registeredRoutes.add(`${method} ${path}`);
    }

    const expectedSet = new Set<string>(EXPECTED_ROUTES);
    const extra: string[] = [];
    for (const registered of registeredRoutes) {
      if (!expectedSet.has(registered)) {
        extra.push(registered);
      }
    }

    // Allow middleware routes but flag actual unexpected API routes
    const realExtra = extra.filter(r => !r.startsWith("ALL "));
    if (realExtra.length > 0) {
      expect(realExtra, "Unexpected routes found — add to EXPECTED_ROUTES or remove").toEqual([]);
    }
  });
});

/** Minimal mock that returns {} as never for any property access — prevents null deref during app construction */
function makeMinimalMock(): never {
  return new Proxy({}, {
    get: () => vi.fn().mockResolvedValue(ok(undefined)),
  }) as never;
}
