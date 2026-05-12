// ---------------------------------------------------------------------------
// Unit tests for staleness integration in domain-health-job
// Validates: Requirements 2.1, 2.2, 3.4
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { ResultAsync } from "neverthrow";
import { dbError } from "../errors.js";
import type { Arc, Domain, Account } from "../types/index.js";
import { createMockLogger } from "../testing/mock-logger.js";
import type { MockLogger } from "../testing/mock-logger.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockScanAllDomains = vi.fn();
const mockGetAccount = vi.fn();
const mockUpdateDomainHealth = vi.fn();

vi.mock("../database/account-database.js", () => ({
  AccountDatabase: vi.fn().mockImplementation(() => ({
    scanAllDomains: mockScanAllDomains,
    getAccount: mockGetAccount,
    updateDomainHealth: mockUpdateDomainHealth,
  })),
}));

const mockListActiveArcsBefore = vi.fn();

vi.mock("../database/arc-database.js", () => ({
  ArcDatabase: vi.fn().mockImplementation(() => ({
    listActiveArcsBefore: mockListActiveArcsBefore,
  })),
}));

/** Helper to wrap a value in a ResultAsync ok */
function okAsync<T>(value: T) {
  return ResultAsync.fromPromise(Promise.resolve(value), () => dbError(new Error("unexpected")));
}

/** Helper to wrap an error in a ResultAsync err */
function errAsync(error: Error) {
  return ResultAsync.fromPromise(Promise.reject(error), () => dbError(error));
}

const mockCheckDomain = vi.fn().mockResolvedValue([]);

vi.mock("../dns/dns-checker.js", () => ({
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
let DomainHealthJob: typeof import("./domain-health-job.js").DomainHealthJob;
beforeAll(async () => {
  const mod = await import("./domain-health-job.js");
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
    id: "example.com",
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
  mockGetAccount.mockReturnValue(okAsync({ id: "acct-1", notifications: {} } as Account));
  mockUpdateDomainHealth.mockReturnValue(okAsync(undefined));
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
    const { AccountDatabase } = await import("../database/account-database.js");
    const { ArcDatabase } = await import("../database/arc-database.js");
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
    mockScanAllDomains.mockReturnValue(okAsync([{ accountId: "acct-1", domains: [domain] }]));

    // Arc is stale: lastSignalAt is well before the 7-day cutoff
    const staleArc = makeArc({
      id: "arc-stale",
      accountId: "acct-1",
      status: "active",
      urgency: "normal",
      lastSignalAt: "2025-04-01T00:00:00.000Z",
    });
    mockListActiveArcsBefore.mockReturnValue(okAsync([staleArc]));

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
    mockScanAllDomains.mockReturnValue(okAsync([{ accountId: "acct-2", domains: [domain] }]));
    mockGetAccount.mockReturnValue(okAsync({ id: "acct-2", notifications: {} } as Account));

    // No stale arcs returned
    mockListActiveArcsBefore.mockReturnValue(okAsync([]));

    await job.run();

    const trackCalls = mockLogger.calls.filter(c => c.method === "track" && c.message === "staleness_checker.outstanding_arcs");

    expect(trackCalls).toHaveLength(0);
  });

  it("does not emit TRACK log when arcs are returned but none qualify as outstanding", async () => {
    const domain = makeDomain({ accountId: "acct-3" });
    mockScanAllDomains.mockReturnValue(okAsync([{ accountId: "acct-3", domains: [domain] }]));
    mockGetAccount.mockReturnValue(okAsync({ id: "acct-3", notifications: {} } as Account));

    // Arc has urgency "silent" — should be filtered out by isOutstandingArc
    const silentArc = makeArc({
      id: "arc-silent",
      accountId: "acct-3",
      status: "active",
      urgency: "silent",
      lastSignalAt: "2025-04-01T00:00:00.000Z",
    });
    mockListActiveArcsBefore.mockReturnValue(okAsync([silentArc]));

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
    mockScanAllDomains.mockReturnValue(okAsync([
      { accountId: "acct-fail", domains: [domain1] },
      { accountId: "acct-ok", domains: [domain2] },
    ]));
    mockGetAccount.mockImplementation((id: string) => okAsync({ id, notifications: {} } as Account));

    // First account returns error on staleness query
    mockListActiveArcsBefore.mockImplementation((accountId: string) => {
      if (accountId === "acct-fail") return errAsync(new Error("DynamoDB timeout"));
      return okAsync([makeArc({ id: "arc-ok", accountId: "acct-ok", status: "active", urgency: "high", lastSignalAt: "2025-04-01T00:00:00.000Z" })]);
    });

    await job.run();

    // Error logged for the failing account
    const errorCalls = mockLogger.calls.filter(c => c.method === "error" && c.context?.code === "staleness_checker.account_error");
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
    mockScanAllDomains.mockReturnValue(okAsync([
      { accountId: "acct-a", domains: [domain1] },
      { accountId: "acct-b", domains: [domain2] },
    ]));
    mockGetAccount.mockImplementation((id: string) => okAsync({ id, notifications: {} } as Account));

    mockListActiveArcsBefore.mockImplementation((accountId: string) => {
      if (accountId === "acct-a") {
        return okAsync([
          makeArc({ id: "arc-a1", accountId: "acct-a", status: "active", urgency: "normal", lastSignalAt: "2025-04-01T00:00:00.000Z" }),
          makeArc({ id: "arc-a2", accountId: "acct-a", status: "active", urgency: "high", lastSignalAt: "2025-04-02T00:00:00.000Z" }),
        ]);
      }
      return okAsync([]);
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
    mockScanAllDomains.mockReturnValue(okAsync([{ accountId: "acct-clean", domains: [domain] }]));
    mockGetAccount.mockReturnValue(okAsync({ id: "acct-clean", notifications: {} } as Account));
    mockListActiveArcsBefore.mockReturnValue(okAsync([]));

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
    mockScanAllDomains.mockReturnValue(okAsync([{ accountId: "acct-err", domains: [domain] }]));
    mockGetAccount.mockReturnValue(okAsync({ id: "acct-err", notifications: {} } as Account));
    mockListActiveArcsBefore.mockReturnValue(errAsync(new Error("Total failure")));

    await job.run();

    const infoCalls = mockLogger.calls.filter(c => c.method === "info" && c.message === "staleness_checker.run_complete");

    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]!.context).toMatchObject({
      accountsWithOutstandingArcs: 0,
      totalOutstandingArcs: 0,
    });
  });
});
