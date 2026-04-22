import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Tab, Email, EmailCategory } from "@ses-adapter/shared";
import type { EmailDomain, AccountMember, Webhook } from "@ses-adapter/shared";
import { createApp } from "./app.js";
import type { ApiStore } from "./store.js";
import type { AuthService, AuthContext } from "./auth.js";
import type { StorageService } from "./storage.js";
import type { EmailSender } from "./sender.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-test-001";
const TEST_USER_ID = "user-test-001";

const validAuth: AuthContext = {
  accountId: TEST_ACCOUNT_ID,
  userId: TEST_USER_ID,
};

function makeAuth(ctx: AuthContext = validAuth): AuthService {
  return {
    verify: vi.fn().mockResolvedValue(ctx),
  };
}

function makeStore(): ApiStore {
  return {
    listEmails: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getEmail: vi.fn().mockResolvedValue(null),
    updateEmail: vi.fn().mockResolvedValue(undefined),
    bulkUpdateEmails: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    listTabs: vi.fn().mockResolvedValue([]),
    getTab: vi.fn().mockResolvedValue(null),
    createTab: vi.fn().mockResolvedValue(undefined),
    updateTab: vi.fn().mockResolvedValue(undefined),
    deleteTab: vi.fn().mockResolvedValue(undefined),
    reorderTabs: vi.fn().mockResolvedValue(undefined),
    listDomains: vi.fn().mockResolvedValue([]),
    getDomain: vi.fn().mockResolvedValue(null),
    createDomain: vi.fn().mockResolvedValue(undefined),
    deleteDomain: vi.fn().mockResolvedValue(undefined),
    listMembers: vi.fn().mockResolvedValue([]),
    addMember: vi.fn().mockResolvedValue(undefined),
    removeMember: vi.fn().mockResolvedValue(undefined),
    listWebhooks: vi.fn().mockResolvedValue([]),
    createWebhook: vi.fn().mockResolvedValue(undefined),
    deleteWebhook: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStorage(): StorageService {
  return {
    getAttachmentUrl: vi.fn().mockResolvedValue("https://s3.example.com/signed-url"),
  };
}

function makeSender(): EmailSender {
  return {
    send: vi.fn().mockResolvedValue({ messageId: "sent-msg-id" }),
    reply: vi.fn().mockResolvedValue({ messageId: "reply-msg-id" }),
    forward: vi.fn().mockResolvedValue({ messageId: "fwd-msg-id" }),
  };
}

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: "email-001",
    accountId: TEST_ACCOUNT_ID,
    messageId: "msg-001",
    threadId: "thread-001",
    from: { address: "sender@example.com", name: "Sender" },
    to: [{ address: "user@example.com" }],
    cc: [],
    subject: "Test email",
    receivedAt: "2024-01-15T10:00:00Z",
    attachments: [],
    category: "personal",
    categoryData: { category: "personal", isReply: false, sentiment: "neutral", requiresReply: false },
    spamScore: 0.02,
    isValid: true,
    summary: "A test email.",
    priority: "normal",
    recipientDomain: "example.com",
    recipientLocalPart: "user",
    isRead: false,
    isArchived: false,
    isTrashed: false,
    isStarred: false,
    labels: [],
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-001",
    accountId: TEST_ACCOUNT_ID,
    name: "Inbox",
    category: "personal",
    filters: [],
    sortOrder: { field: "receivedAt", direction: "desc" },
    displayConfig: {
      columns: [{ field: "from", label: "From", format: { type: "text" } }],
      showThreadIndicator: true,
      showLabels: true,
      showAttachmentIndicator: true,
    },
    position: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeDomain(overrides: Partial<EmailDomain> = {}): EmailDomain {
  return {
    id: "domain-001",
    accountId: TEST_ACCOUNT_ID,
    domain: "example.com",
    verificationStatus: "pending",
    sesRuleSetName: "ses-ruleset-example",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: "webhook-001",
    accountId: TEST_ACCOUNT_ID,
    url: "https://myapp.example.com/webhooks/ses",
    events: ["email.received"],
    signingSecret: "secret-abc",
    isActive: true,
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Make a request to the Hono app and return the response. */
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
  let storage: StorageService;
  let sender: EmailSender;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    auth = makeAuth();
    storage = makeStorage();
    sender = makeSender();
    app = createApp({ store, auth, storage, sender });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await req(app, "GET", "/emails", { token: "" });
      expect(res.status).toBe(401);
    });

    it("returns 401 when token is invalid", async () => {
      vi.mocked(auth.verify).mockRejectedValueOnce(new Error("Invalid token"));
      const res = await req(app, "GET", "/emails", { token: "bad-token" });
      expect(res.status).toBe(401);
    });

    it("passes auth context to store operations", async () => {
      await req(app, "GET", "/emails");
      expect(store.listEmails).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Email routes
  // -------------------------------------------------------------------------

  describe("GET /emails", () => {
    it("returns paginated email list", async () => {
      const email = makeEmail();
      vi.mocked(store.listEmails).mockResolvedValueOnce({ items: [email], total: 1 });

      const res = await req(app, "GET", "/emails");
      expect(res.status).toBe(200);

      const body = await res.json() as { items: unknown[]; total: number };
      expect(body.total).toBe(1);
      expect(body.items).toHaveLength(1);
    });

    it("passes query filters to the store", async () => {
      await req(app, "GET", "/emails?category=invoice&isRead=false&limit=25");
      expect(store.listEmails).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({
          category: "invoice" as EmailCategory,
          isRead: false,
          limit: 25,
        }),
      );
    });

    it("email list items include category preview fields", async () => {
      const email = makeEmail({
        category: "invoice",
        categoryData: {
          category: "invoice",
          invoiceType: "receipt",
          vendor: "Stripe",
          amount: 99,
          currency: "USD",
          invoiceNumber: "INV-001",
          dueDate: null,
          lineItems: [],
          downloadUrl: null,
        },
      });
      vi.mocked(store.listEmails).mockResolvedValueOnce({ items: [email], total: 1 });

      const res = await req(app, "GET", "/emails");
      const body = await res.json() as { items: Array<{ categoryPreview: Record<string, unknown> }> };
      expect(body.items[0]?.categoryPreview).toMatchObject({ vendor: "Stripe", amount: 99 });
    });

    it("does not include full body content in list items", async () => {
      const email = makeEmail({ textBody: "Full body text here", htmlBody: "<p>HTML</p>" });
      vi.mocked(store.listEmails).mockResolvedValueOnce({ items: [email], total: 1 });

      const res = await req(app, "GET", "/emails");
      const body = await res.json() as { items: Array<Record<string, unknown>> };
      expect(body.items[0]).not.toHaveProperty("textBody");
      expect(body.items[0]).not.toHaveProperty("htmlBody");
    });
  });

  describe("GET /emails/:id", () => {
    it("returns full email including body", async () => {
      const email = makeEmail({ textBody: "Hello world", htmlBody: "<p>Hello</p>" });
      vi.mocked(store.getEmail).mockResolvedValueOnce(email);

      const res = await req(app, "GET", "/emails/email-001");
      expect(res.status).toBe(200);

      const body = await res.json() as Email;
      expect(body.id).toBe("email-001");
      expect(body.textBody).toBe("Hello world");
    });

    it("returns 404 for unknown email", async () => {
      vi.mocked(store.getEmail).mockResolvedValueOnce(null);
      const res = await req(app, "GET", "/emails/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 403 when email belongs to a different account", async () => {
      const email = makeEmail({ accountId: "other-account" });
      vi.mocked(store.getEmail).mockResolvedValueOnce(email);

      const res = await req(app, "GET", "/emails/email-001");
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /emails/:id", () => {
    it("marks email as read", async () => {
      vi.mocked(store.getEmail).mockResolvedValueOnce(makeEmail());

      const res = await req(app, "PATCH", "/emails/email-001", {
        body: { isRead: true },
      });
      expect(res.status).toBe(200);
      expect(store.updateEmail).toHaveBeenCalledWith(
        "email-001",
        expect.objectContaining({ isRead: true }),
      );
    });

    it("returns 404 when email does not exist", async () => {
      vi.mocked(store.getEmail).mockResolvedValueOnce(null);
      const res = await req(app, "PATCH", "/emails/nonexistent", {
        body: { isRead: true },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /emails/bulk", () => {
    it("applies update to all specified email IDs", async () => {
      const res = await req(app, "POST", "/emails/bulk", {
        body: { ids: ["email-1", "email-2"], update: { isArchived: true } },
      });
      expect(res.status).toBe(200);
      expect(store.bulkUpdateEmails).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        ["email-1", "email-2"],
        { isArchived: true },
      );
    });

    it("returns 400 when ids array is empty", async () => {
      const res = await req(app, "POST", "/emails/bulk", {
        body: { ids: [], update: { isRead: true } },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /emails/:id", () => {
    it("trashes the email", async () => {
      vi.mocked(store.getEmail).mockResolvedValueOnce(makeEmail());

      const res = await req(app, "DELETE", "/emails/email-001");
      expect(res.status).toBe(204);
      expect(store.deleteEmail).toHaveBeenCalledWith("email-001");
    });

    it("returns 404 for unknown email", async () => {
      vi.mocked(store.getEmail).mockResolvedValueOnce(null);
      const res = await req(app, "DELETE", "/emails/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Attachment download
  // -------------------------------------------------------------------------

  describe("GET /emails/:id/attachments/:attachmentId/download", () => {
    it("returns a presigned S3 URL for the attachment", async () => {
      const email = makeEmail({
        attachments: [{
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          sizeBytes: 12345,
          s3Key: "attachments/email-001/invoice.pdf",
        }],
      });
      vi.mocked(store.getEmail).mockResolvedValueOnce(email);

      const res = await req(app, "GET", "/emails/email-001/attachments/0/download");
      expect(res.status).toBe(200);

      const body = await res.json() as { url: string; expiresAt: string };
      expect(body.url).toBe("https://s3.example.com/signed-url");
      expect(body.expiresAt).toBeTruthy();
    });

    it("returns 404 when attachment index is out of range", async () => {
      vi.mocked(store.getEmail).mockResolvedValueOnce(makeEmail({ attachments: [] }));
      const res = await req(app, "GET", "/emails/email-001/attachments/0/download");
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Tab routes
  // -------------------------------------------------------------------------

  describe("GET /tabs", () => {
    it("returns all tabs for the account ordered by position", async () => {
      const tabs = [makeTab({ position: 0 }), makeTab({ id: "tab-002", position: 1 })];
      vi.mocked(store.listTabs).mockResolvedValueOnce(tabs);

      const res = await req(app, "GET", "/tabs");
      expect(res.status).toBe(200);

      const body = await res.json() as Tab[];
      expect(body).toHaveLength(2);
    });
  });

  describe("POST /tabs", () => {
    it("creates a new tab and returns it", async () => {
      const newTab = makeTab({ id: "tab-new" });
      vi.mocked(store.createTab).mockResolvedValueOnce(newTab);

      const res = await req(app, "POST", "/tabs", {
        body: { name: "Invoices", category: "invoice" },
      });
      expect(res.status).toBe(201);
      expect(store.createTab).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ name: "Invoices", category: "invoice" }),
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await req(app, "POST", "/tabs", {
        body: { category: "invoice" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when category is invalid", async () => {
      const res = await req(app, "POST", "/tabs", {
        body: { name: "Bad Tab", category: "not-a-category" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /tabs/:id", () => {
    it("updates tab properties", async () => {
      vi.mocked(store.getTab).mockResolvedValueOnce(makeTab());

      const res = await req(app, "PATCH", "/tabs/tab-001", {
        body: { name: "My Invoices", color: "#ff0000" },
      });
      expect(res.status).toBe(200);
      expect(store.updateTab).toHaveBeenCalledWith(
        "tab-001",
        expect.objectContaining({ name: "My Invoices" }),
      );
    });

    it("returns 404 for unknown tab", async () => {
      vi.mocked(store.getTab).mockResolvedValueOnce(null);
      const res = await req(app, "PATCH", "/tabs/nonexistent", { body: { name: "X" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /tabs/:id", () => {
    it("deletes the tab", async () => {
      vi.mocked(store.getTab).mockResolvedValueOnce(makeTab());

      const res = await req(app, "DELETE", "/tabs/tab-001");
      expect(res.status).toBe(204);
      expect(store.deleteTab).toHaveBeenCalledWith("tab-001");
    });
  });

  describe("POST /tabs/reorder", () => {
    it("reorders tabs by ID array", async () => {
      const res = await req(app, "POST", "/tabs/reorder", {
        body: { orderedIds: ["tab-002", "tab-001"] },
      });
      expect(res.status).toBe(200);
      expect(store.reorderTabs).toHaveBeenCalledWith(TEST_ACCOUNT_ID, ["tab-002", "tab-001"]);
    });
  });

  // -------------------------------------------------------------------------
  // Domain routes
  // -------------------------------------------------------------------------

  describe("GET /domains", () => {
    it("returns all domains for the account", async () => {
      vi.mocked(store.listDomains).mockResolvedValueOnce([makeDomain()]);

      const res = await req(app, "GET", "/domains");
      expect(res.status).toBe(200);
      const body = await res.json() as EmailDomain[];
      expect(body).toHaveLength(1);
    });
  });

  describe("POST /domains", () => {
    it("adds a domain and returns it with verification status pending", async () => {
      const domain = makeDomain({ verificationStatus: "pending" });
      vi.mocked(store.createDomain).mockResolvedValueOnce(domain);

      const res = await req(app, "POST", "/domains", {
        body: { domain: "example.com" },
      });
      expect(res.status).toBe(201);

      const body = await res.json() as EmailDomain;
      expect(body.verificationStatus).toBe("pending");
      expect(body.domain).toBe("example.com");
    });

    it("returns 400 when domain is missing", async () => {
      const res = await req(app, "POST", "/domains", { body: {} });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /domains/:id/verification", () => {
    it("returns DNS records required for verification", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain());

      const res = await req(app, "GET", "/domains/domain-001/verification");
      expect(res.status).toBe(200);

      const body = await res.json() as Array<{ type: string; name: string; value: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty("type");
      expect(body[0]).toHaveProperty("name");
      expect(body[0]).toHaveProperty("value");
    });

    it("returns 404 for unknown domain", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(null);
      const res = await req(app, "GET", "/domains/nonexistent/verification");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /domains/:id", () => {
    it("removes the domain", async () => {
      vi.mocked(store.getDomain).mockResolvedValueOnce(makeDomain());

      const res = await req(app, "DELETE", "/domains/domain-001");
      expect(res.status).toBe(204);
      expect(store.deleteDomain).toHaveBeenCalledWith("domain-001");
    });
  });

  // -------------------------------------------------------------------------
  // Member routes
  // -------------------------------------------------------------------------

  describe("GET /members", () => {
    it("returns all account members", async () => {
      const member: AccountMember = {
        userId: TEST_USER_ID,
        email: "user@example.com",
        role: "owner",
        addedAt: "2024-01-01T00:00:00Z",
      };
      vi.mocked(store.listMembers).mockResolvedValueOnce([member]);

      const res = await req(app, "GET", "/members");
      expect(res.status).toBe(200);
      const body = await res.json() as AccountMember[];
      expect(body).toHaveLength(1);
      expect(body[0]?.role).toBe("owner");
    });
  });

  describe("POST /members", () => {
    it("invites a new member", async () => {
      const res = await req(app, "POST", "/members", {
        body: { email: "newuser@example.com", role: "member" },
      });
      expect(res.status).toBe(201);
      expect(store.addMember).toHaveBeenCalledWith(
        TEST_ACCOUNT_ID,
        expect.objectContaining({ email: "newuser@example.com", role: "member" }),
      );
    });

    it("returns 400 for invalid role", async () => {
      const res = await req(app, "POST", "/members", {
        body: { email: "user@example.com", role: "superadmin" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /members/:userId", () => {
    it("removes a member from the account", async () => {
      const res = await req(app, "DELETE", "/members/user-to-remove");
      expect(res.status).toBe(204);
      expect(store.removeMember).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "user-to-remove");
    });
  });

  // -------------------------------------------------------------------------
  // Webhook routes
  // -------------------------------------------------------------------------

  describe("GET /webhooks", () => {
    it("returns all webhooks for the account", async () => {
      vi.mocked(store.listWebhooks).mockResolvedValueOnce([makeWebhook()]);

      const res = await req(app, "GET", "/webhooks");
      expect(res.status).toBe(200);
      const body = await res.json() as Webhook[];
      expect(body).toHaveLength(1);
    });

    it("does not expose signing secrets in the list", async () => {
      vi.mocked(store.listWebhooks).mockResolvedValueOnce([makeWebhook()]);

      const res = await req(app, "GET", "/webhooks");
      const body = await res.json() as Array<Record<string, unknown>>;
      expect(body[0]).not.toHaveProperty("signingSecret");
    });
  });

  describe("POST /webhooks", () => {
    it("creates a webhook and returns it with a signing secret", async () => {
      vi.mocked(store.createWebhook).mockResolvedValueOnce(makeWebhook());

      const res = await req(app, "POST", "/webhooks", {
        body: { url: "https://myapp.example.com/webhooks/ses", events: ["email.received"] },
      });
      expect(res.status).toBe(201);

      const body = await res.json() as Webhook;
      // Secret only shown at creation time
      expect(body.signingSecret).toBeTruthy();
    });

    it("returns 400 when url is missing", async () => {
      const res = await req(app, "POST", "/webhooks", {
        body: { events: ["email.received"] },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when events array is empty", async () => {
      const res = await req(app, "POST", "/webhooks", {
        body: { url: "https://example.com/hook", events: [] },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /webhooks/:id", () => {
    it("deletes the webhook", async () => {
      const res = await req(app, "DELETE", "/webhooks/webhook-001");
      expect(res.status).toBe(204);
      expect(store.deleteWebhook).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "webhook-001");
    });
  });

  // -------------------------------------------------------------------------
  // Email sending
  // -------------------------------------------------------------------------

  describe("POST /emails/send", () => {
    it("sends a new email and returns the sent message ID", async () => {
      const res = await req(app, "POST", "/emails/send", {
        body: {
          from: "me@example.com",
          to: ["recipient@example.com"],
          subject: "Hello",
          textBody: "Hello there",
        },
      });
      expect(res.status).toBe(202);

      const body = await res.json() as { messageId: string };
      expect(body.messageId).toBe("sent-msg-id");
      expect(sender.send).toHaveBeenCalledOnce();
    });

    it("returns 400 when to is empty", async () => {
      const res = await req(app, "POST", "/emails/send", {
        body: { from: "me@example.com", to: [], subject: "Hi", textBody: "Hi" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when subject is missing", async () => {
      const res = await req(app, "POST", "/emails/send", {
        body: { from: "me@example.com", to: ["r@example.com"], textBody: "Hi" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /emails/:id/reply", () => {
    it("sends a reply to the original email thread", async () => {
      vi.mocked(store.getEmail).mockResolvedValueOnce(makeEmail());

      const res = await req(app, "POST", "/emails/email-001/reply", {
        body: { textBody: "Thanks!" },
      });
      expect(res.status).toBe(202);
      expect(sender.reply).toHaveBeenCalledWith(
        expect.objectContaining({ id: "email-001" }),
        expect.objectContaining({ textBody: "Thanks!" }),
      );
    });

    it("returns 404 when original email does not exist", async () => {
      vi.mocked(store.getEmail).mockResolvedValueOnce(null);
      const res = await req(app, "POST", "/emails/nonexistent/reply", {
        body: { textBody: "Hi" },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /emails/:id/forward", () => {
    it("forwards the email to new recipients", async () => {
      vi.mocked(store.getEmail).mockResolvedValueOnce(makeEmail());

      const res = await req(app, "POST", "/emails/email-001/forward", {
        body: { to: ["colleague@example.com"], note: "FYI" },
      });
      expect(res.status).toBe(202);
      expect(sender.forward).toHaveBeenCalledOnce();
    });
  });
});
