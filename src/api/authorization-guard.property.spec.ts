// Feature: email-catcher-authz-checks, Property 8: Authorization guard blocks unprotected routes
// Feature: email-catcher-authz-checks, Property 9: Authorization guard passes when middleware ran
//
// **Validates: Requirements 3.1, 6.1**

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { authorizationGuard } from "./authorization-guard.js";
import { propertyRunner } from "../testing/property-runner.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates valid account IDs (alphanumeric with hyphens, 3-36 chars) */
const arbAccountId = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,34}[a-zA-Z0-9]$/);

/** Generates HTTP methods (excluding OPTIONS which is exempted) */
const arbMethod = fc.constantFrom("GET", "POST", "PATCH", "PUT", "DELETE");

/** Generates sub-resource path segments for account-scoped routes */
const arbSubResource = fc.constantFrom(
  "arcs",
  "users",
  "signals",
  "views",
  "labels",
  "rules",
  "domains",
  "aliases",
);

// ---------------------------------------------------------------------------
// Property 8: Authorization guard blocks unprotected routes
// ---------------------------------------------------------------------------

describe("Property 8: Authorization guard blocks unprotected routes", () => {
  it("returns 403 when authorizationVerified flag is NOT set on account-scoped routes", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbMethod,
        arbSubResource,
        async (accountId, method, subResource) => {
          const app = new Hono();

          // Register the guard on account-scoped routes (same pattern as design doc)
          app.use("/accounts/:accountId/*", authorizationGuard());

          // Register a route handler that does NOT set authorizationVerified
          app.on(method, `/accounts/:accountId/${subResource}/:id`, (c) => c.json({ ok: true }));

          const res = await app.request(
            `/accounts/${encodeURIComponent(accountId)}/${subResource}/item-1`,
            { method },
          );

          expect(res.status).toBe(403);
          const body = await res.json();
          expect(body).toEqual({ title: "Forbidden", errorCode: "AccessDenied" });
        },
      ),
    );
  });

  it("returns 403 when authorizationVerified is explicitly set to false", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbMethod,
        arbSubResource,
        async (accountId, method, subResource) => {
          type AppEnv = { Variables: { authorizationVerified?: boolean } };
          const app = new Hono<AppEnv>();

          app.use("/accounts/:accountId/*", authorizationGuard());

          // Route handler explicitly sets flag to false (should still be blocked)
          app.on(method, `/accounts/:accountId/${subResource}/:id`, (c) => {
            c.set("authorizationVerified", false);
            return c.json({ ok: true });
          });

          const res = await app.request(
            `/accounts/${encodeURIComponent(accountId)}/${subResource}/item-1`,
            { method },
          );

          expect(res.status).toBe(403);
          const body = await res.json();
          expect(body).toEqual({ title: "Forbidden", errorCode: "AccessDenied" });
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Authorization guard passes when middleware ran
// ---------------------------------------------------------------------------

describe("Property 9: Authorization guard passes when middleware ran", () => {
  it("allows response through when authorizationVerified flag is set to true", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbMethod,
        arbSubResource,
        fc.nat({ max: 999 }),
        async (accountId, method, subResource, responsePayload) => {
          type AppEnv = { Variables: { authorizationVerified?: boolean } };
          const app = new Hono<AppEnv>();

          app.use("/accounts/:accountId/*", authorizationGuard());

          // Simulate authorize() middleware setting the flag before the handler
          app.use("/accounts/:accountId/*", async (c, next) => {
            c.set("authorizationVerified", true);
            await next();
          });

          app.on(method, `/accounts/:accountId/${subResource}/:id`, (c) => {
            return c.json({ value: responsePayload });
          });

          const res = await app.request(
            `/accounts/${encodeURIComponent(accountId)}/${subResource}/item-1`,
            { method },
          );

          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body).toEqual({ value: responsePayload });
        },
      ),
    );
  });

  it("preserves the original response status and body when authorized", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(
        arbAccountId,
        arbSubResource,
        fc.constantFrom(200, 201, 400, 404, 409, 422),
        async (accountId, subResource, statusCode) => {
          type AppEnv = { Variables: { authorizationVerified?: boolean } };
          const app = new Hono<AppEnv>();

          app.use("/accounts/:accountId/*", authorizationGuard());

          // Simulate authorize() middleware setting the flag
          app.use("/accounts/:accountId/*", async (c, next) => {
            c.set("authorizationVerified", true);
            await next();
          });

          app.get(`/accounts/:accountId/${subResource}/:id`, (c) => {
            c.status(statusCode as any);
            return c.json({ status: statusCode });
          });

          const res = await app.request(
            `/accounts/${encodeURIComponent(accountId)}/${subResource}/item-1`,
          );

          // The guard should NOT override the response — original status preserved
          expect(res.status).toBe(statusCode);
          const body = await res.json();
          expect(body).toEqual({ status: statusCode });
        },
      ),
    );
  });
});
