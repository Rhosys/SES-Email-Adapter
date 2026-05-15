import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "./app.js";
import type { ApiDatabase, AuthService, AuthContext, AccessService, VerificationMailer } from "./app.js";
import { ok } from "neverthrow";
import { createMockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Test doubles (minimal — only what's needed for migration verification)
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-migration-001";
const TEST_USER_ID = "user-migration-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

const validAuth: AuthContext = { accountId: TEST_ACCOUNT_ID, userId: TEST_USER_ID };

function makeAuth(): AuthService {
  return { verify: vi.fn().mockReturnValue(Promise.resolve(ok(validAuth))) };
}

function makeAccess(): AccessService {
  return {
    listUsers: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    addUser: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateUserRole: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    removeUser: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    checkAccess: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStore(): ApiDatabase {
  return {
    listArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getArc: vi.fn().mockResolvedValue(ok(null)),
    updateArc: vi.fn().mockResolvedValue(ok({})),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreArcSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    blockSignal: vi.fn().mockResolvedValue(ok({})),
    saveArc: vi.fn().mockResolvedValue(ok(undefined)),
    findArcByGroupingKey: vi.fn().mockResolvedValue(ok(null)),
    getSignal: vi.fn().mockResolvedValue(ok(null)),
    updateSignal: vi.fn().mockResolvedValue(ok({})),
    deleteSignal: vi.fn().mockResolvedValue(ok(undefined)),
    listViews: vi.fn().mockResolvedValue(ok([])),
    getView: vi.fn().mockResolvedValue(ok(null)),
    createView: vi.fn().mockResolvedValue(ok({})),
    updateView: vi.fn().mockResolvedValue(ok({})),
    deleteView: vi.fn().mockResolvedValue(ok(undefined)),
    listLabels: vi.fn().mockResolvedValue(ok([])),
    createLabel: vi.fn().mockResolvedValue(ok({})),
    updateLabel: vi.fn().mockResolvedValue(ok({})),
    deleteLabel: vi.fn().mockResolvedValue(ok(undefined)),
    listRules: vi.fn().mockResolvedValue(ok([])),
    createRule: vi.fn().mockResolvedValue(ok({})),
    updateRule: vi.fn().mockResolvedValue(ok({})),
    deleteRule: vi.fn().mockResolvedValue(ok(undefined)),
    listDomains: vi.fn().mockResolvedValue(ok([])),
    getDomain: vi.fn().mockResolvedValue(ok(null)),
    createDomain: vi.fn().mockResolvedValue(ok({})),
    deleteDomain: vi.fn().mockResolvedValue(ok(undefined)),
    searchArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getAccount: vi.fn().mockResolvedValue(ok(null)),
    updateAccount: vi.fn().mockResolvedValue(ok({})),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok({})),
    upsertAlias: vi.fn().mockResolvedValue(ok({})),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    unblockSignal: vi.fn().mockResolvedValue(ok(undefined)),
    createArc: vi.fn().mockResolvedValue(ok(undefined)),
    listVerifiedForwardingAddresses: vi.fn().mockResolvedValue(ok([])),
    getVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(null)),
    saveVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
    deleteVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
    updateDomainHealth: vi.fn().mockResolvedValue(ok(undefined)),
    renameAlias: vi.fn().mockResolvedValue(ok({})),
    saveSender: vi.fn().mockResolvedValue(ok(undefined)),
    removeSender: vi.fn().mockResolvedValue(ok(undefined)),
    listSenders: vi.fn().mockResolvedValue(ok([])),
    createTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    getTemplate: vi.fn().mockResolvedValue(ok(null)),
    updateTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    deleteTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    listTemplates: vi.fn().mockResolvedValue(ok([])),
    listAuditEvents: vi.fn().mockResolvedValue(ok({ items: [] })),
  } as unknown as ApiDatabase;
}

async function req(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<Response> {
  const { body, token = "valid-token" } = options;
  return app.fetch(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Route migration backward-compatibility tests
// ---------------------------------------------------------------------------

describe("Route migration — backward compatibility", () => {
  let store: ApiDatabase;
  let auth: AuthService;
  let access: AccessService;
  let verificationMailer: VerificationMailer;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    auth = makeAuth();
    access = makeAccess();
    verificationMailer = { sendForwardVerification: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
    app = createApp({ store, auth, access, logger: createMockLogger(), verificationMailer });
  });

  // -------------------------------------------------------------------------
  // Authorized users still get 200 (Requirements 6.1, 6.4)
  // -------------------------------------------------------------------------

  describe("authorized users get 200 responses", () => {
    it("GET /accounts/:accountId/arcs — returns 200 for authorized user", async () => {
      const res = await req(app, "GET", `${A}/arcs`);
      expect(res.status).toBe(200);
      expect(access.checkAccess).toHaveBeenCalledWith(
        TEST_USER_ID,
        `accounts/${TEST_ACCOUNT_ID}/arcs`,
        "arcs:read",
      );
    });

    it("GET /accounts/:accountId/views — returns 200 for authorized user", async () => {
      const res = await req(app, "GET", `${A}/views`);
      expect(res.status).toBe(200);
      expect(access.checkAccess).toHaveBeenCalledWith(
        TEST_USER_ID,
        `accounts/${TEST_ACCOUNT_ID}/views`,
        "views:read",
      );
    });

    it("GET /accounts/:accountId/labels — returns 200 for authorized user", async () => {
      const res = await req(app, "GET", `${A}/labels`);
      expect(res.status).toBe(200);
      expect(access.checkAccess).toHaveBeenCalledWith(
        TEST_USER_ID,
        `accounts/${TEST_ACCOUNT_ID}/labels`,
        "labels:read",
      );
    });

    it("GET /accounts/:accountId/rules — returns 200 for authorized user", async () => {
      const res = await req(app, "GET", `${A}/rules`);
      expect(res.status).toBe(200);
      expect(access.checkAccess).toHaveBeenCalledWith(
        TEST_USER_ID,
        `accounts/${TEST_ACCOUNT_ID}/rules`,
        "rules:read",
      );
    });

    it("GET /accounts/:accountId/domains — returns 200 for authorized user", async () => {
      const res = await req(app, "GET", `${A}/domains`);
      expect(res.status).toBe(200);
      expect(access.checkAccess).toHaveBeenCalledWith(
        TEST_USER_ID,
        `accounts/${TEST_ACCOUNT_ID}/domains`,
        "domains:read",
      );
    });

    it("GET /accounts/:accountId/aliases — returns 200 for authorized user", async () => {
      const res = await req(app, "GET", `${A}/aliases`);
      expect(res.status).toBe(200);
      expect(access.checkAccess).toHaveBeenCalledWith(
        TEST_USER_ID,
        `accounts/${TEST_ACCOUNT_ID}/aliases`,
        "aliases:read",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Unauthorized users get 403 (Requirements 6.2)
  // -------------------------------------------------------------------------

  describe("unauthorized users get 403 from per-route middleware", () => {
    const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });

    it("GET /accounts/:accountId/arcs — returns 403 when access denied", async () => {
      vi.mocked(access.checkAccess).mockRejectedValueOnce(forbidden);
      const res = await req(app, "GET", `${A}/arcs`);
      expect(res.status).toBe(403);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("AccessDenied");
    });

    it("GET /accounts/:accountId/views — returns 403 when access denied", async () => {
      vi.mocked(access.checkAccess).mockRejectedValueOnce(forbidden);
      const res = await req(app, "GET", `${A}/views`);
      expect(res.status).toBe(403);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("AccessDenied");
    });

    it("GET /accounts/:accountId/labels — returns 403 when access denied", async () => {
      vi.mocked(access.checkAccess).mockRejectedValueOnce(forbidden);
      const res = await req(app, "GET", `${A}/labels`);
      expect(res.status).toBe(403);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("AccessDenied");
    });

    it("GET /accounts/:accountId/rules — returns 403 when access denied", async () => {
      vi.mocked(access.checkAccess).mockRejectedValueOnce(forbidden);
      const res = await req(app, "GET", `${A}/rules`);
      expect(res.status).toBe(403);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("AccessDenied");
    });

    it("GET /accounts/:accountId/domains — returns 403 when access denied", async () => {
      vi.mocked(access.checkAccess).mockRejectedValueOnce(forbidden);
      const res = await req(app, "GET", `${A}/domains`);
      expect(res.status).toBe(403);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("AccessDenied");
    });

    it("GET /accounts/:accountId/aliases — returns 403 when access denied", async () => {
      vi.mocked(access.checkAccess).mockRejectedValueOnce(forbidden);
      const res = await req(app, "GET", `${A}/aliases`);
      expect(res.status).toBe(403);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("AccessDenied");
    });

    it("route handler is NOT called when authorization fails", async () => {
      vi.mocked(access.checkAccess).mockRejectedValueOnce(forbidden);
      await req(app, "GET", `${A}/arcs`);
      // store.listArcs should not be called because the middleware short-circuits
      expect(store.listArcs).not.toHaveBeenCalled();
    });
  });
});
