import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Arc, Signal } from "../../src/types/index.js";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import type { AuthService, AccessService } from "../../src/api/app.js";
import type { ArcDatabase } from "../../src/database/arc-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { AuditDatabase } from "../../src/database/audit-database.js";
import type { SchedulerClient } from "../../src/scheduler/scheduler-client.js";
import { ok, err } from "neverthrow";
import { dbError } from "../../src/errors.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { sendRsvp } from "../../src/processor/calendar/rsvp-composer.js";
import type { PostApprovalCalendarHandlerDeps } from "../../src/processor/calendar/post-approval-handler.js";

vi.mock("../../src/dns/mx-validator.js", () => ({
  validateRecipientMx: vi.fn().mockResolvedValue({ isOk: () => true, isErr: () => false, _unsafeUnwrap: () => undefined }),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-followup-001";
const ARC_ID = "arc-followup-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeAuth(): AuthService {
  return { verify: vi.fn().mockResolvedValue(ok({ userId: "user-001" })) };
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

function makeArc(overrides: Partial<Arc> = {}): Arc {
  return {
    id: ARC_ID,
    accountId: TEST_ACCOUNT_ID,
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "Test arc",
    lastSignalAt: "2024-06-01T12:00:00Z",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(), // 1 day ago — retention window is far in future
    updatedAt: "2024-06-01T12:00:00Z",
    retentionDuration: "P1Y",
    senderAddress: "sender@example.com",
    recipientAddress: "user@example.com",
    subject: "Test email",
    ...overrides,
  };
}

function makeSignal(): Signal {
  return {
    id: "sgn-001",
    signalLookupId: "sgn-001",
    arcId: ARC_ID,
    accountId: TEST_ACCOUNT_ID,
    source: "email",
    type: "email",
    status: "active",
    labels: [],
    createdAt: "2024-06-01T12:00:00Z",
    data: {
      receivedAt: "2024-06-01T12:00:00Z",
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email",
      attachments: [],
      headers: {},
      recipientAddress: "user@example.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
      spamScore: 0,
      summary: "Test",
      s3Key: "emails/test.eml",
    },
  } as Signal;
}

function makeArcDb() {
  return {
    listArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    getArc: vi.fn().mockResolvedValue(ok(null)),
    updateArc: vi.fn().mockImplementation((_accountId, _arcId, status, _lastSignalAt, _fields) =>
      Promise.resolve(ok(makeArc({ status }))),
    ),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [makeSignal()] })),
    listPreArcSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    updateSignalStatus: vi.fn().mockResolvedValue(ok({ id: "sgn-001", status: "active" })),
    fastFindArcByAlternativeLookupKey: vi.fn().mockResolvedValue(ok(null)),
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    createSignal: vi.fn().mockResolvedValue(ok(makeSignal())),
    updateSignal: vi.fn().mockResolvedValue(ok(makeSignal())),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(makeSignal())),
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
    createView: vi.fn().mockResolvedValue(ok(undefined)),
    updateView: vi.fn().mockResolvedValue(ok(undefined)),
    deleteView: vi.fn().mockResolvedValue(ok(undefined)),
    listLabels: vi.fn().mockResolvedValue(ok([])),
    createLabel: vi.fn().mockResolvedValue(ok(undefined)),
    updateLabel: vi.fn().mockResolvedValue(ok(undefined)),
    deleteLabel: vi.fn().mockResolvedValue(ok(undefined)),
    listRules: vi.fn().mockResolvedValue(ok([])),
    createRule: vi.fn().mockResolvedValue(ok(undefined)),
    updateRule: vi.fn().mockResolvedValue(ok(undefined)),
    deleteRule: vi.fn().mockResolvedValue(ok(undefined)),
    listDomains: vi.fn().mockResolvedValue(ok([])),
    getDomain: vi.fn().mockResolvedValue(ok(null)),
    createDomain: vi.fn().mockResolvedValue(ok(undefined)),
    deleteDomain: vi.fn().mockResolvedValue(ok(undefined)),
    getAccount: vi.fn().mockResolvedValue(ok(null)),
    createAccount: vi.fn().mockResolvedValue(ok(undefined)),
    updateAccount: vi.fn().mockResolvedValue(ok(undefined)),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok(undefined)),
    upsertAlias: vi.fn().mockResolvedValue(ok(undefined)),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    listVerifiedForwardingAddresses: vi.fn().mockResolvedValue(ok([])),
    getVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(null)),
    saveVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
    deleteVerifiedForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
    updateDomainHealth: vi.fn().mockResolvedValue(ok(undefined)),
    renameAlias: vi.fn().mockResolvedValue(ok(undefined)),
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

