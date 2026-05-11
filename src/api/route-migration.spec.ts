import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "./app.js";
import type { ApiDatabase, AuthService, AuthContext, AccessService, VerificationMailer } from "./app.js";

// ---------------------------------------------------------------------------
// Test doubles (minimal — only what's needed for migration verification)
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-migration-001";
const TEST_USER_ID = "user-migration-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

const validAuth: AuthContext = { accountId: TEST_ACCOUNT_ID, userId: TEST_USER_ID };

function makeAuth(): AuthService {
  return { verify: vi.fn().mockResolvedValue(validAuth) };
}

function makeAccess(): AccessService {
  return {
    listUsers: vi.fn().mockResolvedValue([]),
    addUser: vi.fn().mockResolvedValue(undefined),
    updateUserRole: vi.fn().mockResolvedValue(undefined),
    removeUser: vi.fn().mockResolvedValue(undefined),
    checkAccess: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStore(): ApiDatabase {
  return {
    listArcs: vi.fn().mockResolvedValue({ items: [] }),
    getArc: vi.fn().mockResolvedValue(null),
    updateArc: vi.fn().mockResolvedValue({}),
    listSignals: vi.fn().mockResolvedValue({ items: [] }),
    listPreArcSignals: vi.fn().mockResolvedValue({ items: [] }),
    blockSignal: vi.fn().mockResolvedValue({}),
    saveArc: vi.fn().mockResolvedValue(undefined),
    findArcByGroupingKey: vi.fn().mockResolvedValue(null),
    getSignal: vi.fn().mockResolvedValue(null),
    updateSignal: vi.fn().mockResolvedValue({}),
    deleteSignal: vi.fn().mockResolvedValue(undefined),
    listViews: vi.fn().mockResolvedValue([]),
    getView: vi.fn().mockResolvedValue(null),
    createView: vi.fn().mockResolvedValue({}),
    updateView: vi.fn().mockResolvedValue({}),
    deleteView: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue({}),
    updateLabel: vi.fn().mockResolvedValue({}),
    deleteLabel: vi.fn().mockResolvedValue(undefined),
    listRules: vi.fn().mockResolvedValue([]),
    createRule: vi.fn().mockResolvedValue({}),
    updateRule: vi.fn().mockResolvedValue({}),
    deleteRule: vi.fn().mockResolvedValue(undefined),
    listDomains: vi.fn().mockResolvedValue([]),
    getDomain: vi.fn().mockResolvedValue(null),
    createDomain: vi.fn().mockResolvedValue({}),
    deleteDomain: vi.fn().mockResolvedValue(undefined),
    searchArcs: vi.fn().mockResolvedValue({ items: [] }),
    getAccount: vi.fn().mockResolvedValue(null),
    updateAccount: vi.fn().mockResolvedValue({}),
    listAliases: vi.fn().mockResolvedValue([]),
    getAlias: vi.fn().mockResolvedValue(null),
    createAlias: vi.fn().mockResolvedValue({}),
    upsertAlias: vi.fn().mockResolvedValue({}),
    deleteAlias: vi.fn().mockResolvedValue(undefined),
    unblockSignal: vi.fn().mockResolvedValue(undefined),
    createArc: vi.fn().mockResolvedValue(undefined),
    listVerifiedForwardingAddresses: vi.fn().mockResolvedValue([]),
    getVerifiedForwardingAddress: vi.fn().mockResolvedValue(null),
    saveVerifiedForwardingAddress: vi.fn().mockResolvedValue(undefined),
    deleteVerifiedForwardingAddress: vi.fn().mockResolvedValue(undefined),
    updateDomainHealth: vi.fn().mockResolvedValue(undefined),
    renameAlias: vi.fn().mockResolvedValue({}),
    saveSender: vi.fn().mockResolvedValue(undefined),
    removeSender: vi.fn().mockResolvedValue(undefined),
    listSenders: vi.fn().mockResolvedValue([]),
    createTemplate: vi.fn().mockResolvedValue(undefined),
    getTemplate: vi.fn().mockResolvedValue(null),
    updateTemplate: vi.fn().mockResolvedValue(undefined),
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
    listTemplates: vi.fn().mockResolvedValue([]),
    listAuditEvents: vi.fn().mockResolvedValue({ items: [] }),
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
    verificationMailer = { sendForwardVerification: vi.fn().mockResolvedValue(undefined) };
    app = createApp({ store, auth, access, verificationMailer });
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
