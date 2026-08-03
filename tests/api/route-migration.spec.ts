import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import type { AuthService, AccessService, IForwardingService } from "../../src/api/app.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { AuditDatabase } from "../../src/database/audit-database.js";
import { ok } from "neverthrow";
import type { EmailService } from "../../src/email/email-service.js";
import type { sendRsvp } from "../../src/processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../../src/processor/calendar/post-approval-handler.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";

// ---------------------------------------------------------------------------
// Test doubles (minimal — only what's needed for migration verification)
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-migration-001";
const TEST_USER_ID = "user-migration-001";
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

function makeThreadDb() {
  return {
    listThreads: vi.fn().mockResolvedValue(ok({ items: [] })),
    getThread: vi.fn().mockResolvedValue(ok(null)),
    updateThread: vi.fn().mockResolvedValue(ok({})),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreThreadSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    findThreadByGroupingKey: vi.fn().mockResolvedValue(ok(null)),
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    updateSignal: vi.fn().mockResolvedValue(ok({})),
    deleteSignal: vi.fn().mockResolvedValue(ok(undefined)),
    unblockSignal: vi.fn().mockResolvedValue(ok(undefined)),
    createThread: vi.fn().mockResolvedValue(ok(undefined)),
    batchGetThreads: vi.fn().mockResolvedValue(ok([])),
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
    updateAccount: vi.fn().mockResolvedValue(ok({})),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok({})),
    upsertAlias: vi.fn().mockResolvedValue(ok({})),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    listForwardingTargets: vi.fn().mockResolvedValue(ok([])),
    getForwardingTarget: vi.fn().mockResolvedValue(ok(null)),
    saveForwardingTarget: vi.fn().mockResolvedValue(ok(undefined)),
    deleteForwardingTarget: vi.fn().mockResolvedValue(ok(undefined)),
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
// Route migration backward-compatibility tests
// ---------------------------------------------------------------------------

describe("Route migration — backward compatibility", () => {
  let threadDb: ReturnType<typeof makeThreadDb>;
  let accountDb: ReturnType<typeof makeAccountDb>;
  let auditDb: ReturnType<typeof makeAuditDb>;
  let auth: AuthService;
  let access: AccessService;
  let forwardingService: IForwardingService;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    threadDb = makeThreadDb();
    accountDb = makeAccountDb();
    auditDb = makeAuditDb();
    auth = makeAuth();
    access = makeAccess();
    forwardingService = { sendVerification: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
    app = createApp(makeAppDeps({ threadDb: threadDb as unknown as ThreadDatabase, accountDb: accountDb as unknown as AccountDatabase, auditDb: auditDb as unknown as AuditDatabase, auth, access, logger: createMockLogger(), forwardingService, jobDispatcher: { dispatchReindex: vi.fn(), dispatchSegment: vi.fn() } as never, draftSendDispatcher: { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as never, accountCreationStarter: { start: vi.fn() }, appBaseUrl: "http://localhost", contentCdnBaseUrl: "https://cdn.test", astValidator: { validateAstBatch: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast_batch", results: [] }) } as never, billingHandler: new BillingHandler(), emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, domainIdentityService: { register: vi.fn().mockResolvedValue(ok(undefined)), deregister: vi.fn().mockResolvedValue(ok(undefined)) }, rsvpComposer: vi.fn().mockResolvedValue(ok(undefined)) as unknown as typeof sendRsvp, postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as unknown as PostApprovalCalendarHandlerDeps, schedulerClient: { scheduleMessage: vi.fn().mockResolvedValue(ok(undefined)), deleteSchedule: vi.fn().mockResolvedValue(ok(undefined)) } as never }));
  });

  // -------------------------------------------------------------------------
  // Authorized users still get 200 (Requirements 6.1, 6.4)
  // -------------------------------------------------------------------------

  describe("authorized users get 200 responses", () => {
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
      await req(app, "GET", `${A}/threads`);
      // threadDb.listThreads should not be called because the middleware short-circuits
      expect(threadDb.listThreads).not.toHaveBeenCalled();
    });
  });
});
