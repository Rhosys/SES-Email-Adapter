// ---------------------------------------------------------------------------
// Unit tests for staleness integration in domain-health-job
// Validates: Requirements 2.1, 2.2, 3.4
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { ok, err, dbError } from "../../src/errors.js";
import type { Arc, Domain, Account } from "../../src/types/index.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { MockLogger } from "../helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockScanAllDomains = vi.fn();
const mockGetAccount = vi.fn();
const mockUpdateDomainHealth = vi.fn();

vi.mock("../../src/database/account-database.js", () => ({
  AccountDatabase: vi.fn().mockImplementation(() => ({
    scanAllDomains: mockScanAllDomains,
    getAccount: mockGetAccount,
    updateDomainHealth: mockUpdateDomainHealth,
  })),
}));

const mockListActiveArcsBefore = vi.fn();

vi.mock("../../src/database/arc-database.js", () => ({
  ArcDatabase: vi.fn().mockImplementation(() => ({
    listActiveArcsBefore: mockListActiveArcsBefore,
  })),
}));

const mockCheckDomain = vi.fn().mockResolvedValue([]);

vi.mock("../../src/dns/dns-checker.js", () => ({
  checkDomain: (...args: unknown[]) => mockCheckDomain(...args),
}));

const mockSesSend = vi.fn().mockResolvedValue({});

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: vi.fn().mockImplementation(() => ({
    send: mockSesSend,
  })),
  SendEmailCommand: vi.fn(),
}));

