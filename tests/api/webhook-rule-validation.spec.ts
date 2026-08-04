import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import type { AuthService, AccessService } from "../../src/api/app.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { AuditDatabase } from "../../src/database/audit-database.js";
import type { Account, Rule } from "../../src/types/index.js";
import { ok } from "neverthrow";
import type { EmailService } from "../../src/email/email-service.js";
import type { sendRsvp } from "../../src/processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../../src/processor/calendar/post-approval-handler.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";

vi.mock("../../src/dns/mx-validator.js", () => ({
  validateRecipientMx: vi.fn().mockResolvedValue({ isOk: () => true, isErr: () => false, _unsafeUnwrap: () => undefined }),
}));

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-test-001";
const TEST_USER_ID = "user-test-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

function makeAuth(): AuthService {
  return { verify: vi.fn().mockReturnValue(Promise.resolve(ok({ userId: TEST_USER_ID }))) };
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

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: TEST_ACCOUNT_ID,
    name: "Test Account",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule-001",
    accountId: TEST_ACCOUNT_ID,
    name: "Forward rule",
    condition: '{"==": [1, 1]}',
    actions: [{ type: "forward", value: "backup@example.com" }],
    status: "enabled",
    priorityOrder: 100,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeArcDb() {
  return {
    listArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getArc: vi.fn().mockResolvedValue(ok(null)),
    updateArc: vi.fn().mockResolvedValue(ok(null)),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreArcSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    updateSignalStatus: vi.fn().mockResolvedValue(ok(null)),
    fastFindArcByAlternativeLookupKey: vi.fn().mockResolvedValue(ok(null)),
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    createSignal: vi.fn().mockResolvedValue(ok(null)),
    updateSignal: vi.fn().mockResolvedValue(ok(null)),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(null)),
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
    createView: vi.fn().mockResolvedValue(ok(null)),
    updateView: vi.fn().mockResolvedValue(ok(null)),
    deleteView: vi.fn().mockResolvedValue(ok(undefined)),
    listLabels: vi.fn().mockResolvedValue(ok([])),
    createLabel: vi.fn().mockResolvedValue(ok(null)),
    updateLabel: vi.fn().mockResolvedValue(ok(null)),
    deleteLabel: vi.fn().mockResolvedValue(ok(undefined)),
    listRules: vi.fn().mockResolvedValue(ok([])),
    createRule: vi.fn().mockResolvedValue(ok(makeRule())),
    updateRule: vi.fn().mockResolvedValue(ok(makeRule())),
    deleteRule: vi.fn().mockResolvedValue(ok(undefined)),
    listDomains: vi.fn().mockResolvedValue(ok([])),
    getDomain: vi.fn().mockResolvedValue(ok(null)),
    createDomain: vi.fn().mockResolvedValue(ok(null)),
    deleteDomain: vi.fn().mockResolvedValue(ok(undefined)),
    getAccount: vi.fn().mockResolvedValue(ok(makeAccount({ billingPlan: "Paid" }))),
    createAccount: vi.fn().mockResolvedValue(ok(null)),
    updateAccount: vi.fn().mockResolvedValue(ok(null)),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok(null)),
    upsertAlias: vi.fn().mockResolvedValue(ok(null)),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    listForwardingTargets: vi.fn().mockResolvedValue(ok([])),
    getForwardingTarget: vi.fn().mockResolvedValue(ok(null)),
    saveForwardingTarget: vi.fn().mockResolvedValue(ok(undefined)),
    deleteForwardingTarget: vi.fn().mockResolvedValue(ok(undefined)),
    updateDomainHealth: vi.fn().mockResolvedValue(ok(undefined)),
    renameAlias: vi.fn().mockResolvedValue(ok(null)),
    saveSender: vi.fn().mockResolvedValue(ok(undefined)),
    removeSender: vi.fn().mockResolvedValue(ok(undefined)),
    listSenders: vi.fn().mockResolvedValue(ok([])),
    createTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    getTemplate: vi.fn().mockResolvedValue(ok(null)),
    updateTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    deleteTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    listTemplates: vi.fn().mockResolvedValue(ok([])),
    getStats: vi.fn().mockResolvedValue(ok(null)),
  };
}

function makeAuditDb() {
  return {
    listAuditEvents: vi.fn().mockResolvedValue(ok({ items: [] })),
    saveAuditEvent: vi.fn().mockResolvedValue(ok(undefined)),
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

describe("API — webhook action type rejected from rule creation", () => {
  let threadDb: ReturnType<typeof makeArcDb>;
  let accountDb: ReturnType<typeof makeAccountDb>;
  let auditDb: ReturnType<typeof makeAuditDb>;
  let app: ReturnType<typeof createApp>;
  let astValidator: UserCodeExecutorClient;

  beforeEach(() => {
    vi.clearAllMocks();
    threadDb = makeArcDb();
    accountDb = makeAccountDb();
    auditDb = makeAuditDb();
    astValidator = {
      invoke: vi.fn().mockResolvedValue({ success: true, purpose: "rule_condition", result: true }),
      validateAst: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast", result: { valid: true } }),
      validateAstBatch: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast_batch", results: [] }),
    };
    app = createApp(makeAppDeps({
      threadDb: threadDb as unknown as ThreadDatabase,
      accountDb: accountDb as unknown as AccountDatabase,
      auditDb: auditDb as unknown as AuditDatabase,
      auth: makeAuth(),
      access: makeAccess(),
      logger: createMockLogger(),
      forwardingService: { sendVerification: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      jobDispatcher: { dispatchReindex: vi.fn(), dispatchSegment: vi.fn() } as never,
      draftSendDispatcher: { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as never,
      accountCreationStarter: { start: vi.fn() },
      contentCdnBaseUrl: "https://cdn.test",
      billingHandler: new BillingHandler(),
      astValidator,
      emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService,
      domainIdentityService: { register: vi.fn().mockResolvedValue(ok(undefined)), deregister: vi.fn().mockResolvedValue(ok(undefined)) },
      rsvpComposer: vi.fn().mockResolvedValue(ok(undefined)) as unknown as typeof sendRsvp,
      postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as unknown as PostApprovalCalendarHandlerDeps,
      schedulerClient: { scheduleMessage: vi.fn().mockResolvedValue(ok(undefined)), deleteSchedule: vi.fn().mockResolvedValue(ok(undefined)) } as never,
    }));
  });

  it("rejects webhook as an invalid action type at schema validation", async () => {
    const res = await req(app, "POST", `${A}/rules`, {
      body: {
        name: "Webhook rule",
        condition: '{"==": [1, 1]}',
        actions: [{ type: "webhook", value: '{"url":"https://example.com/hook"}' }],
      },
    });

    // Schema validation rejects "webhook" — not a valid RuleActionType
    expect(res.status).toBe(400);
  });
});
