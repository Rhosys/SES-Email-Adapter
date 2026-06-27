import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { ok } from "neverthrow";
import { USER_CONFIGURATION_DEFAULTS } from "../../src/types/index.js";
import type { IUserConfiguration } from "../../src/types/index.js";

const TEST_USER_ID = "user-cfg-001";

function makeAuth(userId = TEST_USER_ID) {
  return { verify: vi.fn().mockResolvedValue(ok({ userId })) };
}

function makeAccess() {
  return {
    listUsers: vi.fn().mockResolvedValue(ok([])),
    getUserProfile: vi.fn().mockResolvedValue(ok({})),
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

function buildApp(overrides: { accountDb?: ReturnType<typeof makeAccountDb>; auth?: ReturnType<typeof makeAuth> } = {}) {
  const logger = createMockLogger();
  const accountDb = overrides.accountDb ?? makeAccountDb();
  const auth = overrides.auth ?? makeAuth();
  const app = createApp(makeAppDeps({ accountDb: accountDb as never, auth, access: makeAccess() as never, logger }));
  return { app, accountDb, auth };
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
      expect(body).toEqual({ afterSendAction: "keep_active" });
    });

    it("returns stored config when it exists", async () => {
      const accountDb = makeAccountDb({ afterSendAction: "archive" });
      const { app } = buildApp({ accountDb });
      const res = await app.request(`/user/${TEST_USER_ID}/configuration`, {
        headers: { Authorization: "Bearer valid-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ afterSendAction: "archive" });
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
    it("updates afterSendAction and returns full config", async () => {
      const accountDb = makeAccountDb();
      const { app } = buildApp({ accountDb });
      const res = await app.request(`/user/${TEST_USER_ID}/configuration`, {
        method: "PATCH",
        headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
        body: JSON.stringify({ afterSendAction: "archive" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ afterSendAction: "archive" });
      expect(accountDb.updateUserConfiguration).toHaveBeenCalledWith(TEST_USER_ID, { afterSendAction: "archive" });
    });

    it("returns 403 when path userId does not match JWT userId", async () => {
      const { app } = buildApp();
      const res = await app.request("/user/other-user-id/configuration", {
        method: "PATCH",
        headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
        body: JSON.stringify({ afterSendAction: "archive" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 for invalid afterSendAction value", async () => {
      const { app } = buildApp();
      const res = await app.request(`/user/${TEST_USER_ID}/configuration`, {
        method: "PATCH",
        headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
        body: JSON.stringify({ afterSendAction: "invalid_value" }),
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
});
