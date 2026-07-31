import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Thread, Signal } from "../../src/types/index.js";
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
import type { DraftSendDispatcher } from "../../src/processor/draft-send-dispatcher.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";

vi.mock("../../src/dns/mx-validator.js", () => ({
  validateRecipientMx: vi.fn().mockResolvedValue({ isOk: () => true, isErr: () => false, _unsafeUnwrap: () => undefined }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-test-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

function makeThread(overrides: Partial<Thread> = {}): Thread {
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
    sender: { address: "sender@example.com" },
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

function makeSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "SES#msg-001",
    signalLookupId: "SES#msg-001",
    threadId: "arc-001",
    accountId: TEST_ACCOUNT_ID,
    source: "email" as const,
    type: "email",
    status: "quarantine_visible",
    createdAt: "2024-01-20T12:00:00Z",
    ...baseOverrides,
    data: {
      receivedAt: "2024-01-20T12:00:00Z",
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email",
      attachments: [],
      headers: {},
      recipientAddress: "user@example.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "A test signal.",
      s3Key: "emails/msg-001",
      ...dataOverrides,
    },
  } as Signal;
}

function makeThreadDb() {
  return {
    listThreads: vi.fn().mockResolvedValue(ok({ items: [] })),
    getThread: vi.fn().mockResolvedValue(ok(null)),
    updateThread: vi.fn().mockResolvedValue(ok(makeThread())),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreThreadSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    updateSignalStatus: vi.fn().mockImplementation((_, id, status) => Promise.resolve(ok({ id, status }))),
    findThreadByGroupingKey: vi.fn().mockResolvedValue(ok(null)),
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    createSignal: vi.fn().mockImplementation((signal) => Promise.resolve(ok(signal))),
    updateSignal: vi.fn().mockResolvedValue(ok(makeSignal())),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(makeSignal())),
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
    createView: vi.fn().mockResolvedValue(ok(makeThread())),
    updateView: vi.fn().mockResolvedValue(ok(makeThread())),
    deleteView: vi.fn().mockResolvedValue(ok(undefined)),
    listLabels: vi.fn().mockResolvedValue(ok([])),
    createLabel: vi.fn().mockResolvedValue(ok({ id: "l", accountId: TEST_ACCOUNT_ID, name: "x", color: "#000", createdAt: "" })),
    updateLabel: vi.fn().mockResolvedValue(ok({ id: "l", accountId: TEST_ACCOUNT_ID, name: "x", color: "#000", createdAt: "" })),
    deleteLabel: vi.fn().mockResolvedValue(ok(undefined)),
    listRules: vi.fn().mockResolvedValue(ok([])),
    createRule: vi.fn().mockResolvedValue(ok({} as never)),
    updateRule: vi.fn().mockResolvedValue(ok({} as never)),
    deleteRule: vi.fn().mockResolvedValue(ok(undefined)),
    listDomains: vi.fn().mockResolvedValue(ok([])),
    getDomain: vi.fn().mockResolvedValue(ok(null)),
    createDomain: vi.fn().mockResolvedValue(ok({} as never)),
    deleteDomain: vi.fn().mockResolvedValue(ok(undefined)),
    getAccount: vi.fn().mockResolvedValue(ok(null)),
    createAccount: vi.fn().mockImplementation((a) => Promise.resolve(ok(a))),
    updateAccount: vi.fn().mockResolvedValue(ok({} as never)),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok({} as never)),
    saveAlias: vi.fn().mockResolvedValue(ok({} as never)),
    ensureAlias: vi.fn().mockResolvedValue(ok({} as never)),
    upsertAlias: vi.fn().mockResolvedValue(ok({} as never)),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    getAccountFilteringConfig: vi.fn().mockResolvedValue(ok(null)),
    listForwardingTargets: vi.fn().mockResolvedValue(ok([])),
    getForwardingTarget: vi.fn().mockResolvedValue(ok(null)),
    saveForwardingTarget: vi.fn().mockResolvedValue(ok(undefined)),
    deleteForwardingTarget: vi.fn().mockResolvedValue(ok(undefined)),
    updateDomainHealth: vi.fn().mockResolvedValue(ok(undefined)),
    renameAlias: vi.fn().mockResolvedValue(ok({} as never)),
    saveSender: vi.fn().mockResolvedValue(ok(undefined)),
    removeSender: vi.fn().mockResolvedValue(ok(undefined)),
    listSenders: vi.fn().mockResolvedValue(ok([])),
    createTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    getTemplate: vi.fn().mockResolvedValue(ok(null)),
    updateTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    deleteTemplate: vi.fn().mockResolvedValue(ok(undefined)),
    listTemplates: vi.fn().mockResolvedValue(ok([])),
    getStats: vi.fn().mockResolvedValue(ok([])),
    incrementStatMetric: vi.fn().mockResolvedValue(ok(undefined)),
    writeSnapshot: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

function makeAuditDb() {
  return {
    listAuditEvents: vi.fn().mockResolvedValue(ok({ items: [] })),
    saveAuditEvent: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

function makeAuth(): AuthService {
  return { verify: vi.fn().mockResolvedValue(ok({ userId: "user-test-001" })) };
}

function makeAccess(): AccessService {
  return {
    listUsers: vi.fn().mockResolvedValue(ok([])),
    listAccountsForUser: vi.fn().mockResolvedValue(ok([])),
    addUser: vi.fn().mockResolvedValue(ok(undefined)),
    updateUserRole: vi.fn().mockResolvedValue(ok(undefined)),
    removeUser: vi.fn().mockResolvedValue(ok(undefined)),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "inv-test" })),
    getUserProfile: vi.fn().mockReturnValue(Promise.resolve(ok({}))),
    
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
// Tests — unblock-signal handler uses updateThread for existing threads
// ---------------------------------------------------------------------------

describe("POST /signals/:id/quarantineResponse — updateThread usage", () => {
  let threadDb: ReturnType<typeof makeThreadDb>;
  let accountDb: ReturnType<typeof makeAccountDb>;
  let auditDb: ReturnType<typeof makeAuditDb>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    threadDb = makeThreadDb();
    accountDb = makeAccountDb();
    auditDb = makeAuditDb();
    const forwardingService: IForwardingService = { sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)), forward: vi.fn().mockResolvedValue(ok(undefined)) };
    const draftSendDispatcher = { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as DraftSendDispatcher;
    const astValidator = {
      invoke: vi.fn().mockResolvedValue({ success: true, purpose: "rule_condition", result: true }),
      validateAst: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast", result: { valid: true } }),
      validateAstBatch: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast_batch", results: [] }),
    } as unknown as UserCodeExecutorClient;
    app = createApp(makeAppDeps({ threadDb: threadDb as unknown as ThreadDatabase, accountDb: accountDb as unknown as AccountDatabase, auditDb: auditDb as unknown as AuditDatabase, auth: makeAuth(), access: makeAccess(), logger: createMockLogger(), forwardingService, jobDispatcher: { dispatchReindex: vi.fn(), dispatchSegment: vi.fn() } as never, draftSendDispatcher, accountCreationStarter: { start: vi.fn() }, appBaseUrl: "http://localhost", contentCdnBaseUrl: "https://cdn.test", astValidator, billingHandler: new BillingHandler(), emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, domainIdentityService: { register: vi.fn().mockResolvedValue(ok(undefined)), deregister: vi.fn().mockResolvedValue(ok(undefined)) }, rsvpComposer: vi.fn().mockResolvedValue(ok(undefined)) as unknown as typeof sendRsvp, postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: "platform.email.rhosys.cloud" } as unknown as PostApprovalCalendarHandlerDeps, schedulerClient: { scheduleMessage: vi.fn().mockResolvedValue(ok(undefined)), deleteSchedule: vi.fn().mockResolvedValue(ok(undefined)) } as never }));
  });

  it("matched thread → calls updateThread with (accountId, threadId, 'active', signal.receivedAt, {})", async () => {
    const existingThread = makeThread({ id: "arc-existing", lastSignalAt: "2024-01-10T00:00:00Z" });
    // Use "auth" workflow so deriveGroupingKey returns a non-null key
    const signal = makeSignal({
      data: {
        receivedAt: "2024-01-20T12:00:00Z",
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", service: "example.com" },
      },
    });

    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(signal));
    vi.mocked(threadDb.findThreadByGroupingKey).mockResolvedValueOnce(ok(existingThread));
    vi.mocked(threadDb.updateThread).mockResolvedValueOnce(ok({ ...existingThread, lastSignalAt: signal.data.receivedAt }));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
    expect(res.status).toBe(200);

    expect(threadDb.updateThread).toHaveBeenCalledOnce();
    expect(threadDb.updateThread).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "arc-existing", "active", "2024-01-20T12:00:00Z", { retentionDuration: "P3M" });
    expect(threadDb.createThread).not.toHaveBeenCalled();
  });

  it("no matched thread → calls createThread (PutItem), not updateThread", async () => {
    // Use "auth" workflow so deriveGroupingKey returns a non-null key and findThreadByGroupingKey is called
    const signal = makeSignal({
      data: {
        receivedAt: "2024-01-20T12:00:00Z",
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "otp", service: "example.com" },
      },
    });

    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(signal));
    vi.mocked(threadDb.findThreadByGroupingKey).mockResolvedValueOnce(ok(null));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
    expect(res.status).toBe(200);

    expect(threadDb.createThread).toHaveBeenCalledOnce();
    expect(threadDb.updateThread).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Quarantine response records the user's sender decision unconditionally and
