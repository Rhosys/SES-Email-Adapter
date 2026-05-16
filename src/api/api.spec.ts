import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Arc, Signal, View, Label, Rule, Domain, Account, Alias, VerifiedForwardingAddress } from "../types/index.js";
import { createApp } from "./app.js";
import type { ApiDatabase, AuthService, AccessService, AccountUser, VerificationMailer } from "./app.js";
import { ok, err } from "neverthrow";
import { createMockLogger } from "../testing/mock-logger.js";
import { authError } from "../errors.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-test-001";
const TEST_USER_ID = "user-test-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

const validAuth = { userId: TEST_USER_ID };

function makeAuth(ctx: { userId: string } = validAuth): AuthService {
  return { verify: vi.fn().mockReturnValue(Promise.resolve(ok(ctx))) };
}

function makeAccess(): AccessService {
  return {
    listUsers: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    listAccountsForUser: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
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
    updateArc: vi.fn().mockResolvedValue(ok(makeArc())),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreArcSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    updateSignalStatus: vi.fn().mockImplementation((_, id, status) => Promise.resolve(ok({ id, status }))),
    saveArc: vi.fn().mockResolvedValue(ok(undefined)),
    findArcByGroupingKey: vi.fn().mockResolvedValue(ok(null)),
    getSignal: vi.fn().mockResolvedValue(ok(null)),
    updateSignal: vi.fn().mockResolvedValue(ok(makeSignal())),
    deleteSignal: vi.fn().mockResolvedValue(ok(undefined)),
    listViews: vi.fn().mockResolvedValue(ok([])),
    getView: vi.fn().mockResolvedValue(ok(null)),
    createView: vi.fn().mockResolvedValue(ok(makeView())),
    updateView: vi.fn().mockResolvedValue(ok(makeView())),
    deleteView: vi.fn().mockResolvedValue(ok(undefined)),
    listLabels: vi.fn().mockResolvedValue(ok([])),
    createLabel: vi.fn().mockResolvedValue(ok(makeLabel())),
    updateLabel: vi.fn().mockResolvedValue(ok(makeLabel())),
    deleteLabel: vi.fn().mockResolvedValue(ok(undefined)),
    listRules: vi.fn().mockResolvedValue(ok([])),
    createRule: vi.fn().mockResolvedValue(ok(makeRule())),
    updateRule: vi.fn().mockResolvedValue(ok(makeRule())),
    deleteRule: vi.fn().mockResolvedValue(ok(undefined)),
    listDomains: vi.fn().mockResolvedValue(ok([])),
    getDomain: vi.fn().mockResolvedValue(ok(null)),
    createDomain: vi.fn().mockResolvedValue(ok(makeDomain())),
    deleteDomain: vi.fn().mockResolvedValue(ok(undefined)),
    searchArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getAccount: vi.fn().mockResolvedValue(ok(null)),
    createAccount: vi.fn().mockImplementation((a) => Promise.resolve(ok(a))),
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
  };
}

