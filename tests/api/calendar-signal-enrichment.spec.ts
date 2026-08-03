import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Signal } from "../../src/types/index.js";
import type { CalendarEventData, CalendarResponseData } from "../../src/types/calendar.js";
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

vi.mock("../../src/dns/mx-validator.js", () => ({
  validateRecipientMx: vi.fn().mockResolvedValue({ isOk: () => true, isErr: () => false, _unsafeUnwrap: () => undefined }),
}));

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-test-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

function makeAuth(): AuthService {
  return { verify: vi.fn().mockReturnValue(Promise.resolve(ok({ userId: "user-001" }))) };
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
    updateThread: vi.fn().mockResolvedValue(ok(null)),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    listPreArcSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    updateSignalStatus: vi.fn().mockResolvedValue(ok(null)),
    fastFindArcByAlternativeLookupKey: vi.fn().mockResolvedValue(ok(null)),
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    createSignal: vi.fn().mockImplementation((signal: unknown) => Promise.resolve(ok(signal))),
    updateSignal: vi.fn().mockResolvedValue(ok(null)),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(null)),
    deleteSignal: vi.fn().mockResolvedValue(ok(undefined)),
    unblockSignal: vi.fn().mockResolvedValue(ok(undefined)),
    createArc: vi.fn().mockResolvedValue(ok(undefined)),
    searchArcs: vi.fn().mockResolvedValue(ok({ items: [] })),
    saveSignal: vi.fn().mockResolvedValue(ok(undefined)),
    getLatestCalendarResponse: vi.fn().mockResolvedValue(ok(null)),
    getLinkedCalendarSignal: vi.fn().mockResolvedValue(ok(null)),
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
    createRule: vi.fn().mockResolvedValue(ok(null)),
    updateRule: vi.fn().mockResolvedValue(ok(null)),
    deleteRule: vi.fn().mockResolvedValue(ok(undefined)),
    listDomains: vi.fn().mockResolvedValue(ok([])),
    getDomain: vi.fn().mockResolvedValue(ok(null)),
    getDomainByName: vi.fn().mockResolvedValue(ok(null)),
    createDomain: vi.fn().mockResolvedValue(ok(null)),
    deleteDomain: vi.fn().mockResolvedValue(ok(undefined)),
    getAccount: vi.fn().mockResolvedValue(ok(null)),
    updateAccount: vi.fn().mockResolvedValue(ok(null)),
    listAliases: vi.fn().mockResolvedValue(ok([])),
    getAlias: vi.fn().mockResolvedValue(ok(null)),
    createAlias: vi.fn().mockResolvedValue(ok(null)),
    updateAlias: vi.fn().mockResolvedValue(ok(null)),
    deleteAlias: vi.fn().mockResolvedValue(ok(undefined)),
    listSenders: vi.fn().mockResolvedValue(ok([])),
    setSender: vi.fn().mockResolvedValue(ok(undefined)),
    deleteSender: vi.fn().mockResolvedValue(ok(undefined)),
    listForwardingAddresses: vi.fn().mockResolvedValue(ok([])),
    getForwardingAddress: vi.fn().mockResolvedValue(ok(null)),
    getForwardingAddressByToken: vi.fn().mockResolvedValue(ok(null)),
    createForwardingAddress: vi.fn().mockResolvedValue(ok(null)),
    verifyForwardingAddress: vi.fn().mockResolvedValue(ok(null)),
    deleteForwardingAddress: vi.fn().mockResolvedValue(ok(undefined)),
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

function makeCalendarEventSignal(overrides: Partial<Signal<CalendarEventData>> = {}): Signal<CalendarEventData> {
  return {
    id: "sgn-cal-001",
    signalLookupId: "cal-alice@example.com-uid-123",
    threadId: "arc-001",
    accountId: TEST_ACCOUNT_ID,
    source: "signal",
    type: "calendar_event",
    status: "active",
    labels: [],
    createdAt: "2025-03-15T09:00:00Z",
    data: {
      title: "Team Standup",
      startTime: "2025-03-15T10:00:00Z",
      endTime: "2025-03-15T10:30:00Z",
      organizer: "alice@example.com",
      attendees: [{ address: "bob@example.com", partstat: "NEEDS-ACTION" }],
      veventUid: "uid-123",
      originalVeventUid: "uid-123",
      method: "REQUEST",
      sequence: 0,
      linkedSignalId: "sgn-email-001",
    },
    ...overrides,
  };
}

