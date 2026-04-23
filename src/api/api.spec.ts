import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Arc, Signal, View, Label, Rule, Domain, Account } from "../types/index.js";
import { createApp } from "./app.js";
import type { ApiStore, AuthService, AuthContext } from "./app.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-test-001";
const TEST_USER_ID = "user-test-001";

const validAuth: AuthContext = { accountId: TEST_ACCOUNT_ID, userId: TEST_USER_ID };

function makeAuth(ctx: AuthContext = validAuth): AuthService {
  return { verify: vi.fn().mockResolvedValue(ctx) };
}

function makeStore(): ApiStore {
  return {
    listArcs: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getArc: vi.fn().mockResolvedValue(null),
    updateArc: vi.fn().mockResolvedValue(undefined),
    listSignals: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getSignal: vi.fn().mockResolvedValue(null),
    listViews: vi.fn().mockResolvedValue([]),
    getView: vi.fn().mockResolvedValue(null),
    createView: vi.fn().mockResolvedValue(undefined),
    updateView: vi.fn().mockResolvedValue(undefined),
    deleteView: vi.fn().mockResolvedValue(undefined),
    reorderViews: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(undefined),
    updateLabel: vi.fn().mockResolvedValue(undefined),
    deleteLabel: vi.fn().mockResolvedValue(undefined),
    listRules: vi.fn().mockResolvedValue([]),
    createRule: vi.fn().mockResolvedValue(undefined),
    updateRule: vi.fn().mockResolvedValue(undefined),
    deleteRule: vi.fn().mockResolvedValue(undefined),
    reorderRules: vi.fn().mockResolvedValue(undefined),
    listDomains: vi.fn().mockResolvedValue([]),
    getDomain: vi.fn().mockResolvedValue(null),
    createDomain: vi.fn().mockResolvedValue(undefined),
    deleteDomain: vi.fn().mockResolvedValue(undefined),
    searchArcs: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getAccount: vi.fn().mockResolvedValue(null),
    updateAccount: vi.fn().mockResolvedValue(undefined),
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
    category: "personal",
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
    id: "signal-001",
    arcId: "arc-001",
    accountId: TEST_ACCOUNT_ID,
    messageId: "msg-001",
    receivedAt: "2024-01-15T10:00:00Z",
    from: { address: "sender@example.com", name: "Sender" },
    to: [{ address: "user@example.com" }],
    cc: [],
    subject: "Test email",
    attachments: [],
    headers: {},
    recipientAddress: "user@example.com",
    category: "personal",
    categoryData: { category: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.02,
    summary: "A test signal.",
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    s3Key: "emails/msg-001",
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
    createdAt: "2024-01-01T00:00:00Z",
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
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("API", () => {
  let store: ApiStore;
  let auth: AuthService;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    auth = makeAuth();
    app = createApp({ store, auth });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await req(app, "GET", "/arcs", { token: "" });
      expect(res.status).toBe(401);
    });

    it("returns 401 when token is invalid", async () => {
      vi.mocked(auth.verify).mockRejectedValueOnce(new Error("Invalid token"));
      const res = await req(app, "GET", "/arcs", { token: "bad-token" });
      expect(res.status).toBe(401);
    });

    it("passes accountId to store operations", async () => {
      await req(app, "GET", "/arcs");
      expect(store.listArcs).toHaveBeenCalledWith(TEST_ACCOUNT_ID, expect.any(Object));
    });
  });

  // -------------------------------------------------------------------------
  // Arc routes
  // -------------------------------------------------------------------------

  describe("GET /arcs", () => {
    it("returns paginated Arc list", async () => {
      vi.mocked(store.listArcs).mockResolvedValueOnce({ items: [makeArc()], total: 1 });

      const res = await req(app, "GET", "/arcs");
      expect(res.status).toBe(200);

      const body = await res.json() as { items: unknown[]; total: number };
      expect(body.total).toBe(1);
      expect(body.items).toHaveLength(1);
    });

    it("passes category and label filters to the store", async () => {
      await req(app, "GET", "/arcs?category=invoice&label=billing&limit=25");
      expect(store.listArcs).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ category: "invoice", label: "billing", limit: 25 }),
      );
    });

    it("passes status filter to the store", async () => {
      await req(app, "GET", "/arcs?status=archived");
      expect(store.listArcs).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ status: "archived" }),
      );
    });
  });

  describe("GET /arcs/:id", () => {
    it("returns Arc detail", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc());

      const res = await req(app, "GET", "/arcs/arc-001");
      expect(res.status).toBe(200);

      const body = await res.json() as Arc;
      expect(body.id).toBe("arc-001");
    });

    it("returns 404 for unknown Arc", async () => {
      const res = await req(app, "GET", "/arcs/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 403 when Arc belongs to a different account", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc({ accountId: "other-account" }));
      const res = await req(app, "GET", "/arcs/arc-001");
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /arcs/:id", () => {
    it("archives an Arc", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc());

      const res = await req(app, "PATCH", "/arcs/arc-001", { body: { status: "archived" } });
      expect(res.status).toBe(200);
      expect(store.updateArc).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "arc-001",
        expect.objectContaining({ status: "archived" }),
      );
    });

    it("assigns labels to an Arc", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc());

      const res = await req(app, "PATCH", "/arcs/arc-001", { body: { labels: ["billing", "urgent"] } });
      expect(res.status).toBe(200);
      expect(store.updateArc).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "arc-001",
        expect.objectContaining({ labels: ["billing", "urgent"] }),
      );
    });

    it("returns 404 for unknown Arc", async () => {
      const res = await req(app, "PATCH", "/arcs/nonexistent", { body: { status: "archived" } });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Signal routes
  // -------------------------------------------------------------------------

  describe("GET /arcs/:id/signals", () => {
    it("lists Signals for an Arc", async () => {
      vi.mocked(store.getArc).mockResolvedValueOnce(makeArc());
      vi.mocked(store.listSignals).mockResolvedValueOnce({ items: [makeSignal()], total: 1 });

      const res = await req(app, "GET", "/arcs/arc-001/signals");
      expect(res.status).toBe(200);

      const body = await res.json() as { items: unknown[]; total: number };
      expect(body.items).toHaveLength(1);
    });

    it("returns 404 when Arc does not exist", async () => {
      const res = await req(app, "GET", "/arcs/nonexistent/signals");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /signals/:id", () => {
    it("returns full Signal detail", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ textBody: "Hello world" }));

      const res = await req(app, "GET", "/signals/signal-001");
      expect(res.status).toBe(200);

      const body = await res.json() as Signal;
      expect(body.id).toBe("signal-001");
      expect(body.textBody).toBe("Hello world");
    });

    it("returns 404 for unknown Signal", async () => {
      const res = await req(app, "GET", "/signals/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 403 when Signal belongs to a different account", async () => {
      vi.mocked(store.getSignal).mockResolvedValueOnce(makeSignal({ accountId: "other-account" }));
      const res = await req(app, "GET", "/signals/signal-001");
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // View routes
  // -------------------------------------------------------------------------

  describe("GET /views", () => {
    it("returns all Views for the account", async () => {
      vi.mocked(store.listViews).mockResolvedValueOnce([makeView(), makeView({ id: "view-002" })]);

      const res = await req(app, "GET", "/views");
      expect(res.status).toBe(200);

      const body = await res.json() as View[];
      expect(body).toHaveLength(2);
    });
  });

  describe("POST /views", () => {
    it("creates a View and returns 201", async () => {
      vi.mocked(store.createView).mockResolvedValueOnce(makeView({ id: "view-new" }) as never);

      const res = await req(app, "POST", "/views", {
        body: { name: "Invoices", category: "invoice", sortField: "lastSignalAt", sortDirection: "desc" },
      });
      expect(res.status).toBe(201);
      expect(store.createView).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ name: "Invoices", category: "invoice" }),
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await req(app, "POST", "/views", { body: { category: "invoice" } });
      expect(res.status).toBe(400);
    });

    it("returns 400 when category is invalid", async () => {
      const res = await req(app, "POST", "/views", {
        body: { name: "Bad View", category: "not-a-category" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /views/:id", () => {
    it("updates View properties", async () => {
      vi.mocked(store.getView).mockResolvedValueOnce(makeView());

      const res = await req(app, "PATCH", "/views/view-001", { body: { name: "Updated", color: "#00ff00" } });
      expect(res.status).toBe(200);
      expect(store.updateView).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "view-001",
        expect.objectContaining({ name: "Updated" }),
      );
    });

    it("returns 404 for unknown View", async () => {
      const res = await req(app, "PATCH", "/views/nonexistent", { body: { name: "X" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /views/:id", () => {
    it("deletes the View", async () => {
      vi.mocked(store.getView).mockResolvedValueOnce(makeView());

      const res = await req(app, "DELETE", "/views/view-001");
      expect(res.status).toBe(204);
      expect(store.deleteView).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "view-001");
    });
  });

  describe("POST /views/reorder", () => {
    it("reorders Views by ID array", async () => {
      const res = await req(app, "POST", "/views/reorder", {
        body: { orderedIds: ["view-002", "view-001"] },
      });
      expect(res.status).toBe(200);
      expect(store.reorderViews).toHaveBeenCalledWith(TEST_ACCOUNT_ID, ["view-002", "view-001"]);
    });
  });

  // -------------------------------------------------------------------------
  // Label routes
  // -------------------------------------------------------------------------

  describe("GET /labels", () => {
    it("returns all Labels for the account", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce([makeLabel()]);

      const res = await req(app, "GET", "/labels");
      expect(res.status).toBe(200);
      const body = await res.json() as Label[];
      expect(body).toHaveLength(1);
    });
  });

  describe("POST /labels", () => {
    it("creates a Label and returns 201", async () => {
      vi.mocked(store.createLabel).mockResolvedValueOnce(makeLabel() as never);

      const res = await req(app, "POST", "/labels", { body: { name: "urgent", color: "#ff0000" } });
      expect(res.status).toBe(201);
      expect(store.createLabel).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ name: "urgent" }),
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await req(app, "POST", "/labels", { body: { color: "#ff0000" } });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /labels/:id", () => {
    it("updates Label", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce([makeLabel()]);

      const res = await req(app, "PATCH", "/labels/label-001", { body: { name: "billing" } });
      expect(res.status).toBe(200);
      expect(store.updateLabel).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "label-001",
        expect.objectContaining({ name: "billing" }),
      );
    });

    it("returns 404 for unknown Label", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce([]);
      const res = await req(app, "PATCH", "/labels/nonexistent", { body: { name: "x" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /labels/:id", () => {
    it("deletes the Label", async () => {
      vi.mocked(store.listLabels).mockResolvedValueOnce([makeLabel()]);

      const res = await req(app, "DELETE", "/labels/label-001");
      expect(res.status).toBe(204);
      expect(store.deleteLabel).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "label-001");
    });
  });

  // -------------------------------------------------------------------------
  // Rule routes
  // -------------------------------------------------------------------------

  describe("GET /rules", () => {
    it("returns all Rules for the account", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce([makeRule()]);

      const res = await req(app, "GET", "/rules");
      expect(res.status).toBe(200);
      const body = await res.json() as Rule[];
      expect(body).toHaveLength(1);
    });
  });

  describe("POST /rules", () => {
    it("creates a Rule and returns 201", async () => {
      vi.mocked(store.createRule).mockResolvedValueOnce(makeRule() as never);

      const res = await req(app, "POST", "/rules", {
        body: {
          name: "Archive newsletters",
          condition: '{"==": [{"var": "arc.category"}, "newsletter"]}',
          actions: [{ type: "archive" }],
        },
      });
      expect(res.status).toBe(201);
      expect(store.createRule).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ name: "Archive newsletters" }),
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await req(app, "POST", "/rules", {
        body: { condition: "{}", actions: [{ type: "archive" }] },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when actions array is empty", async () => {
      const res = await req(app, "POST", "/rules", {
        body: { name: "Bad rule", condition: "{}", actions: [] },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /rules/:id", () => {
    it("updates Rule properties", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce([makeRule()]);

      const res = await req(app, "PATCH", "/rules/rule-001", { body: { name: "Updated rule" } });
      expect(res.status).toBe(200);
      expect(store.updateRule).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "rule-001",
        expect.objectContaining({ name: "Updated rule" }),
      );
    });

    it("returns 404 for unknown Rule", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce([]);
      const res = await req(app, "PATCH", "/rules/nonexistent", { body: { name: "x" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /rules/:id", () => {
    it("deletes the Rule", async () => {
      vi.mocked(store.listRules).mockResolvedValueOnce([makeRule()]);

      const res = await req(app, "DELETE", "/rules/rule-001");
      expect(res.status).toBe(204);
      expect(store.deleteRule).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "rule-001");
    });
  });

  describe("POST /rules/reorder", () => {
    it("reorders rules by ID array", async () => {
      const res = await req(app, "POST", "/rules/reorder", {
        body: { orderedIds: ["rule-002", "rule-001"] },
      });
      expect(res.status).toBe(200);
      expect(store.reorderRules).toHaveBeenCalledWith(TEST_ACCOUNT_ID, ["rule-002", "rule-001"]);
    });
  });

  // -------------------------------------------------------------------------
  // Domain routes
  // -------------------------------------------------------------------------

  describe("GET /domains", () => {
    it("returns all Domains for the account", async () => {
      vi.mocked(store.listDomains).mockResolvedValueOnce([makeDomain()]);

      const res = await req(app, "GET", "/domains");
      expect(res.status).toBe(200);
      const body = await res.json() as Domain[];
      expect(body).toHaveLength(1);
    });
  });

  describe("POST /domains", () => {
    it("adds a Domain and returns 201", async () => {
      vi.mocked(store.createDomain).mockResolvedValueOnce(makeDomain() as never);

      const res = await req(app, "POST", "/domains", { body: { domain: "example.com" } });
      expect(res.status).toBe(201);
      expect(store.createDomain).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "example.com");
    });

    it("returns 400 when domain is missing", async () => {
      const res = await req(app, "POST", "/domains", { body: {} });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /domains/:id/dkim", () => {
    it("returns DKIM DNS records for a Domain", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain());

      const res = await req(app, "GET", "/domains/domain-001/dkim");
      expect(res.status).toBe(200);

      const body = await res.json() as Array<{ type: string; name: string; value: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty("type");
      expect(body[0]).toHaveProperty("name");
      expect(body[0]).toHaveProperty("value");
    });

    it("returns 404 for unknown Domain", async () => {
      const res = await req(app, "GET", "/domains/nonexistent/dkim");
      expect(res.status).toBe(404);
    });

    it("returns 403 when Domain belongs to a different account", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain({ accountId: "other" }));
      const res = await req(app, "GET", "/domains/domain-001/dkim");
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /domains/:id", () => {
    it("removes the Domain", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain());

      const res = await req(app, "DELETE", "/domains/domain-001");
      expect(res.status).toBe(204);
      expect(store.deleteDomain).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "domain-001");
    });
  });

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  describe("GET /search", () => {
    it("returns Arc search results", async () => {
      vi.mocked(store.searchArcs).mockResolvedValueOnce({ items: [makeArc()], total: 1 });

      const res = await req(app, "GET", "/search?q=invoice+from+stripe");
      expect(res.status).toBe(200);

      const body = await res.json() as { items: unknown[]; total: number };
      expect(body.items).toHaveLength(1);
      expect(store.searchArcs).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        "invoice from stripe",
        expect.any(Object),
      );
    });

    it("returns 400 when query is missing", async () => {
      const res = await req(app, "GET", "/search");
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  describe("GET /account", () => {
    it("returns the account config", async () => {
      vi.mocked(store.getAccount).mockResolvedValueOnce(makeAccount());

      const res = await req(app, "GET", "/account");
      expect(res.status).toBe(200);

      const body = await res.json() as Account;
      expect(body.id).toBe(TEST_ACCOUNT_ID);
      expect(body.deletionRetentionDays).toBe(30);
    });

    it("returns 404 when account does not exist yet", async () => {
      const res = await req(app, "GET", "/account");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /account", () => {
    it("updates notification email settings", async () => {
      const res = await req(app, "PATCH", "/account", {
        body: {
          notifications: {
            email: { enabled: true, address: "alerts@example.com", frequency: "instant" },
          },
        },
      });
      expect(res.status).toBe(200);
      expect(store.updateAccount).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({
          notifications: {
            email: { enabled: true, address: "alerts@example.com", frequency: "instant" },
          },
        }),
      );
    });

    it("updates deletionRetentionDays", async () => {
      const res = await req(app, "PATCH", "/account", {
        body: { deletionRetentionDays: 90 },
      });
      expect(res.status).toBe(200);
      expect(store.updateAccount).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ deletionRetentionDays: 90 }),
      );
    });

    it("updates push notification config", async () => {
      const res = await req(app, "PATCH", "/account", {
        body: {
          notifications: {
            push: { enabled: true },
          },
        },
      });
      expect(res.status).toBe(200);
    });
  });
});