// Import DomainHealthJob after mocks are set up
let DomainHealthJob: typeof import("../../src/jobs/domain-health-job.js").DomainHealthJob;
beforeAll(async () => {
  const mod = await import("../../src/jobs/domain-health-job.js");
  DomainHealthJob = mod.DomainHealthJob;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArc(overrides: Partial<Arc> = {}): Arc {
  return {
    id: "arc-1",
    accountId: "acct-1",
    workflow: "conversation",
    labels: [],
    status: "active",
    summary: "Test arc",
    lastSignalAt: "2025-04-01T00:00:00.000Z",
    createdAt: "2025-03-01T00:00:00.000Z",
    updatedAt: "2025-04-01T00:00:00.000Z",
    urgency: "normal",
    ...overrides,
  };
}

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    accountId: "acct-1",
    domain: "example.com",
    receivingSetupComplete: true,
    senderSetupComplete: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function setupDefaultMocks() {
  mockGetAccount.mockReturnValue(Promise.resolve(ok({ id: "acct-1", notifications: {} } as Account)));
  mockUpdateDomainHealth.mockReturnValue(Promise.resolve(ok(undefined)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("domain-health-job staleness integration", () => {
  let mockLogger: MockLogger;
  let job: InstanceType<typeof DomainHealthJob>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-05-11T16:00:00.000Z"));
    setupDefaultMocks();
    mockCheckDomain.mockResolvedValue([]);

    mockLogger = createMockLogger();
    const { AccountDatabase } = await import("../../src/database/account-database.js");
    const { ArcDatabase } = await import("../../src/database/arc-database.js");
    job = new DomainHealthJob(new AccountDatabase() as any, new ArcDatabase() as any, mockLogger);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockScanAllDomains.mockReset();
    mockGetAccount.mockReset();
    mockUpdateDomainHealth.mockReset();
    mockListActiveArcsBefore.mockReset();
    mockCheckDomain.mockReset();
    mockCheckDomain.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // Requirement 2.1: TRACK log emitted for accounts with outstanding arcs
  // -------------------------------------------------------------------------

  it("emits TRACK log for accounts with outstanding arcs", async () => {
    const domain = makeDomain({ accountId: "acct-1" });
    mockScanAllDomains.mockReturnValue(Promise.resolve(ok([{ accountId: "acct-1", domains: [domain] }])));

    // Arc is stale: lastSignalAt is well before the 7-day cutoff
    const staleArc = makeArc({
      id: "arc-stale",
      accountId: "acct-1",
      status: "active",
      urgency: "normal",
      lastSignalAt: "2025-04-01T00:00:00.000Z",
    });
    mockListActiveArcsBefore.mockReturnValue(Promise.resolve(ok([staleArc])));

    await job.run();

    const trackCalls = mockLogger.calls.filter(c => c.method === "track" && c.message === "staleness_checker.outstanding_arcs");

    expect(trackCalls).toHaveLength(1);
    expect(trackCalls[0]!.context).toMatchObject({
      accountId: "acct-1",
      outstandingArcCount: 1,
      oldestArcLastSignalAt: "2025-04-01T00:00:00.000Z",
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 2.2: No log emitted for accounts with zero outstanding arcs
  // -------------------------------------------------------------------------

  it("does not emit TRACK log for accounts with zero outstanding arcs", async () => {
    const domain = makeDomain({ accountId: "acct-2" });
    mockScanAllDomains.mockReturnValue(Promise.resolve(ok([{ accountId: "acct-2", domains: [domain] }])));
    mockGetAccount.mockReturnValue(Promise.resolve(ok({ id: "acct-2", notifications: {} } as Account)));

    // No stale arcs returned
    mockListActiveArcsBefore.mockReturnValue(Promise.resolve(ok([])));

    await job.run();

    const trackCalls = mockLogger.calls.filter(c => c.method === "track" && c.message === "staleness_checker.outstanding_arcs");

    expect(trackCalls).toHaveLength(0);
  });

  it("does not emit TRACK log when arcs are returned but none qualify as outstanding", async () => {
    const domain = makeDomain({ accountId: "acct-3" });
    mockScanAllDomains.mockReturnValue(Promise.resolve(ok([{ accountId: "acct-3", domains: [domain] }])));
    mockGetAccount.mockReturnValue(Promise.resolve(ok({ id: "acct-3", notifications: {} } as Account)));

    // Arc has urgency "silent" — should be filtered out by isOutstandingArc
    const silentArc = makeArc({
      id: "arc-silent",
      accountId: "acct-3",
      status: "active",
      urgency: "silent",
      lastSignalAt: "2025-04-01T00:00:00.000Z",
    });
    mockListActiveArcsBefore.mockReturnValue(Promise.resolve(ok([silentArc])));

    await job.run();

    const trackCalls = mockLogger.calls.filter(c => c.method === "track" && c.message === "staleness_checker.outstanding_arcs");

    expect(trackCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Requirement 3.4: Error in one account does not prevent processing others
  // -------------------------------------------------------------------------

  it("continues processing remaining accounts when one account errors", async () => {
    const domain1 = makeDomain({ accountId: "acct-fail" });
    const domain2 = makeDomain({ accountId: "acct-ok" });
    mockScanAllDomains.mockReturnValue(Promise.resolve(ok([
      { accountId: "acct-fail", domains: [domain1] },
      { accountId: "acct-ok", domains: [domain2] },
    ])));
    mockGetAccount.mockImplementation((id: string) => Promise.resolve(ok({ id, notifications: {} } as Account)));

    // First account returns error on staleness query
    mockListActiveArcsBefore.mockImplementation((accountId: string) => {
      if (accountId === "acct-fail") return Promise.resolve(err(new Error("DynamoDB timeout")));
      return Promise.resolve(ok([makeArc({ id: "arc-ok", accountId: "acct-ok", status: "active", urgency: "high", lastSignalAt: "2025-04-01T00:00:00.000Z" })]));
    });

    await job.run();

    // Error logged for the failing account
    const errorCalls = mockLogger.calls.filter(c => c.method === "track" && c.context?.code === "staleness_checker.account_error");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]!.context).toMatchObject({
      accountId: "acct-fail",
    });

    // TRACK log still emitted for the successful account
    const trackCalls = mockLogger.calls.filter(c => c.method === "track" && c.message === "staleness_checker.outstanding_arcs");
    expect(trackCalls).toHaveLength(1);
    expect(trackCalls[0]!.context).toMatchObject({
      accountId: "acct-ok",
      outstandingArcCount: 1,
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 2.3: Run-complete log always emitted with correct totals
  // -------------------------------------------------------------------------

  it("emits run-complete log with correct totals after all accounts processed", async () => {
    const domain1 = makeDomain({ accountId: "acct-a" });
    const domain2 = makeDomain({ accountId: "acct-b" });
    mockScanAllDomains.mockReturnValue(Promise.resolve(ok([
      { accountId: "acct-a", domains: [domain1] },
      { accountId: "acct-b", domains: [domain2] },
    ])));
    mockGetAccount.mockImplementation((id: string) => Promise.resolve(ok({ id, notifications: {} } as Account)));

    mockListActiveArcsBefore.mockImplementation((accountId: string) => {
      if (accountId === "acct-a") {
        return Promise.resolve(ok([
          makeArc({ id: "arc-a1", accountId: "acct-a", status: "active", urgency: "normal", lastSignalAt: "2025-04-01T00:00:00.000Z" }),
          makeArc({ id: "arc-a2", accountId: "acct-a", status: "active", urgency: "high", lastSignalAt: "2025-04-02T00:00:00.000Z" }),
        ]));
      }
      return Promise.resolve(ok([]));
    });

    await job.run();

    const infoCalls = mockLogger.calls.filter(c => c.method === "info" && c.message === "staleness_checker.run_complete");

    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]!.context).toMatchObject({
      accountsWithOutstandingArcs: 1,
      totalOutstandingArcs: 2,
    });
    // durationMs should be present and non-negative
    expect((infoCalls[0]!.context as any).durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits run-complete log with zero counts when no accounts have outstanding arcs", async () => {
    const domain = makeDomain({ accountId: "acct-clean" });
    mockScanAllDomains.mockReturnValue(Promise.resolve(ok([{ accountId: "acct-clean", domains: [domain] }])));
    mockGetAccount.mockReturnValue(Promise.resolve(ok({ id: "acct-clean", notifications: {} } as Account)));
    mockListActiveArcsBefore.mockReturnValue(Promise.resolve(ok([])));

    await job.run();

    const infoCalls = mockLogger.calls.filter(c => c.method === "info" && c.message === "staleness_checker.run_complete");

    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]!.context).toMatchObject({
      accountsWithOutstandingArcs: 0,
      totalOutstandingArcs: 0,
    });
  });

  it("emits run-complete log even when all accounts error", async () => {
    const domain = makeDomain({ accountId: "acct-err" });
    mockScanAllDomains.mockReturnValue(Promise.resolve(ok([{ accountId: "acct-err", domains: [domain] }])));
    mockGetAccount.mockReturnValue(Promise.resolve(ok({ id: "acct-err", notifications: {} } as Account)));
    mockListActiveArcsBefore.mockReturnValue(Promise.resolve(err(new Error("Total failure"))));

    await job.run();

    const infoCalls = mockLogger.calls.filter(c => c.method === "info" && c.message === "staleness_checker.run_complete");

    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]!.context).toMatchObject({
      accountsWithOutstandingArcs: 0,
      totalOutstandingArcs: 0,
    });
  });
});