function makeSchedulerClient(): { [K in keyof SchedulerClient]: ReturnType<typeof vi.fn> } {
  return {
    createFollowup: vi.fn().mockResolvedValue(ok(undefined)),
    deleteFollowup: vi.fn().mockResolvedValue(ok(undefined)),
    getSchedule: vi.fn().mockResolvedValue(ok(null)),
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

describe("PATCH /accounts/:accountId/arcs/:id — followupAt handling", () => {
  let arcDb: ReturnType<typeof makeArcDb>;
  let schedulerClient: ReturnType<typeof makeSchedulerClient>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    arcDb = makeArcDb();
    schedulerClient = makeSchedulerClient();
    app = createApp(makeAppDeps({
      arcDb: arcDb as unknown as ArcDatabase,
      accountDb: makeAccountDb() as unknown as AccountDatabase,
      auditDb: makeAuditDb() as unknown as AuditDatabase,
      auth: makeAuth(),
      access: makeAccess(),
      logger: createMockLogger(),
      verificationMailer: { sendForwardVerification: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) },
      jobDispatcher: { dispatchReindex: vi.fn(), dispatchSegment: vi.fn() } as never,
      draftSendDispatcher: { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as never,
      accountCreationStarter: { start: vi.fn() },
      appBaseUrl: "http://localhost",
      contentCdnBaseUrl: "https://cdn.test",
      astValidator: { validateAstBatch: vi.fn().mockResolvedValue({ success: true, purpose: "validate_ast_batch", results: [] }) } as never,
      billingHandler: new BillingHandler(),
      emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "ses-001" })), sendRaw: vi.fn() } as unknown as EmailService,
      domainIdentityService: { register: vi.fn().mockResolvedValue(ok(undefined)), deregister: vi.fn().mockResolvedValue(ok(undefined)) },
      rsvpComposer: vi.fn().mockResolvedValue(ok(undefined)) as unknown as typeof sendRsvp,
      postApprovalCalendarDeps: { accountDb: {} as never, emailService: {} as never, serviceDomain: "test.example.com" } as unknown as PostApprovalCalendarHandlerDeps,
      schedulerClient: schedulerClient as unknown as SchedulerClient,
    }));
  });

  // -------------------------------------------------------------------------
  // followupAt alone (no status change) → schedule created, arc unchanged
  // -------------------------------------------------------------------------

  it("followupAt alone → schedule created, arc status unchanged", async () => {
    const arc = makeArc({ status: "active" });
    arcDb.getArc.mockResolvedValue(ok(arc));

    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const res = await req(app, "PATCH", `${A}/arcs/${ARC_ID}`, { body: { followupAt: futureDate } });

    expect(res.status).toBe(200);
    // Arc status should remain active (updateArc called with original status)
    expect(arcDb.updateArc).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID, ARC_ID, "active", arc.lastSignalAt, { followupAt: futureDate },
    );
    // Schedule should be created
    expect(schedulerClient.createFollowup).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        arcId: ARC_ID,
        fireAt: futureDate,
        suffix: "followup",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // followupAt + status: "archived" → arc archived + schedule created
  // -------------------------------------------------------------------------

  it("followupAt + status: archived → arc archived and schedule created", async () => {
    const arc = makeArc({ status: "active" });
    arcDb.getArc.mockResolvedValue(ok(arc));

    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const res = await req(app, "PATCH", `${A}/arcs/${ARC_ID}`, {
      body: { status: "archived", followupAt: futureDate },
    });

    expect(res.status).toBe(200);
    expect(arcDb.updateArc).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID, ARC_ID, "archived", arc.lastSignalAt, { followupAt: futureDate },
    );
    expect(schedulerClient.createFollowup).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        arcId: ARC_ID,
        fireAt: futureDate,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // followupAt in the past → 400
  // -------------------------------------------------------------------------

  it("followupAt in the past → 400", async () => {
    const arc = makeArc({ status: "active" });
    arcDb.getArc.mockResolvedValue(ok(arc));

    const pastDate = new Date(Date.now() - 3600_000).toISOString();
    const res = await req(app, "PATCH", `${A}/arcs/${ARC_ID}`, { body: { followupAt: pastDate } });

    expect(res.status).toBe(400);
    expect(schedulerClient.createFollowup).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // followupAt beyond retention → 400
  // -------------------------------------------------------------------------

  it("followupAt beyond retention expiration → 400", async () => {
    // Arc created 2024-01-01 with P1Y retention → expires 2024-12-31T00:00:00Z (365 days)
    // Pin "now" to 2024-06-15 so it's between createdAt and expiry
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));

    const arc = makeArc({ createdAt: "2024-01-01T00:00:00Z", retentionDuration: "P1Y" });
    arcDb.getArc.mockResolvedValue(ok(arc));

    // Request a followup beyond retention (2025-06-01 > 2024-12-31)
    const beyondRetention = "2025-06-01T12:00:00Z";
    const res = await req(app, "PATCH", `${A}/arcs/${ARC_ID}`, { body: { followupAt: beyondRetention } });

    expect(res.status).toBe(400);
    expect(schedulerClient.createFollowup).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Schedule creation failure → 500, arc status unchanged (rollback)
  // -------------------------------------------------------------------------

  it("schedule creation failure with status change → 500 and arc rolled back", async () => {
    const arc = makeArc({ status: "active" });
    arcDb.getArc.mockResolvedValue(ok(arc));
    schedulerClient.createFollowup.mockResolvedValue(err(dbError("Scheduler API failure")));

    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const res = await req(app, "PATCH", `${A}/arcs/${ARC_ID}`, {
      body: { status: "archived", followupAt: futureDate },
    });

    expect(res.status).toBe(500);
    // First call: archive the arc; second call: rollback to original status
    expect(arcDb.updateArc).toHaveBeenCalledTimes(2);
    expect(arcDb.updateArc).toHaveBeenLastCalledWith(
      TEST_ACCOUNT_ID, ARC_ID, "active", arc.lastSignalAt, {},
    );
  });

  it("schedule creation failure without status change → 500, no rollback needed", async () => {
    const arc = makeArc({ status: "active" });
    arcDb.getArc.mockResolvedValue(ok(arc));
    schedulerClient.createFollowup.mockResolvedValue(err(dbError("Scheduler throttled")));

    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const res = await req(app, "PATCH", `${A}/arcs/${ARC_ID}`, {
      body: { followupAt: futureDate },
    });

    expect(res.status).toBe(500);
    // Only one updateArc call (the initial no-op status write), no rollback
    expect(arcDb.updateArc).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Property 2: followupAt validation rejects invalid timestamps
  // (Deterministic boundary enumeration)
  // ---------------------------------------------------------------------------

  describe("Property 2: followupAt validation rejects invalid timestamps", () => {
    /**
     * Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7
     *
     * For any arc with createdAt and retentionDuration, and for any candidate
     * followupAt timestamp: the system SHALL accept followupAt if and only if
     * followupAt > now AND followupAt ≤ createdAt + retentionDuration. All other
     * values SHALL be rejected with 400.
     */

    // Arc: created 2024-01-01, retention P1Y → expires 2024-12-31T00:00:00Z (365 days)
    const ARC_CREATED_AT = "2024-01-01T00:00:00Z";
    const RETENTION = "P1Y" as const;
    // P1Y = 365 * 86400 = 31536000 seconds → expiry = 2024-12-31T00:00:00Z
    const RETENTION_SECONDS = 365 * 24 * 60 * 60;
    const EXPIRY_MS = new Date(ARC_CREATED_AT).getTime() + RETENTION_SECONDS * 1000;

    // Use a fixed "now" relative to which we compute boundaries
    // Pin now to 2024-06-15 so it's after createdAt but before expiry
    const NOW = new Date("2024-06-15T12:00:00Z").getTime();

    const boundaries: Array<{ label: string; offsetFromNow: number; expectedStatus: number }> = [
      { label: "1 hour in the past", offsetFromNow: -3600_000, expectedStatus: 400 },
      { label: "1 second in the past", offsetFromNow: -1000, expectedStatus: 400 },
      { label: "exactly now (not future)", offsetFromNow: 0, expectedStatus: 400 },
      { label: "1 second in the future (valid)", offsetFromNow: 1000, expectedStatus: 200 },
      { label: "1 hour in the future (valid)", offsetFromNow: 3600_000, expectedStatus: 200 },
      { label: "1 day in the future (valid)", offsetFromNow: 86_400_000, expectedStatus: 200 },
      // Within retention boundary (expiry - now ≈ 199 days from pinned NOW)
      { label: "at retention boundary (valid)", offsetFromNow: EXPIRY_MS - NOW, expectedStatus: 200 },
      // Beyond retention
      { label: "1 second beyond retention", offsetFromNow: EXPIRY_MS - NOW + 1000, expectedStatus: 400 },
      { label: "1 day beyond retention", offsetFromNow: EXPIRY_MS - NOW + 86_400_000, expectedStatus: 400 },
      { label: "1 year beyond retention", offsetFromNow: EXPIRY_MS - NOW + 365 * 86_400_000, expectedStatus: 400 },
    ];

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    it.each(boundaries)(
      "$label → $expectedStatus",
      async ({ offsetFromNow, expectedStatus }) => {
        const arc = makeArc({ createdAt: ARC_CREATED_AT, retentionDuration: RETENTION });
        arcDb.getArc.mockResolvedValue(ok(arc));

        const followupAt = new Date(NOW + offsetFromNow).toISOString();
        const res = await req(app, "PATCH", `${A}/arcs/${ARC_ID}`, { body: { followupAt } });

        expect(res.status).toBe(expectedStatus);

        if (expectedStatus === 400) {
          expect(schedulerClient.createFollowup).not.toHaveBeenCalled();
        } else {
          expect(schedulerClient.createFollowup).toHaveBeenCalledOnce();
        }

        // Reset mock for next iteration
        schedulerClient.createFollowup.mockClear();
        arcDb.getArc.mockClear();
        arcDb.updateArc.mockClear();
      },
    );

    afterEach(() => {
      vi.useRealTimers();
    });
  });
});
