import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import type { AuthService, AccessService, VerificationMailer } from "../../src/api/app.js";
import type { ArcDatabase } from "../../src/database/arc-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { AuditDatabase } from "../../src/database/audit-database.js";
import { ok, err } from "neverthrow";
import type { DbError, NotFoundError } from "../../src/errors.js";
import { dbError, notFoundError } from "../../src/errors.js";
import type { Arc, Account, Alias, Domain } from "../../src/types/index.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { sendRsvp } from "../../src/processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../../src/processor/calendar/post-approval-handler.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-err-001";
const TEST_USER_ID = "user-err-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

const validAuth = { userId: TEST_USER_ID };

function makeAuth(): AuthService {
  return { verify: vi.fn().mockReturnValue(Promise.resolve(ok(validAuth))) };
}

function makeAccess(): AccessService {
  return {
    listUsers: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    listAccountsForUser: vi.fn().mockReturnValue(Promise.resolve(ok([]))),
    addUser: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    updateUserRole: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    removeUser: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    createInvite: vi.fn().mockReturnValue(Promise.resolve(ok({ inviteId: "inv-test" }))),
    getUserProfile: vi.fn().mockReturnValue(Promise.resolve(ok({}))),
    
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
    senderAddress: "sender@example.com",
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: TEST_ACCOUNT_ID,
    name: "Test Account",
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
    domain: "example.com",
    alias: "user",
    unknownSenderPolicy: "quarantine_visible",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    accountId: TEST_ACCOUNT_ID,
    domain: "example.com",
    receivingSetupComplete: false,
    senderSetupComplete: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeArcDb() {
  return {
    listArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getArc: vi.fn().mockResolvedValue(ok(null)),
    updateArc: vi.fn().mockResolvedValue(ok(makeArc())),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreArcSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    fastFindArcByAlternativeLookupKey: vi.fn().mockResolvedValue(ok(null)),
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    updateSignal: vi.fn().mockResolvedValue(ok({})),
    deleteSignal: vi.fn().mockResolvedValue(ok(undefined)),
    unblockSignal: vi.fn().mockResolvedValue(ok(undefined)),
    createArc: vi.fn().mockResolvedValue(ok(undefined)),
    searchArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
  };
}

function makeAccountDb() {
  return {
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
    getAccount: vi.fn().mockResolvedValue(ok(null)),
    updateAccount: vi.fn().mockResolvedValue(ok(makeAccount())),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok(makeAlias())),
    upsertAlias: vi.fn().mockResolvedValue(ok(makeAlias())),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
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
  };
}

function makeAuditDb() {
  return {
    listAuditEvents: vi.fn().mockResolvedValue(ok({ items: [] })),
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
// Unit tests: API route error mapping (Requirements 4.1–4.6, 8.1–8.3)
// ---------------------------------------------------------------------------

describe("API route error mapping — unit tests", () => {
  let arcDb: ReturnType<typeof makeArcDb>;
  let accountDb: ReturnType<typeof makeAccountDb>;
  let auditDb: ReturnType<typeof makeAuditDb>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    arcDb = makeArcDb();
    accountDb = makeAccountDb();
    auditDb = makeAuditDb();
    const auth = makeAuth();
    const access = makeAccess();
    const verificationMailer: VerificationMailer = { sendForwardVerification: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
    app = createApp(makeAppDeps({ arcDb: arcDb as unknown as ArcDatabase, accountDb: accountDb as unknown as AccountDatabase, auditDb: auditDb as unknown as AuditDatabase, auth, access, logger: createMockLogger(), verificationMailer, jobDispatcher: { dispatchReindex: vi.fn(), dispatchSegment: vi.fn() } as never, draftSendDispatcher: { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as never, accountCreationStarter: { start: vi.fn() }, appBaseUrl: "http://localhost", contentCdnBaseUrl: "https://cdn.test", astValidator: { validateAstBatch: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast_batch", results: [] }) } as never, billingHandler: new BillingHandler(), emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, domainIdentityService: { register: vi.fn().mockResolvedValue(ok(undefined)), deregister: vi.fn().mockResolvedValue(ok(undefined)) }, rsvpComposer: vi.fn().mockResolvedValue(ok(undefined)) as unknown as typeof sendRsvp, postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as unknown as PostApprovalCalendarHandlerDeps, schedulerClient: { scheduleMessage: vi.fn().mockResolvedValue(ok(undefined)), deleteSchedule: vi.fn().mockResolvedValue(ok(undefined)) } as never }));
  });

  // -------------------------------------------------------------------------
  // GET /accounts/:accountId/arcs/:id
  // -------------------------------------------------------------------------

  describe("GET /accounts/:accountId/arcs/:id", () => {
    it("returns HTTP 500 when store returns err({ kind: 'db_error' })", async () => {
      vi.mocked(arcDb.getArc).mockResolvedValueOnce(err(dbError(new Error("connection timeout"))));
      const res = await req(app, "GET", `${A}/arcs/arc-001`);
      expect(res.status).toBe(500);
      const body = await res.json() as { title: string };
      expect(body.title).toBe("Internal Server Error");
    });

    it("returns HTTP 404 when store returns ok(null)", async () => {
      vi.mocked(arcDb.getArc).mockResolvedValueOnce(ok(null));
      const res = await req(app, "GET", `${A}/arcs/arc-001`);
      expect(res.status).toBe(404);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("ARC_NOT_FOUND");
    });

    it("returns HTTP 200 when store returns ok(arc)", async () => {
      vi.mocked(arcDb.getArc).mockResolvedValueOnce(ok(makeArc()));
      const res = await req(app, "GET", `${A}/arcs/arc-001`);
      expect(res.status).toBe(200);
      const body = await res.json() as { arcId: string };
      expect(body.arcId).toBe("arc-001");
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /accounts/:accountId/arcs/:id
  // -------------------------------------------------------------------------

  describe("PATCH /accounts/:accountId/arcs/:id", () => {
    it("returns HTTP 500 when getArc returns err({ kind: 'db_error' })", async () => {
      vi.mocked(arcDb.getArc).mockResolvedValueOnce(err(dbError(new Error("dynamo unavailable"))));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(500);
    });

    it("returns HTTP 404 when getArc returns ok(null)", async () => {
      vi.mocked(arcDb.getArc).mockResolvedValueOnce(ok(null));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(404);
    });

    it("returns HTTP 500 when updateArc returns err({ kind: 'db_error' })", async () => {
      vi.mocked(arcDb.getArc).mockResolvedValueOnce(ok(makeArc()));
      vi.mocked(arcDb.updateArc).mockResolvedValueOnce(err(dbError(new Error("write failed"))));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(500);
    });

    it("returns HTTP 200 when update succeeds", async () => {
      vi.mocked(arcDb.getArc).mockResolvedValueOnce(ok(makeArc()));
      vi.mocked(arcDb.updateArc).mockResolvedValueOnce(ok(makeArc({ status: "archived" })));
      const res = await req(app, "PATCH", `${A}/arcs/arc-001`, { body: { status: "archived" } });
      expect(res.status).toBe(200);
      const body = await res.json() as Arc;
      expect(body.status).toBe("archived");
    });

    it("zParse throws HTTPException for invalid request body", async () => {
      vi.mocked(arcDb.getArc).mockResolvedValueOnce(ok(makeArc()));
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
      vi.mocked(accountDb.getAccount).mockResolvedValueOnce(err(dbError(new Error("rds timeout"))));
      const res = await req(app, "GET", `${A}`);
      expect(res.status).toBe(500);
      const body = await res.json() as { title: string };
      expect(body.title).toBe("Internal Server Error");
    });

    it("returns HTTP 404 when store returns ok(null)", async () => {
      vi.mocked(accountDb.getAccount).mockResolvedValueOnce(ok(null));
      const res = await req(app, "GET", `${A}`);
      expect(res.status).toBe(404);
      const body = await res.json() as { errorCode: string };
      expect(body.errorCode).toBe("ACCOUNT_NOT_FOUND");
    });

    it("returns HTTP 200 when store returns ok(account)", async () => {
      vi.mocked(accountDb.getAccount).mockResolvedValueOnce(ok(makeAccount()));
      const res = await req(app, "GET", `${A}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { accountId: string };
      expect(body.accountId).toBe(TEST_ACCOUNT_ID);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /accounts/:accountId/aliases/:address (rename)
  // -------------------------------------------------------------------------

  describe("PATCH /accounts/:accountId/aliases/:address — rename", () => {
    it("returns HTTP 404 when renameAlias returns err({ kind: 'not_found' })", async () => {
      vi.mocked(accountDb.getDomain).mockResolvedValueOnce(ok(makeDomain({ domain: "example.com" })));
      vi.mocked(accountDb.renameAlias).mockResolvedValueOnce(
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
      vi.mocked(accountDb.getDomain).mockResolvedValueOnce(ok(makeDomain({ domain: "example.com" })));
      vi.mocked(accountDb.renameAlias).mockResolvedValueOnce(
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
      vi.mocked(accountDb.getDomain).mockResolvedValueOnce(ok(makeDomain({ domain: "example.com" })));
      vi.mocked(accountDb.renameAlias).mockResolvedValueOnce(
        ok(makeAlias({ domain: "example.com", alias: "new", address: "new@example.com" })),
      );
      const res = await req(app, "PATCH", `${A}/aliases/old%40example.com`, {
        body: { newAddress: "new@example.com" },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { address: string };
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
      vi.mocked(arcDb.getArc).mockResolvedValueOnce(ok(makeArc()));
      // Send a request with non-JSON body to trigger zParse failure
      const res = await app.fetch(
        new Request(`http://localhost${A}/arcs/arc-001`, {
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
