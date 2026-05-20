import { describe, it, expect, vi } from "vitest";
import { ok, err } from "neverthrow";
import { createApp } from "../../src/api/app.js";
import type { ApiDatabase, AuthService, AccessService } from "../../src/api/app.js";
import type { Arc } from "../../src/types/index.js";
import type { DbError } from "../../src/errors.js";
import { createMockLogger } from "../helpers/mock-logger.js";

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
  };
}

function makeArc(overrides: Partial<Arc> = {}): Arc {
  return {
    id: "arc-001", accountId: TEST_ACCOUNT_ID, workflow: "conversation", labels: [], status: "active",
    summary: "A test arc.", lastSignalAt: "2024-01-15T10:00:00Z",
    createdAt: "2024-01-15T10:00:00Z", updatedAt: "2024-01-15T10:00:00Z", ...overrides,
  };
}

function makeBaseStore(): ApiDatabase {
  return {
    listArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getArc: vi.fn().mockResolvedValue(ok(null)),
    updateArc: vi.fn().mockResolvedValue(ok(makeArc())),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreArcSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    blockSignal: vi.fn().mockResolvedValue(ok({})),
    findArcByGroupingKey: vi.fn().mockResolvedValue(ok(null)),
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    updateSignal: vi.fn().mockResolvedValue(ok({})),
    deleteSignal: vi.fn().mockResolvedValue(ok(undefined)),
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
    searchArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getAccount: vi.fn().mockResolvedValue(ok(null)),
    updateAccount: vi.fn().mockResolvedValue(ok({})),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok({})),
    upsertAlias: vi.fn().mockResolvedValue(ok({})),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    unblockSignal: vi.fn().mockResolvedValue(ok(undefined)),
    createArc: vi.fn().mockResolvedValue(ok(undefined)),
    listVerifiedForwardingAddresses: vi.fn().mockResolvedValue(ok([])),
    getVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(null)),
    saveVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
    deleteVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
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
    listAuditEvents: vi.fn().mockResolvedValue(ok({ items: [] })),
  } as unknown as ApiDatabase;
}

function makeApp(store: ApiDatabase) {
  return createApp({
    store,
    auth: makeAuth(),
    access: makeAccess(),
    logger: createMockLogger(),
    verificationMailer: { sendForwardVerification: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
  });
}

describe("API route error mapping consistency", () => {
  const scenarios = [
    { label: "db_error → 500", type: "db_error" as const, expectedStatus: 500 },
    { label: "null_read → 404", type: "null_read" as const, expectedStatus: 404 },
    { label: "success → 200", type: "success" as const, expectedStatus: 200 },
  ];

  describe("GET /accounts/:accountId/arcs/:id", () => {
    it.each(scenarios)("$label", async ({ type, expectedStatus }) => {
      const store = makeBaseStore();
      switch (type) {
        case "db_error":
          vi.mocked(store.getArc).mockResolvedValue(err({ kind: "db_error", cause: new Error("timeout") } satisfies DbError));
          break;
        case "null_read":
          vi.mocked(store.getArc).mockResolvedValue(ok(null));
          break;
        case "success":
          vi.mocked(store.getArc).mockResolvedValue(ok(makeArc()));
          break;
      }

      const app = makeApp(store);
      const res = await app.fetch(new Request(`http://localhost/api/accounts/${TEST_ACCOUNT_ID}/arcs/arc-001`, {
        headers: { Authorization: "Bearer valid-token" },
      }));
      expect(res.status).toBe(expectedStatus);
    });
  });

  describe("GET /accounts/:accountId/signals/:id", () => {
    it.each(scenarios)("$label", async ({ type, expectedStatus }) => {
      const store = makeBaseStore();
      switch (type) {
        case "db_error":
          vi.mocked(store.getSignalById).mockResolvedValue(err({ kind: "db_error", cause: new Error("timeout") } satisfies DbError));
          break;
        case "null_read":
          vi.mocked(store.getSignalById).mockResolvedValue(ok(null));
          break;
        case "success":
          vi.mocked(store.getSignalById).mockResolvedValue(ok({
            id: "SES#msg-001", arcId: "arc-001", accountId: TEST_ACCOUNT_ID, source: "email",
            receivedAt: "2024-01-15T10:00:00Z", from: { address: "sender@example.com", name: "Sender" },
            to: [{ address: "user@example.com" }], cc: [], subject: "Test", attachments: [], headers: {},
            recipientAddress: "user@example.com", workflow: "conversation",
            workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
            spamScore: 0.02, summary: "A test signal.", classificationModelId: "model-1",
            s3Key: "emails/msg-001", status: "active", createdAt: "2024-01-15T10:00:00Z",
          } as any));
          break;
      }

      const app = makeApp(store);
      const res = await app.fetch(new Request(`http://localhost/api/accounts/${TEST_ACCOUNT_ID}/signals/SES%23msg-001`, {
        headers: { Authorization: "Bearer valid-token" },
      }));
      expect(res.status).toBe(expectedStatus);
    });
  });

  describe("GET /accounts/:accountId/arcs (list)", () => {
    it.each([
      { label: "db_error → 500", type: "db_error" as const, expectedStatus: 500 },
      { label: "success → 200", type: "success" as const, expectedStatus: 200 },
    ])("$label", async ({ type, expectedStatus }) => {
      const store = makeBaseStore();
      switch (type) {
        case "db_error":
          vi.mocked(store.listArcs).mockResolvedValue(err({ kind: "db_error", cause: new Error("reset") } satisfies DbError));
          break;
        case "success":
          vi.mocked(store.listArcs).mockResolvedValue(ok({ items: [makeArc()] }));
          break;
      }

      const app = makeApp(store);
      const res = await app.fetch(new Request(`http://localhost/api/accounts/${TEST_ACCOUNT_ID}/arcs`, {
        headers: { Authorization: "Bearer valid-token" },
      }));
      expect(res.status).toBe(expectedStatus);
    });
  });
});
