import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "./app.js";
import type { ApiDatabase, AuthService, AuthContext, AccessService, VerificationMailer } from "./app.js";
import { ok, err } from "neverthrow";
import { okAsync } from "neverthrow";
import type { DbError, NotFoundError } from "../errors.js";
import { dbError, notFoundError } from "../errors.js";
import type { Arc, Account, Alias } from "../types/index.js";
import { createMockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-err-001";
const TEST_USER_ID = "user-err-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

const validAuth: AuthContext = { accountId: TEST_ACCOUNT_ID, userId: TEST_USER_ID };

function makeAuth(): AuthService {
  return { verify: vi.fn().mockResolvedValue(validAuth) };
}

function makeAccess(): AccessService {
  return {
    listUsers: vi.fn().mockReturnValue(okAsync([])),
    addUser: vi.fn().mockReturnValue(okAsync(undefined)),
    updateUserRole: vi.fn().mockReturnValue(okAsync(undefined)),
    removeUser: vi.fn().mockReturnValue(okAsync(undefined)),
    checkAccess: vi.fn().mockResolvedValue(undefined),
  };
}

function makeArc(overrides: Partial<Arc> = {}): Arc {
  return {
    id: "arc-001",
    accountId: TEST_ACCOUNT_ID,
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "A test arc.",
    lastSignalAt: "2024-01-15T10:00:00Z",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: TEST_ACCOUNT_ID,
    name: "Test Account",
    deletionRetentionDays: 30,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeAlias(overrides: Partial<Alias> = {}): Alias {
  return {
    id: "alias-001",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    filterMode: "quarantine_visible",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeStore(): ApiDatabase {
  return {
    listArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getArc: vi.fn().mockResolvedValue(ok(null)),
    updateArc: vi.fn().mockResolvedValue(ok(makeArc())),
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
    updateAccount: vi.fn().mockResolvedValue(ok(makeAccount())),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok(makeAlias())),
    upsertAlias: vi.fn().mockResolvedValue(ok(makeAlias())),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    unblockSignal: vi.fn().mockResolvedValue(ok(undefined)),
    createArc: vi.fn().mockResolvedValue(ok(undefined)),
    listVerifiedForwardingAddresses: vi.fn().mockResolvedValue(ok([])),
    getVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(null)),
    saveVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
    deleteVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
    updateDomainHealth: vi.fn().mockResolvedValue(ok(undefined)),
    renameAlias: vi.fn().mockResolvedValue(ok(makeAlias())),
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
// Unit tests: API route error mapping (Requirements 4.1–4.6, 8.1–8.3)
// ---------------------------------------------------------------------------

describe("API route error mapping — unit tests", () => {
  let store: ApiDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    const auth = makeAuth();
    const access = makeAccess();
    const verificationMailer: VerificationMailer = { sendForwardVerification: vi.fn().mockReturnValue(okAsync(undefined)) };
    app = createApp({ store, auth, access, logger: createMockLogger(), verificationMailer });
  });

  // -------------------------------------------------------------------------
  // GET /accounts/:accountId/arcs/:id
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/arcs/:id", () => {
    it("returns HTTP 500 when store returns err({ kind: 'db_error' })", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(err(dbError(new Error("connection timeout"))));
      const res = await req(app, "GET", `${A}/arcs/arc-001`);
      expect(res.status).toBe(500);
      const body = await res.json() as { title: string };
      expect(body.title).toBe("Internal Server Error");
    });

    it("returns HTTP 404 when store returns ok(null)", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(null));
      const res = await req(app, "GET", `${A}/arcs/arc-001`);
      expect(res.status).toBe(404);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("ARC_NOT_FOUND");
    });

    it("returns HTTP 200 when store returns ok(arc)", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc()));
      const res = await req(app, "GET", `${A}/arcs/arc-001`);
      expect(res.status).toBe(200);
      const body = await res.json() as Arc;
      expect(body.id).toBe("arc-001");
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /accounts/:accountId/arcs/:id
  // -------------------------------------------------------------------------

  describe("PATCH /accounts/:accountId/arcs/:id", () => {
    it("returns HTTP 500 when getArc returns err({ kind: 'db_error' })", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(err(dbError(new Error("dynamo unavailable"))));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(500);
    });

    it("returns HTTP 404 when getArc returns ok(null)", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(null));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(404);
    });

    it("returns HTTP 500 when updateArc returns err({ kind: 'db_error' })", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc()));
      vi.mocked(store.updateArc).mockResolvedValueOnce(err(dbError(new Error("write failed"))));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(500);
    });

    it("returns HTTP 200 when update succeeds", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc()));
      vi.mocked(store.updateArc).mockResolvedValueOnce(ok(makeArc({ status: "archived" })));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(200);
      const body = await res.json() as Arc;
      expect(body.status).toBe("archived");
    });

    it("zParse throws HTTPException for invalid request body", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc()));
      // Send an invalid body — status must be one of "active" | "archived" | "deleted"
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "invalid_status" } });
      expect(res.status).toBe(400);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("INVALID_REQUEST");
    });
  });

  // -------------------------------------------------------------------------
  // GET /accounts/:accountId
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId", () => {
    it("returns HTTP 500 when store returns err({ kind: 'db_error' })", async () => {
      vi.mocked(store.getAccount).mockResolvedValueOnce(err(dbError(new Error("rds timeout"))));
      const res = await req(app, "GET", `${A}`);
      expect(res.status).toBe(500);
      const body = await res.json() as { title: string };
      expect(body.title).toBe("Internal Server Error");
    });

    it("returns HTTP 404 when store returns ok(null)", async () => {
      vi.mocked(store.getAccount).mockResolvedValueOnce(ok(null));
      const res = await req(app, "GET", `${A}`);
      expect(res.status).toBe(404);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("ACCOUNT_NOT_FOUND");
    });

    it("returns HTTP 200 when store returns ok(account)", async () => {
      vi.mocked(store.getAccount).mockResolvedValueOnce(ok(makeAccount()));
      const res = await req(app, "GET", `${A}`);
      expect(res.status).toBe(200);
      const body = await res.json() as Account;
      expect(body.id).toBe(TEST_ACCOUNT_ID);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /accounts/:accountId/aliases/:address (rename)
  // -------------------------------------------------------------------------

  describe("PATCH /accounts/:accountId/aliases/:address — rename", () => {
    it("returns HTTP 404 when renameAlias returns err({ kind: 'not_found' })", async () => {
      vi.mocked(store.renameAlias).mockResolvedValueOnce(
        err(notFoundError("alias", "old@example.com")),
      );
      const res = await req(app, "PATCH", `${A}/aliases/old%40example.com`, {
        body: { newAddress: "new@example.com" },
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("ALIAS_NOT_FOUND");
    });

    it("returns HTTP 500 when renameAlias returns err({ kind: 'db_error' })", async () => {
      vi.mocked(store.renameAlias).mockResolvedValueOnce(
        err(dbError(new Error("transact write failed"))),
      );
      const res = await req(app, "PATCH", `${A}/aliases/old%40example.com`, {
        body: { newAddress: "new@example.com" },
      });
      expect(res.status).toBe(500);
      const body = await res.json() as { title: string };
      expect(body.title).toBe("Internal Server Error");
    });

    it("returns HTTP 200 when renameAlias succeeds", async () => {
      vi.mocked(store.renameAlias).mockResolvedValueOnce(
        ok(makeAlias({ address: "new@example.com" })),
      );
      const res = await req(app, "PATCH", `${A}/aliases/old%40example.com`, {
        body: { newAddress: "new@example.com" },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Alias;
      expect(body.address).toBe("new@example.com");
    });

    it("zParse throws HTTPException for invalid newAddress format", async () => {
      const res = await req(app, "PATCH", `${A}/aliases/old%40example.com`, {
        body: { newAddress: "not-an-email" },
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("INVALID_REQUEST");
    });
  });

  // -------------------------------------------------------------------------
  // zParse throws HTTPException (Requirement 4.6)
  // -------------------------------------------------------------------------

  describe("zParse — HTTPException contract", () => {
    it("throws HTTPException with 400 status for completely invalid JSON", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc()));
      // Send a request with non-JSON body to trigger zParse failure
      const res = await app.fetch(
        new Request(`http://localhost/api${A}/arcs/arc-001`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer valid-token",
          },
          body: "not json at all",
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("INVALID_REQUEST");
    });
  });
});