// never touches aliases — the alias is guaranteed to exist as an ingest
// invariant, and reaching this handler means the signal was quarantined, so no
// rule-evaluation (matchedRules / SR-00) is consulted.
// ---------------------------------------------------------------------------
describe("POST /signals/:id/quarantineResponse — sender disposition", () => {
  let threadDb: ReturnType<typeof makeThreadDb>;
  let accountDb: ReturnType<typeof makeAccountDb>;
  let auditDb: ReturnType<typeof makeAuditDb>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    threadDb = makeThreadDb();
    accountDb = makeAccountDb();
    auditDb = makeAuditDb();
    const forwardingService: IForwardingService = { sendVerification: vi.fn().mockResolvedValue(ok(undefined)), verifyWebhook: vi.fn().mockResolvedValue(ok(undefined)), forward: vi.fn().mockResolvedValue(ok(undefined)) };
    const draftSendDispatcher = { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as DraftSendDispatcher;
    const astValidator = {
      invoke: vi.fn().mockResolvedValue({ success: true, purpose: "rule_condition", result: true }),
      validateAst: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast", result: { valid: true } }),
      validateAstBatch: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast_batch", results: [] }),
    } as unknown as UserCodeExecutorClient;
    app = createApp(makeAppDeps({ threadDb: threadDb as unknown as ThreadDatabase, accountDb: accountDb as unknown as AccountDatabase, auditDb: auditDb as unknown as AuditDatabase, auth: makeAuth(), access: makeAccess(), logger: createMockLogger(), forwardingService, jobDispatcher: { dispatchReindex: vi.fn(), dispatchSegment: vi.fn() } as never, draftSendDispatcher, accountCreationStarter: { start: vi.fn() }, appBaseUrl: "http://localhost", contentCdnBaseUrl: "https://cdn.test", astValidator, billingHandler: new BillingHandler(), emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-cal-001" })), sendRaw: vi.fn() } as unknown as EmailService, domainIdentityService: { register: vi.fn().mockResolvedValue(ok(undefined)), deregister: vi.fn().mockResolvedValue(ok(undefined)) }, rsvpComposer: vi.fn().mockResolvedValue(ok(undefined)) as unknown as typeof sendRsvp, schedulerClient: { scheduleMessage: vi.fn().mockResolvedValue(ok(undefined)), deleteSchedule: vi.fn().mockResolvedValue(ok(undefined)) } as never }));
  });

  const sr00Signal = () => makeSignal({
    data: {
      recipientAddress: "user@example.com",
      from: { address: "sender@newsletter.example.org", name: "Sender" },
      // Synthetic unknown-sender rule the processor attaches; carries a statusChange.
      matchedRules: [{ ruleId: "SR-00", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible", text: "Sender newsletter.example.org is not in approved senders" }],
    },
  });

  it("approve → records sender as allowed and never touches the alias", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(sr00Signal()));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
    expect(res.status).toBe(200);

    expect(accountDb.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "user@example.com", "example.org", "allow");
    expect(accountDb.ensureAlias).not.toHaveBeenCalled();
  });

  it("block → records the block disposition and never touches the alias", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(sr00Signal()));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "block_hidden" } });
    expect(res.status).toBe(200);

    expect(accountDb.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "user@example.com", "example.org", "block_hidden");
    expect(accountDb.ensureAlias).not.toHaveBeenCalled();
  });

  it("approve → records the sender allow unconditionally, even for a content-rule quarantine", async () => {
    // Quarantined by a content rule. The user explicitly approved this sender,
    // so the sender is allowed regardless of why it was quarantined — no rule inspection.
    const signal = makeSignal({
      data: {
        recipientAddress: "user@example.com",
        from: { address: "sender@spammy.com", name: "Sender" },
        matchedRules: [{ ruleId: "SR-05", actions: [{ type: "quarantine_hidden" }], labelsAdded: [], statusChange: "quarantine_hidden" }],
      },
    });
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(signal));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
    expect(res.status).toBe(200);

    expect(accountDb.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "user@example.com", "spammy.com", "allow");
    expect(accountDb.ensureAlias).not.toHaveBeenCalled();
  });

  it("approve → reuses the processor-matched thread (matchedThreadId) instead of creating a duplicate", async () => {
    // conversation workflow → deriveGroupingKey returns null, so without matchedThreadId the
    // handler would always createThread. The processor recorded the matched thread, so reuse it.
    const existingThread = makeThread({ id: "thr-existing" });
    const signal = makeSignal({
      data: {
        workflow: "conversation",
        workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: true },
        matchedThreadId: "thr-existing",
        matchedRules: [{ ruleId: "SR-00", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible" }],
      },
    });
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(signal));
    vi.mocked(threadDb.getThread).mockResolvedValueOnce(ok(existingThread));
    vi.mocked(threadDb.updateThread).mockResolvedValueOnce(ok(existingThread));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
    expect(res.status).toBe(200);

    expect(threadDb.getThread).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "thr-existing");
    expect(threadDb.updateThread).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "thr-existing", "active", signal.data.receivedAt, { retentionDuration: "P3M" });
    expect(threadDb.createThread).not.toHaveBeenCalled();
    expect(threadDb.findThreadByGroupingKey).not.toHaveBeenCalled();
  });
});