function makeVerifiedAddress(overrides: Partial<VerifiedForwardingAddress> = {}): VerifiedForwardingAddress {
  return {
    id: "fwdaddr-001",
    accountId: TEST_ACCOUNT_ID,
    address: "backup@personal.com",
    status: "verified",
    token: "tok-abc123",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeAlias(overrides: Partial<Alias> = {}): Alias {
  return {
    id: "cfg-001",
    accountId: TEST_ACCOUNT_ID,
    address: "user@example.com",
    unknownSenderPolicy: "quarantine_visible",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
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

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "SES#msg-001",
    arcId: "arc-001",
    accountId: TEST_ACCOUNT_ID,
    source: "email" as const,
    receivedAt: "2024-01-15T10:00:00Z",
    from: { address: "sender@example.com", name: "Sender" },
    to: [{ address: "user@example.com" }],
    cc: [],
    subject: "Test email",
    attachments: [],
    headers: {},
    recipientAddress: "user@example.com",
    workflow: "conversation",
    workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.02,
    summary: "A test signal.",
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    s3Key: "emails/msg-001",
    status: "active",
    createdAt: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}

function makeView(overrides: Partial<View> = {}): View {
  return {
    id: "view-001",
    accountId: TEST_ACCOUNT_ID,
    name: "Personal",
    labels: [],
    sortField: "lastSignalAt",
    sortDirection: "desc",
    position: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeLabel(overrides: Partial<Label> = {}): Label {
  return {
    id: "label-001",
    accountId: TEST_ACCOUNT_ID,
    name: "billing",
    color: "#ff0000",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule-001",
    accountId: TEST_ACCOUNT_ID,
    name: "Archive newsletters",
    condition: '{"==": [{"var": "arc.category"}, "newsletter"]}',
    actions: [{ type: "archive" }],
    status: "enabled",
    priorityOrder: 100,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: "example.com",
    accountId: TEST_ACCOUNT_ID,
    domain: "example.com",
    receivingSetupComplete: false,
    senderSetupComplete: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
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
// Tests
// ---------------------------------------------------------------------------

describe("API", () => {
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
  // Authentication & account authorization
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await req(app, "GET", `${A}/arcs`, { token: "" });
      expect(res.status).toBe(401);
    });

    it("returns 401 when token is invalid", async () => {
      vi.mocked(auth.verify).mockReturnValueOnce(Promise.resolve(err(authError(new Error("Invalid token")))));
      const res = await req(app, "GET", `${A}/arcs`, { token: "bad-token" });
      expect(res.status).toBe(401);
    });

    it("returns 403 when authorization check fails", async () => {
      // The authorize() middleware calls access.checkAccess which rejects with 403
      vi.mocked(access.checkAccess).mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
      const res = await req(app, "GET", `${A}/arcs`);
      expect(res.status).toBe(403);
    });

    it("extracts accountId from URL path into auth context", async () => {
      await req(app, "GET", `${A}/arcs`);
      // The auth.verify was called (authentication happened)
      expect(auth.verify).toHaveBeenCalledWith("valid-token");
    });
  });

  // -------------------------------------------------------------------------
  // Arc routes
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/arcs", () => {
    it("returns paginated Arc list in named envelope", async () => {
      vi.mocked(store.listArcs).mockResolvedValueOnce(ok({ items: [makeArc()] }));
      const res = await req(app, "GET", `${A}/arcs`);
      expect(res.status).toBe(200);
      const body = await res.json() as { arcs: unknown[]; pagination: { cursor: string | null } };
      expect(body.arcs).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
    });

    it("passes workflow and label filters to the store", async () => {
      await req(app, "GET", `${A}/arcs?workflow=payments&label=billing&limit=25`);
      expect(store.listArcs).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ workflow: "payments", label: "billing", limit: 25 }),
      );
    });

    it("passes status filter to the store", async () => {
      await req(app, "GET", `${A}/arcs?status=archived`);
      expect(store.listArcs).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ status: "archived" }),
      );
    });

    it("passes cursor and limit pagination params to the store", async () => {
      await req(app, "GET", `${A}/arcs?cursor=next-page-token&limit=10`);
      expect(store.listArcs).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ cursor: "next-page-token", limit: 10 }),
      );
    });

    it("returns cursor in pagination envelope when store returns nextCursor", async () => {
      vi.mocked(store.listArcs).mockResolvedValueOnce(ok({ items: [makeArc()], nextCursor: "cursor-abc" }));
      const res = await req(app, "GET", `${A}/arcs`);
      const body = await res.json() as { pagination: { cursor: string } };
      expect(body.pagination.cursor).toBe("cursor-abc");
    });
  });

  describe("GET /accounts/:accountId/arcs/:id", () => {
    it("returns Arc detail", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc()));
      const res = await req(app, "GET", `${A}/arcs/arc-001`);
      expect(res.status).toBe(200);
      const body = await res.json() as Arc;
      expect(body.id).toBe("arc-001");
    });

    it("returns 404 for unknown Arc", async () => {
      const res = await req(app, "GET", `${A}/arcs/nonexistent`);
      expect(res.status).toBe(404);
    });

    it("returns 403 when Arc belongs to a different account", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc({ accountId: "other-account" })));
      const res = await req(app, "GET", `${A}/arcs/arc-001`);
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /accounts/:accountId/arcs/:id", () => {
    it("archives an Arc", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc()));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(200);
      expect(store.updateArc).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, "arc-001", expect.objectContaining({ status: "archived" }),
      );
    });

    it("assigns labels to an Arc", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc()));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { labels: ["billing", "urgent"] } });
      expect(res.status).toBe(200);
      expect(store.updateArc).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, "arc-001", expect.objectContaining({ labels: ["billing", "urgent"] }),
      );
    });

    it("returns 404 for unknown Arc", async () => {
      const res = await req(app, "PATCH", `${A}/arcs/nonexistent`, { body: { status: "archived" } });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Signal routes
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/arcs/:arcId/signals", () => {
    it("lists Signals for an Arc in named envelope", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(ok(makeArc()));
      vi.mocked(store.listSignals).mockResolvedValueOnce(ok({ items: [makeSignal()] }));
      const res = await req(app, "GET", `${A}/arcs/arc-001/signals`);
      expect(res.status).toBe(200);
      const body = await res.json() as { signals: unknown[]; pagination: { cursor: string | null } };
      expect(body.signals).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
    });

    it("returns 404 when Arc does not exist", async () => {
      const res = await req(app, "GET", `${A}/arcs/nonexistent/signals`);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /accounts/:accountId/signals?status=", () => {
    it("returns quarantined signals (both visible and hidden) when status=quarantined", async () => {
      const s = makeSignal({ status: "quarantine_visible" });
      vi.mocked(store.listPreArcSignals).mockResolvedValueOnce(ok({ items: [s] }));
      const res = await req(app, "GET", `${A}/signals?status=quarantined`);
      expect(res.status).toBe(200);
      const body = await res.json() as { signals: Signal[]; pagination: { cursor: string | null } };
      expect(body.signals).toHaveLength(1);
      expect(store.listPreArcSignals).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "quarantined", expect.any(Object));
    });

    it("returns 400 when status is blocked (no longer supported)", async () => {
      const res = await req(app, "GET", `${A}/signals?status=blocked`);
      expect(res.status).toBe(400);
    });

    it("returns 400 when status param is missing", async () => {
      const res = await req(app, "GET", `${A}/signals`);
      expect(res.status).toBe(400);
    });

    it("returns 400 when status param is invalid", async () => {
      const res = await req(app, "GET", `${A}/signals?status=active`);
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /accounts/:accountId/signals/:id/quarantineResponse", () => {
    it("blocks a quarantined signal", async () => {
      const s = makeSignal({ status: "quarantine_visible" });
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(s));
      const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "block_hidden" } });
      expect(res.status).toBe(200);
      expect(store.updateSignalStatus).toHaveBeenCalledWith(TEST_ACCOUNT_ID, s.id, "block_hidden");
    });

    it("allows a quarantined signal — creates new arc when no grouping key match", async () => {
      const s = makeSignal({ status: "quarantine_visible" });
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(s));
      vi.mocked(store.findArcByGroupingKey).mockResolvedValueOnce(ok(null));
      const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
      expect(res.status).toBe(200);
      const body = await res.json() as { arc: Arc; signal: Signal };
      expect(body.arc.workflow).toBe(s.workflow);
      expect(body.signal.status).toBe("active");
      expect(store.createArc).toHaveBeenCalledOnce();
      expect(store.unblockSignal).toHaveBeenCalledWith(TEST_ACCOUNT_ID, s.id, body.arc.id);
    });

    it("allows a quarantined signal — attaches to existing arc when grouping key matches", async () => {
      const s = makeSignal({ status: "quarantine_visible", workflow: "auth" });
      const existingArc = makeArc();
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(s));
      vi.mocked(store.findArcByGroupingKey).mockResolvedValueOnce(ok(existingArc));
      const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
      expect(res.status).toBe(200);
      const body = await res.json() as { arc: Arc; signal: Signal };
      expect(body.arc.id).toBe(existingArc.id);
      expect(store.createArc).not.toHaveBeenCalled();
      expect(store.unblockSignal).toHaveBeenCalledWith(TEST_ACCOUNT_ID, s.id, existingArc.id);
    });

    it("returns 400 when signal is already active", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ status: "active" })));
      const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
      expect(res.status).toBe(400);
    });

    it("returns 400 when body is missing status", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ status: "quarantine_visible" })));
      const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: {} });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown signal", async () => {
      const res = await req(app, "POST", `${A}/signals/nonexistent/quarantineResponse`, { body: { status: "active" } });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /accounts/:accountId/signals/:id", () => {
    it("returns full Signal detail", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ textBody: "Hello world" })));
      const res = await req(app, "GET", `${A}/signals/SES%23msg-001`);
      expect(res.status).toBe(200);
      const body = await res.json() as Signal;
      expect(body.id).toBe("SES#msg-001");
      expect(body.textBody).toBe("Hello world");
    });

    it("returns 404 for unknown Signal", async () => {
      const res = await req(app, "GET", `${A}/signals/nonexistent`);
      expect(res.status).toBe(404);
    });

    it("returns 403 when Signal belongs to a different account", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ accountId: "other-account" })));
      const res = await req(app, "GET", `${A}/signals/SES%23msg-001`);
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /accounts/:accountId/signals/:id — draft update", () => {
    it("updates a draft signal and returns 200 + full resource", async () => {
      const draft = makeSignal({ status: "draft" });
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(draft));
      vi.mocked(store.updateSignal).mockResolvedValueOnce(ok({ ...draft, subject: "Updated subject" }));
      const res = await req(app, "PATCH", `${A}/signals/SES%23msg-001`, { body: { subject: "Updated subject" } });
      expect(res.status).toBe(200);
      const body = await res.json() as Signal;
      expect(body.subject).toBe("Updated subject");
      expect(store.updateSignal).toHaveBeenCalledWith(TEST_ACCOUNT_ID, draft.id, expect.objectContaining({ subject: "Updated subject" }));
    });

    it("returns 400 when signal is not a draft", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ status: "active" })));
      const res = await req(app, "PATCH", `${A}/signals/SES%23msg-001`, { body: { subject: "x" } });
      expect(res.status).toBe(400);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("SIGNAL_NOT_DRAFT");
    });

    it("returns 404 for unknown signal", async () => {
      const res = await req(app, "PATCH", `${A}/signals/nonexistent`, { body: { subject: "x" } });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /accounts/:accountId/signals/:id/send — send draft", () => {
    it("sends a draft signal and returns 200 + updated signal", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ status: "draft" })));
      const res = await req(app, "POST", `${A}/signals/SES%23msg-001/send`);
      expect(res.status).toBe(200);
      expect(store.updateSignal).toHaveBeenCalledOnce();
    });

    it("returns 400 when signal is not a draft", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ status: "active" })));
      const res = await req(app, "POST", `${A}/signals/SES%23msg-001/send`);
      expect(res.status).toBe(400);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("SIGNAL_NOT_DRAFT");
    });

    it("returns 404 for unknown signal", async () => {
      const res = await req(app, "POST", `${A}/signals/nonexistent/send`);
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /accounts/:accountId/signals/:id — discard draft", () => {
    it("deletes a draft signal and returns 204", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ status: "draft" })));
      const res = await req(app, "DELETE", `${A}/signals/SES%23msg-001`);
      expect(res.status).toBe(204);
      expect(store.deleteSignal).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "SES#msg-001");
    });

    it("returns 400 when signal is not a draft", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(ok(makeSignal({ status: "active" })));
      const res = await req(app, "DELETE", `${A}/signals/SES%23msg-001`);
      expect(res.status).toBe(400);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("SIGNAL_NOT_DRAFT");
    });

    it("returns 404 for unknown signal", async () => {
      const res = await req(app, "DELETE", `${A}/signals/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // View routes
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/views", () => {
    it("returns all Views in named envelope", async () => {
      vi.mocked(store.listViews).mockResolvedValueOnce(ok([makeView(), makeView({ id: "view-002" })]));
      const res = await req(app, "GET", `${A}/views`);
      expect(res.status).toBe(200);
      const body = await res.json() as { views: View[]; pagination: { cursor: null } };
      expect(body.views).toHaveLength(2);
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("POST /accounts/:accountId/views", () => {
    it("creates a View and returns 201", async () => {
      vi.mocked(store.createView).mockResolvedValueOnce(ok(makeView({ id: "view-new" }) as never));
      const res = await req(app, "POST", `${A}/views`, {
        body: { name: "Invoices", workflow: "payments", sortField: "lastSignalAt", sortDirection: "desc" },
      });
      expect(res.status).toBe(201);
      expect(store.createView).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, expect.objectContaining({ name: "Invoices", workflow: "payments" }),
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await req(app, "POST", `${A}/views`, { body: { workflow: "payments" } });
      expect(res.status).toBe(400);
    });

    it("returns 400 when workflow is invalid", async () => {
      const res = await req(app, "POST", `${A}/views`, { body: { name: "Bad", workflow: "not-a-workflow" } });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /accounts/:accountId/views/:id", () => {
    it("updates View properties", async () => {
      vi.mocked(store.getView).mockResolvedValueOnce(ok(makeView()));
      const res = await req(app, "PATCH", `${A}/views/view-001`, { body: { name: "Updated", color: "#00ff00" } });
      expect(res.status).toBe(200);
      expect(store.updateView).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, "view-001", expect.objectContaining({ name: "Updated" }),
      );
    });

    it("returns 404 for unknown View", async () => {
      const res = await req(app, "PATCH", `${A}/views/nonexistent`, { body: { name: "X" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /accounts/:accountId/views/:id", () => {
    it("deletes the View", async () => {
      vi.mocked(store.getView).mockResolvedValueOnce(ok(makeView()));
      const res = await req(app, "DELETE", `${A}/views/view-001`);
      expect(res.status).toBe(204);
      expect(store.deleteView).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "view-001");
    });
  });

  // -------------------------------------------------------------------------
  // Label routes
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/labels", () => {
    it("returns all Labels in named envelope", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce(ok([makeLabel()]));
      const res = await req(app, "GET", `${A}/labels`);
      expect(res.status).toBe(200);
      const body = await res.json() as { labels: Label[]; pagination: { cursor: null } };
      expect(body.labels).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("POST /accounts/:accountId/labels", () => {
    it("creates a Label and returns 201", async () => {
      vi.mocked(store.createLabel).mockResolvedValueOnce(ok(makeLabel() as never));
      const res = await req(app, "POST", `${A}/labels`, { body: { name: "urgent", color: "#ff0000" } });
      expect(res.status).toBe(201);
      expect(store.createLabel).toHaveBeenCalledWith(TEST_ACCOUNT_ID, expect.objectContaining({ name: "urgent" }));
    });

    it("returns 400 when name is missing", async () => {
      const res = await req(app, "POST", `${A}/labels`, { body: { color: "#ff0000" } });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /accounts/:accountId/labels/:id", () => {
    it("updates Label", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce(ok([makeLabel()]));
      const res = await req(app, "PATCH", `${A}/labels/label-001`, { body: { name: "billing" } });
      expect(res.status).toBe(200);
      expect(store.updateLabel).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, "label-001", expect.objectContaining({ name: "billing" }),
      );
    });

    it("returns 404 for unknown Label", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce(ok([]));
      const res = await req(app, "PATCH", `${A}/labels/nonexistent`, { body: { name: "x" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /accounts/:accountId/labels/:id", () => {
    it("deletes the Label", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce(ok([makeLabel()]));
      const res = await req(app, "DELETE", `${A}/labels/label-001`);
      expect(res.status).toBe(204);
      expect(store.deleteLabel).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "label-001");
    });
  });

  // -------------------------------------------------------------------------
  // Rule routes
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/rules", () => {
    it("returns all Rules in named envelope", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce(ok([makeRule()]));
      const res = await req(app, "GET", `${A}/rules`);
      expect(res.status).toBe(200);
      const body = await res.json() as { rules: Rule[]; pagination: { cursor: null } };
      expect(body.rules).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("POST /accounts/:accountId/rules", () => {
    it("creates a Rule and returns 201", async () => {
      vi.mocked(store.createRule).mockResolvedValueOnce(ok(makeRule() as never));
      const res = await req(app, "POST", `${A}/rules`, {
        body: { name: "Archive newsletters", condition: '{"==": []}', actions: [{ type: "archive" }] },
      });
      expect(res.status).toBe(201);
      expect(store.createRule).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, expect.objectContaining({ name: "Archive newsletters" }),
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await req(app, "POST", `${A}/rules`, { body: { condition: "{}", actions: [{ type: "archive" }] } });
      expect(res.status).toBe(400);
    });

    it("returns 400 when actions array is empty", async () => {
      const res = await req(app, "POST", `${A}/rules`, { body: { name: "Bad", condition: "{}", actions: [] } });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /accounts/:accountId/rules/:id", () => {
    it("updates Rule properties", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce(ok([makeRule()]));
      const res = await req(app, "PATCH", `${A}/rules/rule-001`, { body: { name: "Updated rule" } });
      expect(res.status).toBe(200);
      expect(store.updateRule).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, "rule-001", expect.objectContaining({ name: "Updated rule" }),
      );
    });

    it("returns 404 for unknown Rule", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce(ok([]));
      const res = await req(app, "PATCH", `${A}/rules/nonexistent`, { body: { name: "x" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /accounts/:accountId/rules/:id", () => {
    it("deletes the Rule", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce(ok([makeRule()]));
      const res = await req(app, "DELETE", `${A}/rules/rule-001`);
      expect(res.status).toBe(204);
      expect(store.deleteRule).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "rule-001");
    });
  });

  // -------------------------------------------------------------------------
  // Domain routes
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/domains", () => {
    it("returns all Domains in named envelope", async () => {
      vi.mocked(store.listDomains).mockResolvedValueOnce(ok([makeDomain()]));
      const res = await req(app, "GET", `${A}/domains`);
      expect(res.status).toBe(200);
      const body = await res.json() as { domains: Domain[]; pagination: { cursor: null } };
      expect(body.domains).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("POST /accounts/:accountId/domains", () => {
    it("adds a Domain and returns 201", async () => {
      vi.mocked(store.createDomain).mockResolvedValueOnce(ok(makeDomain() as never));
      const res = await req(app, "POST", `${A}/domains`, { body: { domain: "example.com" } });
      expect(res.status).toBe(201);
      expect(store.createDomain).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "example.com");
    });

    it("returns 400 when domain is missing", async () => {
      const res = await req(app, "POST", `${A}/domains`, { body: {} });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /accounts/:accountId/domains/:id — DNS records", () => {
    it("returns records array alongside domain data", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(ok(makeDomain()));
      const res = await req(app, "GET", `${A}/domains/example.com`);
      expect(res.status).toBe(200);
      const body = await res.json() as { records: Array<{ type: string; name: string; value: string; status: string }> };
      expect(Array.isArray(body.records)).toBe(true);
      expect(body.records.length).toBe(4); // MX, DKIM, SPF (CNAME), DMARC
      expect(body.records[0]).toHaveProperty("type");
      expect(body.records[0]).toHaveProperty("status");
    });

    it("returns exactly 4 records with correct types: MX, CNAME, CNAME, CNAME", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(ok(makeDomain()));
      const res = await req(app, "GET", `${A}/domains/example.com`);
      const body = await res.json() as { records: Array<{ type: string }> };
      expect(body.records.map((r) => r.type)).toEqual(["MX", "CNAME", "CNAME", "CNAME"]);
    });

    it("returns status=pending for every record when domain has never been health-checked", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(ok(makeDomain())); // no lastCheckedAt
      const res = await req(app, "GET", `${A}/domains/example.com`);
      const body = await res.json() as { records: Array<{ status: string }> };
      expect(body.records.every((r) => r.status === "pending")).toBe(true);
    });

    it("returns status=verified for all records after a clean health check", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(
        ok(makeDomain({ lastCheckedAt: "2024-01-15T00:00:00Z", failingRecords: [] })),
      );
      const res = await req(app, "GET", `${A}/domains/example.com`);
      const body = await res.json() as { records: Array<{ status: string }> };
      expect(body.records.every((r) => r.status === "verified")).toBe(true);
    });

    it("shows failing status only for the records listed in failingRecords", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(
        ok(makeDomain({
          lastCheckedAt: "2024-01-15T00:00:00Z",
          failingRecords: ["_dmarc.example.com"],
        })),
      );
      const res = await req(app, "GET", `${A}/domains/example.com`);
      const body = await res.json() as { records: Array<{ name: string; status: string }> };
      const dmarc = body.records.find((r) => r.name === "_dmarc.example.com")!;
      const others = body.records.filter((r) => r.name !== "_dmarc.example.com");
      expect(dmarc.status).toBe("failing");
      expect(others.every((r) => r.status === "verified")).toBe(true);
    });

    it("records include correct name patterns for the registered domain", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(
        ok(makeDomain({ id: "acme.io", domain: "acme.io", lastCheckedAt: "2024-01-15T00:00:00Z" })),
      );
      const res = await req(app, "GET", `${A}/domains/acme.io`);
      const body = await res.json() as { records: Array<{ name: string; type: string }> };
      const names = body.records.map((r) => r.name);
      expect(names).toContain("acme.io");                        // MX
      expect(names).toContain("mail._domainkey.acme.io");        // DKIM CNAME
      expect(names).toContain("bounce.acme.io");                 // SPF CNAME
      expect(names).toContain("_dmarc.acme.io");                 // DMARC CNAME
    });
  });

  describe("DELETE /accounts/:accountId/domains/:id", () => {
    it("removes the Domain", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(ok(makeDomain()));
      const res = await req(app, "DELETE", `${A}/domains/example.com`);
      expect(res.status).toBe(204);
      expect(store.deleteDomain).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "example.com");
    });
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/arcs?q=", () => {
    it("returns Arc search results in named envelope", async () => {
      vi.mocked(store.searchArcs).mockResolvedValueOnce(ok({ items: [makeArc()] }));
      const res = await req(app, "GET", `${A}/arcs?q=invoice+from+stripe`);
      expect(res.status).toBe(200);
      const body = await res.json() as { arcs: unknown[]; pagination: { cursor: null } };
      expect(body.arcs).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
      expect(store.searchArcs).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "invoice from stripe", expect.any(Object));
    });
  });

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId", () => {
    it("returns the account config", async () => {
      vi.mocked(store.getAccount).mockResolvedValueOnce(ok(makeAccount()));
      const res = await req(app, "GET", `${A}`);
      expect(res.status).toBe(200);
      const body = await res.json() as Account;
      expect(body.id).toBe(TEST_ACCOUNT_ID);
    });

    it("returns 404 when account does not exist yet", async () => {
      const res = await req(app, "GET", `${A}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /accounts/:accountId", () => {
    it("updates notification email settings", async () => {
      const res = await req(app, "PATCH", `${A}`, {
        body: { notifications: { email: { enabled: true, address: "alerts@example.com", frequency: "instant" } } },
      });
      expect(res.status).toBe(200);
      expect(store.updateAccount).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ notifications: { email: { enabled: true, address: "alerts@example.com", frequency: "instant" } } }),
      );
    });

    it("updates deletionRetentionDays", async () => {
      const res = await req(app, "PATCH", `${A}`, { body: { deletionRetentionDays: 90 } });
      expect(res.status).toBe(200);
      expect(store.updateAccount).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, expect.objectContaining({ deletionRetentionDays: 90 }),
      );
    });

    it("updates account filtering config including blockOnboardingEmails", async () => {
      const res = await req(app, "PATCH", `${A}`, {
        body: { filtering: { defaultFilterMode: "block", blockOnboardingEmails: true } },
      });
      expect(res.status).toBe(200);
      expect(store.updateAccount).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ filtering: { defaultFilterMode: "block", blockOnboardingEmails: true } }),
      );
    });

    it("updates account-level spamScoreThreshold in filtering config", async () => {
      const res = await req(app, "PATCH", `${A}`, {
        body: { filtering: { defaultFilterMode: "quarantine_visible", newAddressHandling: "auto_allow", spamScoreThreshold: 0.75 } },
      });
      expect(res.status).toBe(200);
      expect(store.updateAccount).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({
          filtering: expect.objectContaining({ spamScoreThreshold: 0.75 }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Account user management
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/users", () => {
    it("returns list of users in named envelope", async () => {
      const users: AccountUser[] = [
        { userId: "user-1", role: "owner" },
        { userId: "user-2", role: "member" },
      ];
      vi.mocked(access.listUsers).mockReturnValueOnce(Promise.resolve(ok(users)));
      const res = await req(app, "GET", `${A}/users`);
      expect(res.status).toBe(200);
      const body = await res.json() as { users: AccountUser[]; pagination: { cursor: null } };
      expect(body.users).toHaveLength(2);
      expect(body.pagination).toEqual({ cursor: null });
      expect(access.listUsers).toHaveBeenCalledWith(TEST_ACCOUNT_ID);
    });

    it("returns 501 when access service is not configured", async () => {
      app = createApp({ store, auth, logger: createMockLogger() });
      const res = await req(app, "GET", `${A}/users`);
      expect(res.status).toBe(501);
    });
  });

  describe("POST /accounts/:accountId/users", () => {
    it("adds a user with the specified role and returns 201", async () => {
      const res = await req(app, "POST", `${A}/users`, { body: { userId: "new-user", role: "member" } });
      expect(res.status).toBe(201);
      expect(access.addUser).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "new-user", "member");
    });

    it("returns 400 when userId is missing", async () => {
      const res = await req(app, "POST", `${A}/users`, { body: { role: "member" } });
      expect(res.status).toBe(400);
    });

    it("returns 400 when role is invalid", async () => {
      const res = await req(app, "POST", `${A}/users`, { body: { userId: "u1", role: "superadmin" } });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /accounts/:accountId/users/:userId", () => {
    it("updates a user's role", async () => {
      const res = await req(app, "PATCH", `${A}/users/user-2`, { body: { role: "admin" } });
      expect(res.status).toBe(200);
      expect(access.updateUserRole).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "user-2", "admin");
    });

    it("returns 400 when role is invalid", async () => {
      const res = await req(app, "PATCH", `${A}/users/user-2`, { body: { role: "unknown" } });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /accounts/:accountId/users/:userId", () => {
    it("removes a user from the account and returns 204", async () => {
      const res = await req(app, "DELETE", `${A}/users/user-2`);
      expect(res.status).toBe(204);
      expect(access.removeUser).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "user-2");
    });
  });

  // -------------------------------------------------------------------------
  // Aliases
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/aliases", () => {
    it("returns all aliases in named envelope", async () => {
      vi.mocked(store.listAliases).mockResolvedValueOnce(ok([makeAlias()]));
      const res = await req(app, "GET", `${A}/aliases`);
      expect(res.status).toBe(200);
      const body = await res.json() as { aliases: Alias[]; pagination: { cursor: null } };
      expect(body.aliases).toHaveLength(1);
      expect(body.aliases[0]!.address).toBe("user@example.com");
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("GET /accounts/:accountId/aliases/:address", () => {
    it("returns alias for the given address", async () => {
      vi.mocked(store.getAlias).mockResolvedValueOnce(ok(makeAlias()));
      const res = await req(app, "GET", `${A}/aliases/user%40example.com`);
      expect(res.status).toBe(200);
      const body = await res.json() as Alias;
      expect(body.unknownSenderPolicy).toBe("quarantine_visible");
    });

    it("returns 404 when no alias exists", async () => {
      const res = await req(app, "GET", `${A}/aliases/unknown%40example.com`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /accounts/:accountId/aliases", () => {
    it("creates an alias and returns 201 + full resource", async () => {
      vi.mocked(store.createAlias).mockResolvedValueOnce(ok(makeAlias({ address: "me@mydomain.com" })));
      const res = await req(app, "POST", `${A}/aliases`, {
        body: { address: "me@mydomain.com", unknownSenderPolicy: "block_hidden" },
      });
      expect(res.status).toBe(201);
      const body = await res.json() as Alias;
      expect(body.address).toBe("me@mydomain.com");
      expect(store.createAlias).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: TEST_ACCOUNT_ID, address: "me@mydomain.com", unknownSenderPolicy: "block_hidden" }),
      );
    });

    it("returns 409 when alias already exists", async () => {
      vi.mocked(store.getAlias).mockResolvedValueOnce(ok(makeAlias()));
      const res = await req(app, "POST", `${A}/aliases`, { body: { address: "user@example.com" } });
      expect(res.status).toBe(409);
      const body = await res.json() as { title: string; errorCode: string };
      expect(body.errorCode).toBe("ALIAS_EXISTS");
    });

    it("returns 400 when address is missing", async () => {
      const res = await req(app, "POST", `${A}/aliases`, { body: { unknownSenderPolicy: "block_hidden" } });
      expect(res.status).toBe(400);
    });

    it("stores createdForOrigin when provided", async () => {
      vi.mocked(store.createAlias).mockResolvedValueOnce(ok(makeAlias()));
      await req(app, "POST", `${A}/aliases`, {
        body: { address: "me@mydomain.com", createdForOrigin: "github.com" },
      });
      expect(store.createAlias).toHaveBeenCalledWith(
        expect.objectContaining({ createdForOrigin: "github.com" }),
      );
    });
  });

  describe("PATCH /accounts/:accountId/aliases/:address", () => {
    it("creates or updates an alias and returns 200 + full resource", async () => {
      vi.mocked(store.upsertAlias).mockResolvedValueOnce(ok(makeAlias({ unknownSenderPolicy: "block_hidden" })));
      const res = await req(app, "PATCH", `${A}/aliases/me%40mydomain.com`, {
        body: { unknownSenderPolicy: "block_hidden" },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Alias;
      expect(body.unknownSenderPolicy).toBe("block_hidden");
      expect(store.upsertAlias).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: TEST_ACCOUNT_ID, address: "me@mydomain.com", unknownSenderPolicy: "block_hidden" }),
      );
    });

    it("preserves id and createdAt when updating existing alias", async () => {
      vi.mocked(store.getAlias).mockResolvedValueOnce(ok(makeAlias()));
      await req(app, "PATCH", `${A}/aliases/user%40example.com`, {
        body: { unknownSenderPolicy: "allow_all", approvedSenders: [] },
      });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.id).toBe("cfg-001");
      expect(saved.unknownSenderPolicy).toBe("allow_all");
    });

    it("stores spamScoreThreshold when included in the request body", async () => {
      await req(app, "PATCH", `${A}/aliases/me%40mydomain.com`, {
        body: { unknownSenderPolicy: "block_hidden", spamScoreThreshold: 0.7 },
      });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.spamScoreThreshold).toBe(0.7);
    });

    it("does not set spamScoreThreshold when absent from request body", async () => {
      await req(app, "PATCH", `${A}/aliases/me%40mydomain.com`, {
        body: { unknownSenderPolicy: "quarantine_visible" },
      });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.spamScoreThreshold).toBeUndefined();
    });
  });

  describe("DELETE /accounts/:accountId/aliases/:address", () => {
    it("deletes the alias and returns 204", async () => {
      const res = await req(app, "DELETE", `${A}/aliases/me%40mydomain.com`);
      expect(res.status).toBe(204);
      expect(store.deleteAlias).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "me@mydomain.com");
    });
  });

  // -------------------------------------------------------------------------
  // Verified forwarding addresses  —  /accounts/:accountId/forwarding-addresses
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/forwarding-addresses", () => {
    it("returns forwarding addresses in named envelope", async () => {
      vi.mocked(store.listVerifiedForwardingAddresses).mockResolvedValueOnce(ok([makeVerifiedAddress()]));
      const res = await req(app, "GET", `${A}/forwarding-addresses`);
      expect(res.status).toBe(200);
      const body = await res.json() as { forwardingAddresses: VerifiedForwardingAddress[]; pagination: { cursor: null } };
      expect(body.forwardingAddresses).toHaveLength(1);
      expect(body.forwardingAddresses[0]!.address).toBe("backup@personal.com");
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("POST /accounts/:accountId/forwarding-addresses", () => {
    it("returns 400 when address is missing", async () => {
      const res = await req(app, "POST", `${A}/forwarding-addresses`, { body: {} });
      expect(res.status).toBe(400);
    });

    it("creates a pending forwarding address and sends verification email", async () => {
      const res = await req(app, "POST", `${A}/forwarding-addresses`, { body: { address: "backup@personal.com" } });
      expect(res.status).toBe(201);
      const body = await res.json() as VerifiedForwardingAddress;
      expect(body.address).toBe("backup@personal.com");
      expect(body.status).toBe("pending");
      expect(body.token).toBeTruthy();
      expect(store.saveVerifiedForwardingAddress).toHaveBeenCalledOnce();
      expect(verificationMailer.sendForwardVerification).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, "backup@personal.com", expect.any(String),
      );
    });

    it("returns existing verified address without re-sending verification", async () => {
      vi.mocked(store.getVerifiedForwardingAddress).mockResolvedValueOnce(ok(makeVerifiedAddress({ status: "verified" })));
      const res = await req(app, "POST", `${A}/forwarding-addresses`, { body: { address: "backup@personal.com" } });
      expect(res.status).toBe(200);
      expect(verificationMailer.sendForwardVerification).not.toHaveBeenCalled();
    });
  });

  describe("POST /accounts/:accountId/forwarding-addresses/:address/verify", () => {
    it("returns 400 when token is missing", async () => {
      vi.mocked(store.getVerifiedForwardingAddress).mockResolvedValueOnce(ok(makeVerifiedAddress({ status: "pending" })));
      const res = await req(app, "POST", `${A}/forwarding-addresses/backup%40personal.com/verify`, { body: {} });
      expect(res.status).toBe(400);
    });

    it("returns 404 when address does not exist", async () => {
      const res = await req(app, "POST", `${A}/forwarding-addresses/unknown%40example.com/verify`, { body: { token: "tok" } });
      expect(res.status).toBe(404);
    });

    it("returns 400 when token is wrong", async () => {
      vi.mocked(store.getVerifiedForwardingAddress).mockResolvedValueOnce(ok(makeVerifiedAddress({ status: "pending", token: "correct-token" })));
      const res = await req(app, "POST", `${A}/forwarding-addresses/backup%40personal.com/verify`, { body: { token: "wrong-token" } });
      expect(res.status).toBe(400);
    });

    it("marks address as verified when token matches", async () => {
      vi.mocked(store.getVerifiedForwardingAddress).mockResolvedValueOnce(ok(makeVerifiedAddress({ status: "pending", token: "tok-abc123" })));
      const res = await req(app, "POST", `${A}/forwarding-addresses/backup%40personal.com/verify`, { body: { token: "tok-abc123" } });
      expect(res.status).toBe(200);
      const body = await res.json() as VerifiedForwardingAddress;
      expect(body.status).toBe("verified");
      expect(body.verifiedAt).toBeTruthy();
      const saved = vi.mocked(store.saveVerifiedForwardingAddress).mock.calls[0]![0] as VerifiedForwardingAddress;
      expect(saved.status).toBe("verified");
    });
  });

  describe("DELETE /accounts/:accountId/forwarding-addresses/:address", () => {
    it("deletes the forwarding address and returns 204", async () => {
      const res = await req(app, "DELETE", `${A}/forwarding-addresses/backup%40personal.com`);
      expect(res.status).toBe(204);
      expect(store.deleteVerifiedForwardingAddress).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "backup@personal.com");
    });
  });

  // -------------------------------------------------------------------------
  // Account creation — billingPlan
  // -------------------------------------------------------------------------

  describe("POST /accounts — billingPlan assignment", () => {
    it.each([
      { label: "no billingPlan in body — gets Trial", body: { name: "My Account" } },
      { label: "billingPlan: Paid in body — ignored, gets Trial", body: { name: "My Account", billingPlan: "Paid" } },
    ])("new account: $label", async ({ body }) => {
      vi.mocked(access.listAccountsForUser).mockResolvedValueOnce(ok([]));
      const res = await req(app, "POST", "/accounts", { body });
      expect(res.status).toBe(201);
      const created = await res.json() as Account;
      expect(created.billingPlan).toBe("Trial");
    });

    it("409 (account exists) does not modify existing account billingPlan", async () => {
      vi.mocked(access.listAccountsForUser).mockResolvedValueOnce(ok(["existing-account"]));
      const res = await req(app, "POST", "/accounts");
      expect(res.status).toBe(409);
      expect(store.createAccount).not.toHaveBeenCalled();
      expect(store.updateAccount).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Rule forward target validation
  // -------------------------------------------------------------------------

  describe("POST /accounts/:accountId/rules — forward target validation", () => {
    it("rejects a rule with an unverified forward target", async () => {
      vi.mocked(store.listVerifiedForwardingAddresses).mockResolvedValueOnce(ok([]));
      const res = await req(app, "POST", `${A}/rules`, {
        body: { name: "Forward rule", actions: [{ type: "forward", value: "backup@personal.com" }] },
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { title: string; errorCode: string };
      expect(body.title).toContain("backup@personal.com");
      expect(body.errorCode).toBe("UNVERIFIED_FORWARD_TARGET");
    });

    it("accepts a rule when forward target is verified", async () => {
      vi.mocked(store.listVerifiedForwardingAddresses).mockResolvedValueOnce(ok([makeVerifiedAddress({ status: "verified" })]));
      const res = await req(app, "POST", `${A}/rules`, {
        body: { name: "Forward rule", actions: [{ type: "forward", value: "backup@personal.com" }] },
      });
      expect(res.status).toBe(201);
    });

    it("accepts a rule with no forward actions without checking verified addresses", async () => {
      const res = await req(app, "POST", `${A}/rules`, {
        body: { name: "Label rule", actions: [{ type: "assign_label", value: "important" }] },
      });
      expect(res.status).toBe(201);
      expect(store.listVerifiedForwardingAddresses).not.toHaveBeenCalled();
    });
  });
});
