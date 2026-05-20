import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Arc, Signal } from "../../src/types/index.js";
import { createApp } from "../../src/api/app.js";
import type { ApiDatabase, AuthService, AccessService, VerificationMailer } from "../../src/api/app.js";
import { ok } from "neverthrow";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { DraftSendDispatcher } from "../../src/processor/draft-send-dispatcher.js";
import type { UserCodeExecutorClient } from "../../src/processor/user-code-client.js";

vi.mock("../../src/dns/mx-validator.js", () => ({
  validateRecipientMx: vi.fn().mockResolvedValue({ valid: true, invalidDomains: [] }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-test-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

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
    signalLookupId: "SES#msg-001",
    arcId: "arc-001",
    accountId: TEST_ACCOUNT_ID,
    source: "email" as const,
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
    spamScore: 0.02,
    summary: "A test signal.",
    classificationModelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    s3Key: "emails/msg-001",
    status: "quarantine_visible",
    createdAt: "2024-01-20T12:00:00Z",
    ...overrides,
  };
}

function makeStore(): ApiDatabase {
  return {
    listArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getArc: vi.fn().mockResolvedValue(ok(null)),
    updateArc: vi.fn().mockResolvedValue(ok(makeArc())),
    updateArcDirect: vi.fn().mockResolvedValue(ok(makeArc())),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreArcSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    updateSignalStatus: vi.fn().mockImplementation((_, id, status) => Promise.resolve(ok({ id, status }))),
    findArcByGroupingKey: vi.fn().mockResolvedValue(ok(null)),
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    createSignal: vi.fn().mockImplementation((signal) => Promise.resolve(ok(signal))),
    updateSignal: vi.fn().mockResolvedValue(ok(makeSignal())),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(makeSignal())),
    deleteSignal: vi.fn().mockResolvedValue(ok(undefined)),
    listViews: vi.fn().mockResolvedValue(ok([])),
    getView: vi.fn().mockResolvedValue(ok(null)),
    createView: vi.fn().mockResolvedValue(ok(makeArc())),
    updateView: vi.fn().mockResolvedValue(ok(makeArc())),
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
    searchArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getAccount: vi.fn().mockResolvedValue(ok(null)),
    createAccount: vi.fn().mockImplementation((a) => Promise.resolve(ok(a))),
    updateAccount: vi.fn().mockResolvedValue(ok({} as never)),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok({} as never)),
    upsertAlias: vi.fn().mockResolvedValue(ok({} as never)),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    unblockSignal: vi.fn().mockResolvedValue(ok(undefined)),
    createArc: vi.fn().mockResolvedValue(ok(undefined)),
    listVerifiedForwardingAddresses: vi.fn().mockResolvedValue(ok([])),
    getVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(null)),
    saveVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
    deleteVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
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
    listAuditEvents: vi.fn().mockResolvedValue(ok({ items: [] })),
    saveAuditEvent: vi.fn().mockResolvedValue(ok(undefined)),
    getStats: vi.fn().mockResolvedValue(ok(null)),
  } as unknown as ApiDatabase;
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
// Tests — unblock-signal handler uses updateArcDirect for existing arcs
// ---------------------------------------------------------------------------

describe("POST /signals/:id/quarantineResponse — updateArcDirect usage", () => {
  let store: ReturnType<typeof makeStore>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeStore();
    const verificationMailer: VerificationMailer = { sendForwardVerification: vi.fn().mockResolvedValue(ok(undefined)) };
    const draftSendDispatcher = { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as unknown as DraftSendDispatcher;
    const astValidator = {
      invoke: vi.fn().mockResolvedValue({ success: true, purpose: "rule_condition", result: true }),
      validateAst: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast", result: { valid: true } }),
      validateAstBatch: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast_batch", results: [] }),
    } as unknown as UserCodeExecutorClient;
    app = createApp({ store: store as unknown as ApiDatabase, auth: makeAuth(), access: makeAccess(), logger: createMockLogger(), verificationMailer, draftSendDispatcher, astValidator });
  });

  it("matched arc → calls updateArcDirect with (accountId, arcId, 'active', signal.receivedAt, {})", async () => {
    const existingArc = makeArc({ id: "arc-existing", lastSignalAt: "2024-01-10T00:00:00Z" });
    // Use "auth" workflow so deriveGroupingKey returns a non-null key
    const signal = makeSignal({
      receivedAt: "2024-01-20T12:00:00Z",
      workflow: "auth",
      workflowData: { workflow: "auth", authType: "otp", service: "example.com" },
    });

    vi.mocked(store.getSignalById).mockResolvedValueOnce(ok(signal));
    vi.mocked(store.findArcByGroupingKey).mockResolvedValueOnce(ok(existingArc));
    vi.mocked(store.updateArcDirect).mockResolvedValueOnce(ok({ ...existingArc, lastSignalAt: signal.receivedAt }));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
    expect(res.status).toBe(200);

    expect(store.updateArcDirect).toHaveBeenCalledOnce();
    expect(store.updateArcDirect).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "arc-existing", "active", "2024-01-20T12:00:00Z", {});
    expect(store.createArc).not.toHaveBeenCalled();
  });

  it("no matched arc → calls createArc (PutItem), not updateArcDirect", async () => {
    // Use "auth" workflow so deriveGroupingKey returns a non-null key and findArcByGroupingKey is called
    const signal = makeSignal({
      receivedAt: "2024-01-20T12:00:00Z",
      workflow: "auth",
      workflowData: { workflow: "auth", authType: "otp", service: "example.com" },
    });

    vi.mocked(store.getSignalById).mockResolvedValueOnce(ok(signal));
    vi.mocked(store.findArcByGroupingKey).mockResolvedValueOnce(ok(null));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-001/quarantineResponse`, { body: { status: "active" } });
    expect(res.status).toBe(200);

    expect(store.createArc).toHaveBeenCalledOnce();
    expect(store.updateArcDirect).not.toHaveBeenCalled();
  });
});
