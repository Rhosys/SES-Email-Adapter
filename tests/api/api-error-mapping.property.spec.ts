import { describe, it, expect, vi } from "vitest";
import { ok, err } from "neverthrow";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import type { AuthService, AccessService } from "../../src/api/app.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { AuditDatabase } from "../../src/database/audit-database.js";
import type { Thread } from "../../src/types/index.js";
import type { DbError } from "../../src/errors.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { sendRsvp } from "../../src/processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../../src/processor/calendar/post-approval-handler.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";

const TEST_ACCOUNT_ID = "acct-prop-001";
const TEST_USER_ID = "user-prop-001";
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

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "arc-001", accountId: TEST_ACCOUNT_ID, workflow: "conversation", labels: [], status: "active",
    summary: "A test arc.", lastSignalAt: "2024-01-15T10:00:00Z",
    createdAt: "2024-01-15T10:00:00Z", updatedAt: "2024-01-15T10:00:00Z",
    senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email",
    ...overrides,
  };
}

function makeThreadDb() {
  return {
    listThreads: vi.fn().mockResolvedValue(ok({ items: [] })),
    getThread: vi.fn().mockResolvedValue(ok(null)),
    updateThread: vi.fn().mockResolvedValue(ok(makeThread())),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreThreadSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    findThreadByGroupingKey: vi.fn().mockResolvedValue(ok(null)),
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    updateSignal: vi.fn().mockResolvedValue(ok({})),
    deleteSignal: vi.fn().mockResolvedValue(ok(undefined)),
    unblockSignal: vi.fn().mockResolvedValue(ok(undefined)),
    createThread: vi.fn().mockResolvedValue(ok(undefined)),
    searchThreads: vi.fn().mockResolvedValue(ok({ items: [] })),
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

function makeApp(threadDb: ReturnType<typeof makeThreadDb>, accountDb?: ReturnType<typeof makeAccountDb>, auditDb?: ReturnType<typeof makeAuditDb>) {
  return createApp(makeAppDeps({
    threadDb: threadDb as unknown as ThreadDatabase,
    accountDb: (accountDb ?? makeAccountDb()) as unknown as AccountDatabase,
    auditDb: (auditDb ?? makeAuditDb()) as unknown as AuditDatabase,
    auth: makeAuth(),
    access: makeAccess(),
    logger: createMockLogger(),
    forwardingService: { sendVerification: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), verifyWebhook: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
    jobDispatcher: { dispatchReindex: vi.fn(), dispatchSegment: vi.fn() } as never,
    draftSendDispatcher: { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as never,
    accountCreationStarter: { start: vi.fn() },
    appBaseUrl: "http://localhost",
    contentCdnBaseUrl: "https://cdn.test",
    astValidator: { validateAstBatch: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast_batch", results: [] }) } as never,
    billingHandler: new BillingHandler(),
    emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService,
    domainIdentityService: { register: vi.fn().mockResolvedValue(ok(undefined)), deregister: vi.fn().mockResolvedValue(ok(undefined)) },
    rsvpComposer: vi.fn().mockResolvedValue(ok(undefined)) as unknown as typeof sendRsvp,
    postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as unknown as PostApprovalCalendarHandlerDeps,
    schedulerClient: { scheduleMessage: vi.fn().mockResolvedValue(ok(undefined)), deleteSchedule: vi.fn().mockResolvedValue(ok(undefined)) } as never,
  }));
}

describe("API route error mapping consistency", () => {
  const scenarios = [
    { label: "db_error → 500", type: "db_error" as const, expectedStatus: 500 },
    { label: "null_read → 404", type: "null_read" as const, expectedStatus: 404 },
    { label: "success → 200", type: "success" as const, expectedStatus: 200 },
  ];

  describe("GET /accounts/:accountId/threads/:threadId", () => {
    it.each(scenarios)("$label", async ({ type, expectedStatus }) => {
      const threadDb = makeThreadDb();
      switch (type) {
        case "db_error":
          vi.mocked(threadDb.getThread).mockResolvedValue(err({ kind: "db_error", message: "mock error", cause: new Error("timeout") } satisfies DbError));
          break;
        case "null_read":
          vi.mocked(threadDb.getThread).mockResolvedValue(ok(null));
          break;
        case "success":
          vi.mocked(threadDb.getThread).mockResolvedValue(ok(makeThread()));
          break;
      }

      const app = makeApp(threadDb);
      const res = await app.fetch(new Request(`http://localhost/accounts/${TEST_ACCOUNT_ID}/threads/arc-001`, {
        headers: { Authorization: "Bearer valid-token" },
      }));
      expect(res.status).toBe(expectedStatus);
    });
  });

  describe("GET /accounts/:accountId/threads/:threadId/signals/:id", () => {
    it.each(scenarios)("$label", async ({ type, expectedStatus }) => {
      const threadDb = makeThreadDb();
      switch (type) {
        case "db_error":
          vi.mocked(threadDb.getSignalById).mockResolvedValue(err({ kind: "db_error", message: "mock error", cause: new Error("timeout") } satisfies DbError));
          break;
        case "null_read":
          vi.mocked(threadDb.getSignalById).mockResolvedValue(ok(null));
          break;
        case "success":
          vi.mocked(threadDb.getSignalById).mockResolvedValue(ok({
            id: "SES#msg-001", threadId: "arc-001", accountId: TEST_ACCOUNT_ID, source: "email",
            type: "email", status: "active", createdAt: "2024-01-15T10:00:00Z",
            data: {
              receivedAt: "2024-01-15T10:00:00Z", from: { address: "sender@example.com", name: "Sender" },
              to: [{ address: "user@example.com" }], cc: [], subject: "Test", attachments: [], headers: {},
              recipientAddress: "user@example.com", workflow: "conversation",
              workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
              tags: [], summary: "A test signal.",
              s3Key: "emails/msg-001",
            },
          } as any));
          break;
      }

      const app = makeApp(threadDb);
      const res = await app.fetch(new Request(`http://localhost/accounts/${TEST_ACCOUNT_ID}/threads/arc-001/signals/SES%23msg-001`, {
        headers: { Authorization: "Bearer valid-token" },
      }));
      expect(res.status).toBe(expectedStatus);
    });
  });

  describe("GET /accounts/:accountId/threads (list)", () => {
    it.each([
      { label: "db_error → 500", type: "db_error" as const, expectedStatus: 500 },
      { label: "success → 200", type: "success" as const, expectedStatus: 200 },
    ])("$label", async ({ type, expectedStatus }) => {
      const threadDb = makeThreadDb();
      switch (type) {
        case "db_error":
          vi.mocked(threadDb.listThreads).mockResolvedValue(err({ kind: "db_error", message: "mock error", cause: new Error("reset") } satisfies DbError));
          break;
        case "success":
          vi.mocked(threadDb.listThreads).mockResolvedValue(ok({ items: [makeThread()] }));
          break;
      }

      const app = makeApp(threadDb);
      const res = await app.fetch(new Request(`http://localhost/accounts/${TEST_ACCOUNT_ID}/threads`, {
        headers: { Authorization: "Bearer valid-token" },
      }));
      expect(res.status).toBe(expectedStatus);
    });
  });
});
