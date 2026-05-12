// ---------------------------------------------------------------------------
// Unit tests for staleness integration in domain-health-job
// Validates: Requirements 2.1, 2.2, 3.4
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { ResultAsync } from "neverthrow";
import { ok, err, dbError } from "../errors.js";
import type { Arc, Domain, Account } from "../types/index.js";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the handler
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

// Import handler after mocks are set up
let handler: () => Promise<void>;
beforeAll(async () => {
  const mod = await import("./domain-health-job.js");
  handler = mod.handler;
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

/** Extract all JSON objects logged via console.log */
function getLoggedEntries(spy: ReturnType<typeof vi.spyOn>): unknown[] {
  return spy.mock.calls
    .map(([arg]) => {
      try { return JSON.parse(arg as string); }
      catch { return null; }
    })
    .filter((v): v is object => v !== null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("domain-health-job staleness integration", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-05-11T16:00:00.000Z"));
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setupDefaultMocks();
    mockCheckDomain.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleSpy.mockRestore();
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

    await handler();

    const entries = getLoggedEntries(consoleSpy);
    const trackLogs = entries.filter((e: any) => e.level === "track" && e.message === "staleness_checker.outstanding_arcs");

    expect(trackLogs).toHaveLength(1);
    expect(trackLogs[0]).toMatchObject({
      level: "track",
      message: "staleness_checker.outstanding_arcs",
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

    await handler();

    const entries = getLoggedEntries(consoleSpy);
    const trackLogs = entries.filter((e: any) => e.level === "track" && e.message === "staleness_checker.outstanding_arcs");

    expect(trackLogs).toHaveLength(0);
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

    await handler();

    const entries = getLoggedEntries(consoleSpy);
    const trackLogs = entries.filter((e: any) => e.level === "track" && e.message === "staleness_checker.outstanding_arcs");

    expect(trackLogs).toHaveLength(0);
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

    await handler();

    const entries = getLoggedEntries(consoleSpy);

    // Error logged for the failing account
    const errorLogs = entries.filter((e: any) => e.level === "error" && e.message === "staleness_checker.account_error");
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toMatchObject({
      level: "error",
      message: "staleness_checker.account_error",
      accountId: "acct-fail",
    });

    // TRACK log still emitted for the successful account
    const trackLogs = entries.filter((e: any) => e.level === "track" && e.message === "staleness_checker.outstanding_arcs");
    expect(trackLogs).toHaveLength(1);
    expect(trackLogs[0]).toMatchObject({
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

    await handler();

    const entries = getLoggedEntries(consoleSpy);
    const runCompleteLogs = entries.filter((e: any) => e.level === "info" && e.message === "staleness_checker.run_complete");

    expect(runCompleteLogs).toHaveLength(1);
    expect(runCompleteLogs[0]).toMatchObject({
      level: "info",
      message: "staleness_checker.run_complete",
      accountsWithOutstandingArcs: 1,
      totalOutstandingArcs: 2,
    });
    // durationMs should be present and non-negative
    expect((runCompleteLogs[0] as any).durationMs).toBeGreaterThanOrEqual(0);
    expect((runCompleteLogs[0] as any).timestamp).toBeDefined();
  });

  it("emits run-complete log with zero counts when no accounts have outstanding arcs", async () => {
    const domain = makeDomain({ accountId: "acct-clean" });
    mockScanAllDomains.mockReturnValue(okAsync([{ accountId: "acct-clean", domains: [domain] }]));
    mockGetAccount.mockReturnValue(okAsync({ id: "acct-clean", notifications: {} } as Account));
    mockListActiveArcsBefore.mockReturnValue(okAsync([]));

    await handler();

    const entries = getLoggedEntries(consoleSpy);
    const runCompleteLogs = entries.filter((e: any) => e.level === "info" && e.message === "staleness_checker.run_complete");

    expect(runCompleteLogs).toHaveLength(1);
    expect(runCompleteLogs[0]).toMatchObject({
      level: "info",
      message: "staleness_checker.run_complete",
      accountsWithOutstandingArcs: 0,
      totalOutstandingArcs: 0,
    });
  });

  it("emits run-complete log even when all accounts error", async () => {
    const domain = makeDomain({ accountId: "acct-err" });
    mockScanAllDomains.mockReturnValue(okAsync([{ accountId: "acct-err", domains: [domain] }]));
    mockGetAccount.mockReturnValue(okAsync({ id: "acct-err", notifications: {} } as Account));
    mockListActiveArcsBefore.mockReturnValue(errAsync(new Error("Total failure")));

    await handler();

    const entries = getLoggedEntries(consoleSpy);
    const runCompleteLogs = entries.filter((e: any) => e.level === "info" && e.message === "staleness_checker.run_complete");

    expect(runCompleteLogs).toHaveLength(1);
    expect(runCompleteLogs[0]).toMatchObject({
      level: "info",
      message: "staleness_checker.run_complete",
      accountsWithOutstandingArcs: 0,
      totalOutstandingArcs: 0,
    });
  });
});
