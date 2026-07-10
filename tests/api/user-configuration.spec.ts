import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { ok, err } from "neverthrow";
import { USER_CONFIGURATION_DEFAULTS } from "../../src/types/index.js";
import type { IUserConfiguration } from "../../src/types/index.js";

const TEST_USER_ID = "user-cfg-001";

function makeAuth(userId = TEST_USER_ID) {
  return { verify: vi.fn().mockResolvedValue(ok({ userId })) };
}

function makeAccess(overrides: { getUserProfile?: ReturnType<typeof vi.fn> } = {}) {
  return {
    listUsers: vi.fn().mockResolvedValue(ok([])),
    getUserProfile: overrides.getUserProfile ?? vi.fn().mockResolvedValue(ok({})),
    listAccountsForUser: vi.fn().mockResolvedValue(ok([])),
    addUser: vi.fn().mockResolvedValue(ok(undefined)),
    updateUserRole: vi.fn().mockResolvedValue(ok(undefined)),
    removeUser: vi.fn().mockResolvedValue(ok(undefined)),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "inv" })),
  };
}

function makeAccountDb(config?: IUserConfiguration) {
  return {
    getUserConfiguration: vi.fn().mockResolvedValue(ok(config ?? { ...USER_CONFIGURATION_DEFAULTS })),
    updateUserConfiguration: vi.fn().mockImplementation(async (_userId: string, update: Partial<IUserConfiguration>) =>
      ok({ ...USER_CONFIGURATION_DEFAULTS, ...update }),
    ),
  };
}

function buildApp(overrides: { accountDb?: ReturnType<typeof makeAccountDb>; auth?: ReturnType<typeof makeAuth>; access?: ReturnType<typeof makeAccess> } = {}) {
  const logger = createMockLogger();
  const accountDb = overrides.accountDb ?? makeAccountDb();
  const auth = overrides.auth ?? makeAuth();
  const access = overrides.access ?? makeAccess();
  const app = createApp(makeAppDeps({ accountDb: accountDb as never, auth, access: access as never, logger }));
  return { app, accountDb, auth, access };
}

describe("User Configuration API", () => {
  describe("GET /user/:userId/configuration", () => {
    it("returns defaults when no config exists", async () => {
      const { app } = buildApp();
      const res = await app.request(`/user/${TEST_USER_ID}/configuration`, {
        headers: { Authorization: "Bearer valid-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ postSendView: "return_to_inbox" });
    });

    it("returns stored config when it exists", async () => {
      const accountDb = makeAccountDb({ postSendView: "stay_on_thread" });
      const { app } = buildApp({ accountDb });
      const res = await app.request(`/user/${TEST_USER_ID}/configuration`, {
        headers: { Authorization: "Bearer valid-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ postSendView: "stay_on_thread" });
    });

    it("returns 403 when path userId does not match JWT userId", async () => {
      const { app } = buildApp();
      const res = await app.request("/user/other-user-id/configuration", {
        headers: { Authorization: "Bearer valid-token" },
      });
      expect(res.status).toBe(403);
    });

    it("returns 401 without auth header", async () => {
      const { app } = buildApp();
      const res = await app.request(`/user/${TEST_USER_ID}/configuration`);
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /user/:userId/configuration", () => {
    it("updates postSendView and returns full config", async () => {
      const accountDb = makeAccountDb();
      const { app } = buildApp({ accountDb });
      const res = await app.request(`/user/${TEST_USER_ID}/configuration`, {
        method: "PATCH",
        headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
        body: JSON.stringify({ postSendView: "stay_on_thread" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ postSendView: "stay_on_thread" });
      expect(accountDb.updateUserConfiguration).toHaveBeenCalledWith(TEST_USER_ID, { postSendView: "stay_on_thread" });
    });

    it("returns 403 when path userId does not match JWT userId", async () => {
      const { app } = buildApp();
      const res = await app.request("/user/other-user-id/configuration", {
        method: "PATCH",
        headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
        body: JSON.stringify({ postSendView: "stay_on_thread" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 for invalid postSendView value", async () => {
      const { app } = buildApp();
      const res = await app.request(`/user/${TEST_USER_ID}/configuration`, {
        method: "PATCH",
        headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
        body: JSON.stringify({ postSendView: "invalid_value" }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts empty body (no-op update)", async () => {
      const accountDb = makeAccountDb();
      const { app } = buildApp({ accountDb });
      const res = await app.request(`/user/${TEST_USER_ID}/configuration`, {
        method: "PATCH",
        headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(accountDb.updateUserConfiguration).toHaveBeenCalledWith(TEST_USER_ID, {});
    });
  });

  describe("GET /users/:userId (top-level profile lookup)", () => {
    it("returns name and picture for the target user", async () => {
      const access = makeAccess({ getUserProfile: vi.fn().mockResolvedValue(ok({ name: "Ada Lovelace", email: "ada@example.com", picture: "https://example.com/ada.png" })) });
      const { app } = buildApp({ access });
      const res = await app.request("/users/other-user-id", { headers: { Authorization: "Bearer valid-token" } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ name: "Ada Lovelace", picture: "https://example.com/ada.png" });
      expect(access.getUserProfile).toHaveBeenCalledWith("other-user-id");
    });

    it("does not include email in the response", async () => {
      const access = makeAccess({ getUserProfile: vi.fn().mockResolvedValue(ok({ name: "Ada Lovelace", email: "ada@example.com" })) });
      const { app } = buildApp({ access });
      const res = await app.request("/users/other-user-id", { headers: { Authorization: "Bearer valid-token" } });
      const body = await res.json();
      expect(body).not.toHaveProperty("email");
    });

    it("returns an empty object when the user has no profile data", async () => {
      const { app } = buildApp();
      const res = await app.request("/users/unknown-user-id", { headers: { Authorization: "Bearer valid-token" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    });

    it("allows any authenticated caller to look up a different user (no self-only or account-scoped restriction)", async () => {
      const { app } = buildApp({ auth: makeAuth("requesting-user") });
      const res = await app.request("/users/some-other-unrelated-user", { headers: { Authorization: "Bearer valid-token" } });
      expect(res.status).toBe(200);
    });

    it("returns 401 without auth header", async () => {
      const { app } = buildApp();
      const res = await app.request("/users/other-user-id");
      expect(res.status).toBe(401);
    });

    it("returns 503 when Authress is unavailable", async () => {
      const access = makeAccess({ getUserProfile: vi.fn().mockResolvedValue(err({ message: "boom" })) });
      const { app } = buildApp({ access });
      const res = await app.request("/users/other-user-id", { headers: { Authorization: "Bearer valid-token" } });
      expect(res.status).toBe(503);
    });
  });
});