function makeCalendarResponseSignal(overrides: Partial<Signal<CalendarResponseData>> = {}): Signal<CalendarResponseData> {
  return {
    id: "sgn-resp-001",
    signalLookupId: "sgn-resp-001",
    threadId: "arc-001",
    accountId: TEST_ACCOUNT_ID,
    source: "user",
    type: "calendar_response",
    status: "active",
    labels: [],
    createdAt: "2025-03-15T11:00:00Z",
    data: {
      decision: "accepted",
      respondedAt: "2025-03-15T11:00:00Z",
      veventUid: "uid-123",
      linkedSignalId: "sgn-cal-001",
      sendStatus: "sent",
    },
    ...overrides,
  };
}

async function req(app: ReturnType<typeof createApp>, method: string, path: string) {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: "Bearer valid-token" },
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /accounts/:accountId/threads/:threadId/signals — calendar signal enrichment", () => {
  let threadDb: ReturnType<typeof makeThreadDb>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    threadDb = makeThreadDb();
    const accountDb = makeAccountDb();
    const auditDb = makeAuditDb();
    const forwardingService: IForwardingService = { sendVerification: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))), forward: vi.fn().mockReturnValue(Promise.resolve(ok(undefined))) };
    app = createApp(makeAppDeps({
      threadDb: threadDb as unknown as ThreadDatabase,
      accountDb: accountDb as unknown as AccountDatabase,
      auditDb: auditDb as unknown as AuditDatabase,
      auth: makeAuth(),
      access: makeAccess(),
      logger: createMockLogger(),
      forwardingService,
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
  });

  it("includes CalendarData on calendar_event signal responses", async () => {
    const calSignal = makeCalendarEventSignal();
    threadDb.getThread.mockResolvedValueOnce(ok({ id: "arc-001", accountId: TEST_ACCOUNT_ID, workflow: "job", labels: [], status: "active", summary: "Test", lastSignalAt: "2025-03-15T09:00:00Z", createdAt: "2025-03-15T09:00:00Z", updatedAt: "2025-03-15T09:00:00Z" }));
    threadDb.listSignals.mockResolvedValueOnce(ok({ items: [calSignal] }));
    threadDb.getLatestCalendarResponse.mockResolvedValueOnce(ok(null));

    const res = await req(app, "GET", `${A}/threads/arc-001/signals`);
    expect(res.status).toBe(200);
    const body = await res.json() as { signals: Array<{ data: { title: string; organizer: string; linkedSignalId: string } }> };
    expect(body.signals).toHaveLength(1);
    // CalendarData is included in the response (data field with title, organizer, etc.)
    expect(body.signals[0]!.data.title).toBe("Team Standup");
    expect(body.signals[0]!.data.organizer).toBe("alice@example.com");
    expect(body.signals[0]!.data.linkedSignalId).toBe("sgn-email-001");
  });

  it("includes most recent calendar_response decision alongside calendar signal", async () => {
    const calSignal = makeCalendarEventSignal();
    const responseSignal = makeCalendarResponseSignal();
    threadDb.getThread.mockResolvedValueOnce(ok({ id: "arc-001", accountId: TEST_ACCOUNT_ID, workflow: "job", labels: [], status: "active", summary: "Test", lastSignalAt: "2025-03-15T09:00:00Z", createdAt: "2025-03-15T09:00:00Z", updatedAt: "2025-03-15T09:00:00Z" }));
    threadDb.listSignals.mockResolvedValueOnce(ok({ items: [calSignal] }));
    threadDb.getLatestCalendarResponse.mockResolvedValueOnce(ok(responseSignal));

    const res = await req(app, "GET", `${A}/threads/arc-001/signals`);
    expect(res.status).toBe(200);
    const body = await res.json() as { signals: Array<Signal<CalendarEventData> & { latestResponse?: { decision: string; respondedAt: string } }> };
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]!.latestResponse).toEqual({
      decision: "accepted",
      respondedAt: "2025-03-15T11:00:00Z",
    });
  });

  it("does not include latestResponse when no calendar_response exists", async () => {
    const calSignal = makeCalendarEventSignal();
    threadDb.getThread.mockResolvedValueOnce(ok({ id: "arc-001", accountId: TEST_ACCOUNT_ID, workflow: "job", labels: [], status: "active", summary: "Test", lastSignalAt: "2025-03-15T09:00:00Z", createdAt: "2025-03-15T09:00:00Z", updatedAt: "2025-03-15T09:00:00Z" }));
    threadDb.listSignals.mockResolvedValueOnce(ok({ items: [calSignal] }));
    threadDb.getLatestCalendarResponse.mockResolvedValueOnce(ok(null));

    const res = await req(app, "GET", `${A}/threads/arc-001/signals`);
    expect(res.status).toBe(200);
    const body = await res.json() as { signals: Array<Signal<CalendarEventData> & { latestResponse?: unknown }> };
    expect(body.signals[0]!.latestResponse).toBeUndefined();
  });

  it("renders calendar card from calendar signal (source: system), not email signal", async () => {
    const calSignal = makeCalendarEventSignal();
    threadDb.getThread.mockResolvedValueOnce(ok({ id: "arc-001", accountId: TEST_ACCOUNT_ID, workflow: "job", labels: [], status: "active", summary: "Test", lastSignalAt: "2025-03-15T09:00:00Z", createdAt: "2025-03-15T09:00:00Z", updatedAt: "2025-03-15T09:00:00Z" }));
    threadDb.listSignals.mockResolvedValueOnce(ok({ items: [calSignal] }));
    threadDb.getLatestCalendarResponse.mockResolvedValueOnce(ok(null));

    const res = await req(app, "GET", `${A}/threads/arc-001/signals`);
    const body = await res.json() as { signals: Array<{ source: string; type: string; data: { startTime: string; endTime: string } }> };
    // The calendar signal has source: "system" and type: "calendar_event"
    // UI uses this to render the calendar card (not the email signal)
    expect(body.signals[0]!.source).toBe("system");
    expect(body.signals[0]!.type).toBe("calendar_event");
    expect(body.signals[0]!.data.startTime).toBe("2025-03-15T10:00:00Z");
    expect(body.signals[0]!.data.endTime).toBe("2025-03-15T10:30:00Z");
  });

  it("calendar_event type is preserved so UI can identify calendar signals", async () => {
    const cancelSignal = makeCalendarEventSignal({ data: { ...makeCalendarEventSignal().data, method: "CANCEL", status: "CANCELLED" } });
    threadDb.getThread.mockResolvedValueOnce(ok({ id: "arc-001", accountId: TEST_ACCOUNT_ID, workflow: "job", labels: [], status: "active", summary: "Test", lastSignalAt: "2025-03-15T09:00:00Z", createdAt: "2025-03-15T09:00:00Z", updatedAt: "2025-03-15T09:00:00Z" }));
    threadDb.listSignals.mockResolvedValueOnce(ok({ items: [cancelSignal] }));
    threadDb.getLatestCalendarResponse.mockResolvedValueOnce(ok(null));

    const res = await req(app, "GET", `${A}/threads/arc-001/signals`);
    const body = await res.json() as { signals: Array<{ type: string; data: { title: string } }> };
    expect(body.signals[0]!.type).toBe("calendar_event");
    expect(body.signals[0]!.data.title).toBe("Team Standup");
  });

  it("calendar signal appears as distinct card type linked via linkedSignalId", async () => {
    const calSignal = makeCalendarEventSignal();
    threadDb.getThread.mockResolvedValueOnce(ok({ id: "arc-001", accountId: TEST_ACCOUNT_ID, workflow: "job", labels: [], status: "active", summary: "Test", lastSignalAt: "2025-03-15T09:00:00Z", createdAt: "2025-03-15T09:00:00Z", updatedAt: "2025-03-15T09:00:00Z" }));
    threadDb.listSignals.mockResolvedValueOnce(ok({ items: [calSignal] }));
    threadDb.getLatestCalendarResponse.mockResolvedValueOnce(ok(null));

    const res = await req(app, "GET", `${A}/threads/arc-001/signals`);
    const body = await res.json() as { signals: Array<{ type: string; data: { linkedSignalId: string } }> };
    // linkedSignalId links back to the originating email signal
    expect(body.signals[0]!.data.linkedSignalId).toBe("sgn-email-001");
    // type distinguishes it as a calendar card
    expect(body.signals[0]!.type).toBe("calendar_event");
  });
});
