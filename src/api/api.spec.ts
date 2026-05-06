import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Arc, Signal, View, Label, Rule, Domain, Account, Alias, VerifiedForwardingAddress } from "../types/index.js";
import { createApp } from "./app.js";
import type { ApiDatabase, AuthService, AuthContext, AccessService, AccountUser, VerificationMailer } from "./app.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-test-001";
const TEST_USER_ID = "user-test-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

const validAuth: AuthContext = { accountId: TEST_ACCOUNT_ID, userId: TEST_USER_ID };

function makeAuth(ctx: AuthContext = validAuth): AuthService {
  return { verify: vi.fn().mockResolvedValue(ctx) };
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
    updateArc: vi.fn().mockResolvedValue(makeArc()),
    listSignals: vi.fn().mockResolvedValue({ items: [] }),
    getSignal: vi.fn().mockResolvedValue(null),
    updateSignal: vi.fn().mockResolvedValue(makeSignal()),
    deleteSignal: vi.fn().mockResolvedValue(undefined),
    listViews: vi.fn().mockResolvedValue([]),
    getView: vi.fn().mockResolvedValue(null),
    createView: vi.fn().mockResolvedValue(makeView()),
    updateView: vi.fn().mockResolvedValue(makeView()),
    deleteView: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(makeLabel()),
    updateLabel: vi.fn().mockResolvedValue(makeLabel()),
    deleteLabel: vi.fn().mockResolvedValue(undefined),
    listRules: vi.fn().mockResolvedValue([]),
    createRule: vi.fn().mockResolvedValue(makeRule()),
    updateRule: vi.fn().mockResolvedValue(makeRule()),
    deleteRule: vi.fn().mockResolvedValue(undefined),
    listDomains: vi.fn().mockResolvedValue([]),
    getDomain: vi.fn().mockResolvedValue(null),
    createDomain: vi.fn().mockResolvedValue(makeDomain()),
    deleteDomain: vi.fn().mockResolvedValue(undefined),
    searchArcs: vi.fn().mockResolvedValue({ items: [] }),
    getAccount: vi.fn().mockResolvedValue(null),
    updateAccount: vi.fn().mockResolvedValue(makeAccount()),
    listAliases: vi.fn().mockResolvedValue([]),
    getAlias: vi.fn().mockResolvedValue(null),
    createAlias: vi.fn().mockResolvedValue(makeAlias()),
    upsertAlias: vi.fn().mockResolvedValue(makeAlias()),
    deleteAlias: vi.fn().mockResolvedValue(undefined),
    unblockSignal: vi.fn().mockResolvedValue(undefined),
    createArc: vi.fn().mockResolvedValue(undefined),
    listVerifiedForwardingAddresses: vi.fn().mockResolvedValue([]),
    getVerifiedForwardingAddress: vi.fn().mockResolvedValue(null),
    saveVerifiedForwardingAddress: vi.fn().mockResolvedValue(undefined),
    deleteVerifiedForwardingAddress: vi.fn().mockResolvedValue(undefined),
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
    filterMode: "notify_new",
    approvedSenders: ["amazon.com", "google.com"],
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
    position: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: "domain-001",
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
    new Request(`http://localhost${path}`, {
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
    verificationMailer = { sendForwardVerification: vi.fn().mockResolvedValue(undefined) };
    app = createApp({ store, auth, access, verificationMailer });
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
      vi.mocked(auth.verify).mockRejectedValueOnce(new Error("Invalid token"));
      const res = await req(app, "GET", `${A}/arcs`, { token: "bad-token" });
      expect(res.status).toBe(401);
    });

    it("returns 403 when user lacks access to the requested account", async () => {
      vi.mocked(access.checkAccess).mockRejectedValueOnce(new Error("Forbidden"));
      const res = await req(app, "GET", `${A}/arcs`);
      expect(res.status).toBe(403);
    });

    it("passes accountId from URL to store operations", async () => {
      await req(app, "GET", `${A}/arcs`);
      expect(store.listArcs).toHaveBeenCalledWith(TEST_ACCOUNT_ID, expect.any(Object));
    });

    it("verifies account access on every request", async () => {
      await req(app, "GET", `${A}/arcs`);
      expect(access.checkAccess).toHaveBeenCalledWith(TEST_USER_ID, TEST_ACCOUNT_ID, "account:read");
    });
  });

  // -------------------------------------------------------------------------
  // Arc routes
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/arcs", () => {
    it("returns paginated Arc list in named envelope", async () => {
      vi.mocked(store.listArcs).mockResolvedValueOnce({ items: [makeArc()] });
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
      vi.mocked(store.listArcs).mockResolvedValueOnce({ items: [makeArc()], nextCursor: "cursor-abc" });
      const res = await req(app, "GET", `${A}/arcs`);
      const body = await res.json() as { pagination: { cursor: string } };
      expect(body.pagination.cursor).toBe("cursor-abc");
    });
  });

  describe("GET /accounts/:accountId/arcs/:id", () => {
    it("returns Arc detail", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc());
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
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc({ accountId: "other-account" }));
      const res = await req(app, "GET", `${A}/arcs/arc-001`);
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /accounts/:accountId/arcs/:id", () => {
    it("archives an Arc", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc());
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(200);
      expect(store.updateArc).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, "arc-001", expect.objectContaining({ status: "archived" }),
      );
    });

    it("assigns labels to an Arc", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc());
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
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc());
      vi.mocked(store.listSignals).mockResolvedValueOnce({ items: [makeSignal()] });
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

  describe("GET /accounts/:accountId/signals/:id", () => {
    it("returns full Signal detail", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ textBody: "Hello world" }));
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
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ accountId: "other-account" }));
      const res = await req(app, "GET", `${A}/signals/SES%23msg-001`);
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /accounts/:accountId/signals/:id — draft update", () => {
    it("updates a draft signal and returns 200 + full resource", async () => {
      const draft = makeSignal({ status: "draft" });
      vi.mocked(store.getSignal).mockResolvedValueOnce(draft);
      vi.mocked(store.updateSignal).mockResolvedValueOnce({ ...draft, subject: "Updated subject" });
      const res = await req(app, "PATCH", `${A}/signals/SES%23msg-001`, { body: { subject: "Updated subject" } });
      expect(res.status).toBe(200);
      const body = await res.json() as Signal;
      expect(body.subject).toBe("Updated subject");
      expect(store.updateSignal).toHaveBeenCalledWith(TEST_ACCOUNT_ID, draft.id, expect.objectContaining({ subject: "Updated subject" }));
    });

    it("returns 400 when signal is not a draft", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "active" }));
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
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "draft" }));
      const res = await req(app, "POST", `${A}/signals/SES%23msg-001/send`);
      expect(res.status).toBe(200);
      expect(store.updateSignal).toHaveBeenCalledOnce();
    });

    it("returns 400 when signal is not a draft", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "active" }));
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
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "draft" }));
      const res = await req(app, "DELETE", `${A}/signals/SES%23msg-001`);
      expect(res.status).toBe(204);
      expect(store.deleteSignal).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "SES#msg-001");
    });

    it("returns 400 when signal is not a draft", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "active" }));
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
      vi.mocked(store.listViews).mockResolvedValueOnce([makeView(), makeView({ id: "view-002" })]);
      const res = await req(app, "GET", `${A}/views`);
      expect(res.status).toBe(200);
      const body = await res.json() as { views: View[]; pagination: { cursor: null } };
      expect(body.views).toHaveLength(2);
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("POST /accounts/:accountId/views", () => {
    it("creates a View and returns 201", async () => {
      vi.mocked(store.createView).mockResolvedValueOnce(makeView({ id: "view-new" }) as never);
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
      vi.mocked(store.getView).mockResolvedValueOnce(makeView());
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
      vi.mocked(store.getView).mockResolvedValueOnce(makeView());
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
      vi.mocked(store.listLabels).mockResolvedValueOnce([makeLabel()]);
      const res = await req(app, "GET", `${A}/labels`);
      expect(res.status).toBe(200);
      const body = await res.json() as { labels: Label[]; pagination: { cursor: null } };
      expect(body.labels).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("POST /accounts/:accountId/labels", () => {
    it("creates a Label and returns 201", async () => {
      vi.mocked(store.createLabel).mockResolvedValueOnce(makeLabel() as never);
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
      vi.mocked(store.listLabels).mockResolvedValueOnce([makeLabel()]);
      const res = await req(app, "PATCH", `${A}/labels/label-001`, { body: { name: "billing" } });
      expect(res.status).toBe(200);
      expect(store.updateLabel).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, "label-001", expect.objectContaining({ name: "billing" }),
      );
    });

    it("returns 404 for unknown Label", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce([]);
      const res = await req(app, "PATCH", `${A}/labels/nonexistent`, { body: { name: "x" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /accounts/:accountId/labels/:id", () => {
    it("deletes the Label", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce([makeLabel()]);
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
      vi.mocked(store.listRules).mockResolvedValueOnce([makeRule()]);
      const res = await req(app, "GET", `${A}/rules`);
      expect(res.status).toBe(200);
      const body = await res.json() as { rules: Rule[]; pagination: { cursor: null } };
      expect(body.rules).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("POST /accounts/:accountId/rules", () => {
    it("creates a Rule and returns 201", async () => {
      vi.mocked(store.createRule).mockResolvedValueOnce(makeRule() as never);
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
      vi.mocked(store.listRules).mockResolvedValueOnce([makeRule()]);
      const res = await req(app, "PATCH", `${A}/rules/rule-001`, { body: { name: "Updated rule" } });
      expect(res.status).toBe(200);
      expect(store.updateRule).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID, "rule-001", expect.objectContaining({ name: "Updated rule" }),
      );
    });

    it("returns 404 for unknown Rule", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce([]);
      const res = await req(app, "PATCH", `${A}/rules/nonexistent`, { body: { name: "x" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /accounts/:accountId/rules/:id", () => {
    it("deletes the Rule", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce([makeRule()]);
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
      vi.mocked(store.listDomains).mockResolvedValueOnce([makeDomain()]);
      const res = await req(app, "GET", `${A}/domains`);
      expect(res.status).toBe(200);
      const body = await res.json() as { domains: Domain[]; pagination: { cursor: null } };
      expect(body.domains).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
    });
  });

  describe("POST /accounts/:accountId/domains", () => {
    it("adds a Domain and returns 201", async () => {
      vi.mocked(store.createDomain).mockResolvedValueOnce(makeDomain() as never);
      const res = await req(app, "POST", `${A}/domains`, { body: { domain: "example.com" } });
      expect(res.status).toBe(201);
      expect(store.createDomain).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "example.com");
    });

    it("returns 400 when domain is missing", async () => {
      const res = await req(app, "POST", `${A}/domains`, { body: {} });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /accounts/:accountId/domains/:id/records", () => {
    it("returns all DNS records for a Domain", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain());
      const res = await req(app, "GET", `${A}/domains/domain-001/records`);
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ type: string; name: string; value: string; status: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(4); // MX, DKIM, SPF, DMARC
      expect(body[0]).toHaveProperty("type");
      expect(body[0]).toHaveProperty("status");
    });

    it("returns exactly 4 records with correct types: MX, CNAME, TXT, CNAME", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain());
      const res = await req(app, "GET", `${A}/domains/domain-001/records`);
      const body = await res.json() as Array<{ type: string; name: string; value: string; status: string }>;
      expect(body.map((r) => r.type)).toEqual(["MX", "CNAME", "TXT", "CNAME"]);
    });

    it("returns status=pending for every record when domain has never been health-checked", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain()); // no lastCheckedAt
      const res = await req(app, "GET", `${A}/domains/domain-001/records`);
      const body = await res.json() as Array<{ status: string }>;
      expect(body.every((r) => r.status === "pending")).toBe(true);
    });

    it("returns status=verified for all records after a clean health check", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(
        makeDomain({ lastCheckedAt: "2024-01-15T00:00:00Z", failingRecords: [] }),
      );
      const res = await req(app, "GET", `${A}/domains/domain-001/records`);
      const body = await res.json() as Array<{ status: string }>;
      expect(body.every((r) => r.status === "verified")).toBe(true);
    });

    it("shows failing status only for the records listed in failingRecords", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(
        makeDomain({
          lastCheckedAt: "2024-01-15T00:00:00Z",
          failingRecords: ["_dmarc.example.com"],
        }),
      );
      const res = await req(app, "GET", `${A}/domains/domain-001/records`);
      const body = await res.json() as Array<{ name: string; status: string }>;
      const dmarc = body.find((r) => r.name === "_dmarc.example.com")!;
      const others = body.filter((r) => r.name !== "_dmarc.example.com");
      expect(dmarc.status).toBe("failing");
      expect(others.every((r) => r.status === "verified")).toBe(true);
    });

    it("records include correct name patterns for the registered domain", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(
        makeDomain({ domain: "acme.io", lastCheckedAt: "2024-01-15T00:00:00Z" }),
      );
      const res = await req(app, "GET", `${A}/domains/domain-001/records`);
      const body = await res.json() as Array<{ name: string; type: string }>;
      const names = body.map((r) => r.name);
      expect(names).toContain("acme.io");                        // MX
      expect(names).toContain("mail._domainkey.acme.io");        // DKIM CNAME
      expect(names).toContain("bounce.acme.io");                 // SPF TXT
      expect(names).toContain("_dmarc.acme.io");                 // DMARC CNAME
    });

    it("returns 404 for unknown Domain", async () => {
      const res = await req(app, "GET", `${A}/domains/nonexistent/records`);
      expect(res.status).toBe(404);
    });

    it("returns 403 when Domain belongs to a different account", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain({ accountId: "other" }));
      const res = await req(app, "GET", `${A}/domains/domain-001/records`);
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /accounts/:accountId/domains/:id", () => {
    it("removes the Domain", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain());
      const res = await req(app, "DELETE", `${A}/domains/domain-001`);
      expect(res.status).toBe(204);
      expect(store.deleteDomain).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "domain-001");
    });
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/search", () => {
    it("returns Arc search results in named envelope", async () => {
      vi.mocked(store.searchArcs).mockResolvedValueOnce({ items: [makeArc()] });
      const res = await req(app, "GET", `${A}/search?q=invoice+from+stripe`);
      expect(res.status).toBe(200);
      const body = await res.json() as { arcs: unknown[]; pagination: { cursor: null } };
      expect(body.arcs).toHaveLength(1);
      expect(body.pagination).toEqual({ cursor: null });
      expect(store.searchArcs).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "invoice from stripe", expect.any(Object));
    });

    it("returns 400 when query is missing", async () => {
      const res = await req(app, "GET", `${A}/search`);
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId", () => {
    it("returns the account config", async () => {
      vi.mocked(store.getAccount).mockResolvedValueOnce(makeAccount());
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
        body: { filtering: { defaultFilterMode: "strict", blockOnboardingEmails: true } },
      });
      expect(res.status).toBe(200);
      expect(store.updateAccount).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ filtering: { defaultFilterMode: "strict", blockOnboardingEmails: true } }),
      );
    });

    it("updates account-level spamScoreThreshold in filtering config", async () => {
      const res = await req(app, "PATCH", `${A}`, {
        body: { filtering: { defaultFilterMode: "notify_new", newAddressHandling: "auto_allow", spamScoreThreshold: 0.75 } },
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
      vi.mocked(access.listUsers).mockResolvedValueOnce(users);
      const res = await req(app, "GET", `${A}/users`);
      expect(res.status).toBe(200);
      const body = await res.json() as { users: AccountUser[]; pagination: { cursor: null } };
      expect(body.users).toHaveLength(2);
      expect(body.pagination).toEqual({ cursor: null });
      expect(access.listUsers).toHaveBeenCalledWith(TEST_ACCOUNT_ID);
    });

    it("returns 501 when access service is not configured", async () => {
      app = createApp({ store, auth });
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
      vi.mocked(store.listAliases).mockResolvedValueOnce([makeAlias()]);
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
      vi.mocked(store.getAlias).mockResolvedValueOnce(makeAlias());
      const res = await req(app, "GET", `${A}/aliases/user%40example.com`);
      expect(res.status).toBe(200);
      const body = await res.json() as Alias;
      expect(body.filterMode).toBe("notify_new");
    });

    it("returns 404 when no alias exists", async () => {
      const res = await req(app, "GET", `${A}/aliases/unknown%40example.com`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /accounts/:accountId/aliases", () => {
    it("creates an alias and returns 201 + full resource", async () => {
      vi.mocked(store.createAlias).mockResolvedValueOnce(makeAlias({ address: "me@mydomain.com" }));
      const res = await req(app, "POST", `${A}/aliases`, {
        body: { address: "me@mydomain.com", filterMode: "strict" },
      });
      expect(res.status).toBe(201);
      const body = await res.json() as Alias;
      expect(body.address).toBe("me@mydomain.com");
      expect(store.createAlias).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: TEST_ACCOUNT_ID, address: "me@mydomain.com", filterMode: "strict" }),
      );
    });

    it("returns 409 when alias already exists", async () => {
      vi.mocked(store.getAlias).mockResolvedValueOnce(makeAlias());
      const res = await req(app, "POST", `${A}/aliases`, { body: { address: "user@example.com" } });
      expect(res.status).toBe(409);
      const body = await res.json() as { title: string; errorCode: string };
      expect(body.errorCode).toBe("ALIAS_EXISTS");
    });

    it("returns 400 when address is missing", async () => {
      const res = await req(app, "POST", `${A}/aliases`, { body: { filterMode: "strict" } });
      expect(res.status).toBe(400);
    });

    it("stores createdForOrigin when provided", async () => {
      vi.mocked(store.createAlias).mockResolvedValueOnce(makeAlias());
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
      vi.mocked(store.upsertAlias).mockResolvedValueOnce(makeAlias({ filterMode: "strict" }));
      const res = await req(app, "PATCH", `${A}/aliases/me%40mydomain.com`, {
        body: { filterMode: "strict", approvedSenders: ["amazon.com"] },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Alias;
      expect(body.filterMode).toBe("strict");
      expect(store.upsertAlias).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: TEST_ACCOUNT_ID, address: "me@mydomain.com", filterMode: "strict" }),
      );
    });

    it("preserves id and createdAt when updating existing alias", async () => {
      vi.mocked(store.getAlias).mockResolvedValueOnce(makeAlias());
      await req(app, "PATCH", `${A}/aliases/user%40example.com`, {
        body: { filterMode: "allow_all", approvedSenders: [] },
      });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.id).toBe("cfg-001");
      expect(saved.filterMode).toBe("allow_all");
    });

    it("stores spamScoreThreshold when included in the request body", async () => {
      await req(app, "PATCH", `${A}/aliases/me%40mydomain.com`, {
        body: { filterMode: "strict", approvedSenders: [], spamScoreThreshold: 0.7 },
      });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.spamScoreThreshold).toBe(0.7);
    });

    it("does not set spamScoreThreshold when absent from request body", async () => {
      await req(app, "PATCH", `${A}/aliases/me%40mydomain.com`, {
        body: { filterMode: "notify_new", approvedSenders: ["amazon.com"] },
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
  // POST /accounts/:accountId/arcs — create Arc from blocked signal
  // -------------------------------------------------------------------------

  describe("POST /accounts/:accountId/arcs", () => {
    it("returns 404 when signalId references an unknown signal", async () => {
      const res = await req(app, "POST", `${A}/arcs`, { body: { signalId: "nonexistent" } });
      expect(res.status).toBe(404);
    });

    it("returns 400 when the signal is not blocked or quarantined", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "active" }));
      const res = await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001" } });
      expect(res.status).toBe(400);
    });

    it("creates an Arc from a quarantined signal and returns 201", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "quarantined" }));
      const res = await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001" } });
      expect(res.status).toBe(201);
      expect(store.createArc).toHaveBeenCalledOnce();
      expect(store.unblockSignal).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "SES#msg-001", expect.any(String));
    });

    it("creates an Arc from a blocked signal and returns 201", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "blocked" }));
      const res = await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001" } });
      expect(res.status).toBe(201);

      expect(store.createArc).toHaveBeenCalledOnce();
      const arc = vi.mocked(store.createArc).mock.calls[0]![0] as Arc;
      expect(arc.accountId).toBe(TEST_ACCOUNT_ID);
      expect(arc.status).toBe("active");
      expect(store.unblockSignal).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "SES#msg-001", arc.id);

      const body = await res.json() as Arc;
      expect(body.id).toBe(arc.id);
    });

    it("Arc inherits workflow and summary from the blocked signal", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(
        makeSignal({ status: "blocked", workflow: "payments", summary: "Invoice from ACME" }),
      );
      await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001" } });
      const arc = vi.mocked(store.createArc).mock.calls[0]![0] as Arc;
      expect(arc.workflow).toBe("payments");
      expect(arc.summary).toBe("Invoice from ACME");
    });

    it("approves sender eTLD+1 when approveSender is true", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(
        makeSignal({ status: "blocked", from: { address: "noreply@mail.amazon.com" }, recipientAddress: "me@mydomain.com" }),
      );
      await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001", approveSender: true } });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.approvedSenders).toContain("amazon.com");
      expect(saved.address).toBe("me@mydomain.com");
    });

    it("updates filter mode when updateFilterMode is provided", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "blocked" }));
      await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001", updateFilterMode: "allow_all" } });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.filterMode).toBe("allow_all");
    });

    it("preserves existing approved senders when approving a new one", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(
        makeSignal({ status: "blocked", from: { address: "support@github.com" }, recipientAddress: "user@example.com" }),
      );
      vi.mocked(store.getAlias).mockResolvedValueOnce(
        makeAlias({ approvedSenders: ["amazon.com", "google.com"] }),
      );
      await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001", approveSender: true } });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.approvedSenders).toContain("amazon.com");
      expect(saved.approvedSenders).toContain("google.com");
      expect(saved.approvedSenders).toContain("github.com");
    });

    it("does not modify aliases when neither approveSender nor updateFilterMode is set", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ status: "blocked" }));
      await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001" } });
      expect(store.upsertAlias).not.toHaveBeenCalled();
      expect(store.getAlias).not.toHaveBeenCalled();
    });

    it("does not add sender to approvedSenders when approveSender is false and updateFilterMode is set", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(
        makeSignal({ status: "blocked", from: { address: "news@amazon.com" }, recipientAddress: "me@mydomain.com" }),
      );
      await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001", updateFilterMode: "allow_all" } });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.filterMode).toBe("allow_all");
      expect(saved.approvedSenders).not.toContain("amazon.com");
    });

    it("does not add duplicate sender when sender is already in approvedSenders", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(
        makeSignal({ status: "blocked", from: { address: "deals@amazon.com" }, recipientAddress: "user@example.com" }),
      );
      vi.mocked(store.getAlias).mockResolvedValueOnce(
        makeAlias({ approvedSenders: ["amazon.com", "google.com"] }), // amazon.com already approved
      );
      await req(app, "POST", `${A}/arcs`, { body: { signalId: "SES#msg-001", approveSender: true } });
      const saved = vi.mocked(store.upsertAlias).mock.calls[0]![0] as Alias;
      expect(saved.approvedSenders.filter((s) => s === "amazon.com")).toHaveLength(1); // no duplicate
    });
  });

  // -------------------------------------------------------------------------
  // Verified forwarding addresses  —  /accounts/:accountId/forwarding-addresses
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/forwarding-addresses", () => {
    it("returns forwarding addresses in named envelope", async () => {
      vi.mocked(store.listVerifiedForwardingAddresses).mockResolvedValueOnce([makeVerifiedAddress()]);
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
      vi.mocked(store.getVerifiedForwardingAddress).mockResolvedValueOnce(makeVerifiedAddress({ status: "verified" }));
      const res = await req(app, "POST", `${A}/forwarding-addresses`, { body: { address: "backup@personal.com" } });
      expect(res.status).toBe(200);
      expect(verificationMailer.sendForwardVerification).not.toHaveBeenCalled();
    });
  });

  describe("POST /accounts/:accountId/forwarding-addresses/:address/verify", () => {
    it("returns 400 when token is missing", async () => {
      vi.mocked(store.getVerifiedForwardingAddress).mockResolvedValueOnce(makeVerifiedAddress({ status: "pending" }));
      const res = await req(app, "POST", `${A}/forwarding-addresses/backup%40personal.com/verify`, { body: {} });
      expect(res.status).toBe(400);
    });

    it("returns 404 when address does not exist", async () => {
      const res = await req(app, "POST", `${A}/forwarding-addresses/unknown%40example.com/verify`, { body: { token: "tok" } });
      expect(res.status).toBe(404);
    });

    it("returns 400 when token is wrong", async () => {
      vi.mocked(store.getVerifiedForwardingAddress).mockResolvedValueOnce(makeVerifiedAddress({ status: "pending", token: "correct-token" }));
      const res = await req(app, "POST", `${A}/forwarding-addresses/backup%40personal.com/verify`, { body: { token: "wrong-token" } });
      expect(res.status).toBe(400);
    });

    it("marks address as verified when token matches", async () => {
      vi.mocked(store.getVerifiedForwardingAddress).mockResolvedValueOnce(makeVerifiedAddress({ status: "pending", token: "tok-abc123" }));
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
  // Rule forward target validation
  // -------------------------------------------------------------------------

  describe("POST /accounts/:accountId/rules — forward target validation", () => {
    it("rejects a rule with an unverified forward target", async () => {
      vi.mocked(store.listVerifiedForwardingAddresses).mockResolvedValueOnce([]);
      const res = await req(app, "POST", `${A}/rules`, {
        body: { name: "Forward rule", actions: [{ type: "forward", value: "backup@personal.com" }] },
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { title: string; errorCode: string };
      expect(body.title).toContain("backup@personal.com");
      expect(body.errorCode).toBe("UNVERIFIED_FORWARD_TARGET");
    });

    it("accepts a rule when forward target is verified", async () => {
      vi.mocked(store.listVerifiedForwardingAddresses).mockResolvedValueOnce([makeVerifiedAddress({ status: "verified" })]);
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
