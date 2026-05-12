// Property 6: API route error mapping consistency
// **Validates: Requirements 4.1, 4.2, 4.3**
//
// For any store method returning `err({ kind: "db_error" })`, the route handler
// responds with HTTP 500. For any store method returning `ok(null)` on a read,
// the route handler responds with HTTP 404. For any store method returning
// `ok(value)`, the route handler responds with HTTP 200.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { ok, err, okAsync } from "neverthrow";
import { propertyRunner } from "../testing/property-runner.js";
import { createApp } from "./app.js";
import type { ApiDatabase, AuthService, AuthContext, AccessService, VerificationMailer } from "./app.js";
import type { Arc } from "../types/index.js";
import type { DbError } from "../errors.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-prop-001";
const TEST_USER_ID = "user-prop-001";

const validAuth: AuthContext = { accountId: TEST_ACCOUNT_ID, userId: TEST_USER_ID };

function makeAuth(): AuthService {
  return { verify: vi.fn().mockResolvedValue(validAuth) };
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

function makeBaseStore(): ApiDatabase {
  return {
    listArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getArc: vi.fn().mockResolvedValue(ok(null)),
    updateArc: vi.fn().mockResolvedValue(ok(makeArc())),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreArcSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    blockSignal: vi.fn().mockResolvedValue(ok({})),
    saveArc: vi.fn().mockResolvedValue(ok(undefined)),
    findArcByGroupingKey: vi.fn().mockResolvedValue(ok(null)),
    getSignal: vi.fn().mockResolvedValue(ok(null)),
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

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

type Scenario = { type: "db_error" } | { type: "null_read" } | { type: "success" };

const arbScenario: fc.Arbitrary<Scenario> = fc.oneof(
  fc.constant({ type: "db_error" as const }),
  fc.constant({ type: "null_read" as const }),
  fc.constant({ type: "success" as const }),
);

// ---------------------------------------------------------------------------
// Property 6: API route error mapping consistency
// ---------------------------------------------------------------------------

describe("Property 6: API route error mapping consistency", () => {
  it("GET /accounts/:accountId/arcs/:id maps store results to correct HTTP status", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const store = makeBaseStore();

        switch (scenario.type) {
          case "db_error":
            vi.mocked(store.getArc).mockResolvedValue(
              err({ kind: "db_error", cause: new Error("connection timeout") } satisfies DbError),
            );
            break;
          case "null_read":
            vi.mocked(store.getArc).mockResolvedValue(ok(null));
            break;
          case "success":
            vi.mocked(store.getArc).mockResolvedValue(ok(makeArc()));
            break;
        }

        const app = createApp({
          store,
          auth: makeAuth(),
          access: makeAccess(),
          verificationMailer: { sendForwardVerification: vi.fn().mockReturnValue(okAsync(undefined)) },
        });

        const res = await app.fetch(
          new Request(`http://localhost/api/accounts/${TEST_ACCOUNT_ID}/arcs/arc-001`, {
            headers: { Authorization: "Bearer valid-token" },
          }),
        );

        switch (scenario.type) {
          case "db_error":
            expect(res.status).toBe(500);
            break;
          case "null_read":
            expect(res.status).toBe(404);
            break;
          case "success":
            expect(res.status).toBe(200);
            break;
        }
      }),
    );
  });

  it("GET /accounts/:accountId/signals/:id maps store results to correct HTTP status", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const store = makeBaseStore();

        switch (scenario.type) {
          case "db_error":
            vi.mocked(store.getSignal).mockResolvedValue(
              err({ kind: "db_error", cause: new Error("timeout") } satisfies DbError),
            );
            break;
          case "null_read":
            vi.mocked(store.getSignal).mockResolvedValue(ok(null));
            break;
          case "success":
            vi.mocked(store.getSignal).mockResolvedValue(ok({
              id: "SES#msg-001",
              arcId: "arc-001",
              accountId: TEST_ACCOUNT_ID,
              source: "email",
              receivedAt: "2024-01-15T10:00:00Z",
              from: { address: "sender@example.com", name: "Sender" },
              to: [{ address: "user@example.com" }],
              cc: [],
              subject: "Test",
              attachments: [],
              headers: {},
              recipientAddress: "user@example.com",
              workflow: "conversation",
              workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
              spamScore: 0.02,
              summary: "A test signal.",
              classificationModelId: "model-1",
              s3Key: "emails/msg-001",
              status: "active",
              createdAt: "2024-01-15T10:00:00Z",
            } as any));
            break;
        }

        const app = createApp({
          store,
          auth: makeAuth(),
          access: makeAccess(),
          verificationMailer: { sendForwardVerification: vi.fn().mockReturnValue(okAsync(undefined)) },
        });

        const res = await app.fetch(
          new Request(`http://localhost/api/accounts/${TEST_ACCOUNT_ID}/signals/SES%23msg-001`, {
            headers: { Authorization: "Bearer valid-token" },
          }),
        );

        switch (scenario.type) {
          case "db_error":
            expect(res.status).toBe(500);
            break;
          case "null_read":
            expect(res.status).toBe(404);
            break;
          case "success":
            expect(res.status).toBe(200);
            break;
        }
      }),
    );
  });

  it("GET /accounts/:accountId/arcs (list) maps db_error to 500 and success to 200", async () => {
    const arbListScenario = fc.oneof(
      fc.constant({ type: "db_error" as const }),
      fc.constant({ type: "success" as const }),
    );

    await propertyRunner.assert(
      fc.asyncProperty(arbListScenario, async (scenario) => {
        const store = makeBaseStore();

        switch (scenario.type) {
          case "db_error":
            vi.mocked(store.listArcs).mockResolvedValue(
              err({ kind: "db_error", cause: new Error("connection reset") } satisfies DbError),
            );
            break;
          case "success":
            vi.mocked(store.listArcs).mockResolvedValue(ok({ items: [makeArc()] }));
            break;
        }

        const app = createApp({
          store,
          auth: makeAuth(),
          access: makeAccess(),
          verificationMailer: { sendForwardVerification: vi.fn().mockReturnValue(okAsync(undefined)) },
        });

        const res = await app.fetch(
          new Request(`http://localhost/api/accounts/${TEST_ACCOUNT_ID}/arcs`, {
            headers: { Authorization: "Bearer valid-token" },
          }),
        );

        switch (scenario.type) {
          case "db_error":
            expect(res.status).toBe(500);
            break;
          case "success":
            expect(res.status).toBe(200);
            break;
        }
      }),
    );
  });
});
