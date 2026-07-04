import { describe, it, expect } from "vitest";
import { buildAccountReports, type OutstandingThread } from "../../src/jobs/staleness-logic.js";

describe("Account report grouping correctness", () => {
  it("single account with one thread produces one report", () => {
    const threads: OutstandingThread[] = [
      { id: "arc-1", accountId: "acct-1", lastSignalAt: "2024-03-01T00:00:00Z", urgency: "normal", workflow: "conversation" },
    ];
    const reports = buildAccountReports(threads);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.accountId).toBe("acct-1");
    expect(reports[0]!.outstandingThreadCount).toBe(1);
    expect(reports[0]!.oldestThreadLastSignalAt).toBe("2024-03-01T00:00:00Z");
  });

  it("multiple threads for same account are grouped into one report", () => {
    const threads: OutstandingThread[] = [
      { id: "arc-1", accountId: "acct-1", lastSignalAt: "2024-03-01T00:00:00Z", urgency: "normal", workflow: "conversation" },
      { id: "arc-2", accountId: "acct-1", lastSignalAt: "2024-02-01T00:00:00Z", urgency: "high", workflow: "payments" },
      { id: "arc-3", accountId: "acct-1", lastSignalAt: "2024-04-01T00:00:00Z", urgency: "low", workflow: "alert" },
    ];
    const reports = buildAccountReports(threads);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.outstandingThreadCount).toBe(3);
    expect(reports[0]!.oldestThreadLastSignalAt).toBe("2024-02-01T00:00:00Z");
  });

  it("threads from different accounts produce one report per account", () => {
    const threads: OutstandingThread[] = [
      { id: "arc-1", accountId: "acct-1", lastSignalAt: "2024-03-01T00:00:00Z", urgency: "normal", workflow: "conversation" },
      { id: "arc-2", accountId: "acct-2", lastSignalAt: "2024-01-15T00:00:00Z", urgency: "critical", workflow: "alert" },
      { id: "arc-3", accountId: "acct-1", lastSignalAt: "2024-02-01T00:00:00Z", urgency: "high", workflow: "payments" },
      { id: "arc-4", accountId: "acct-3", lastSignalAt: "2024-05-01T00:00:00Z", urgency: undefined, workflow: "travel" },
    ];
    const reports = buildAccountReports(threads);
    expect(reports).toHaveLength(3);

    const acct1 = reports.find((r) => r.accountId === "acct-1")!;
    expect(acct1.outstandingThreadCount).toBe(2);
    expect(acct1.oldestThreadLastSignalAt).toBe("2024-02-01T00:00:00Z");

    const acct2 = reports.find((r) => r.accountId === "acct-2")!;
    expect(acct2.outstandingThreadCount).toBe(1);
    expect(acct2.oldestThreadLastSignalAt).toBe("2024-01-15T00:00:00Z");

    const acct3 = reports.find((r) => r.accountId === "acct-3")!;
    expect(acct3.outstandingThreadCount).toBe(1);
    expect(acct3.oldestThreadLastSignalAt).toBe("2024-05-01T00:00:00Z");
  });

  it("oldestThreadLastSignalAt is the minimum lastSignalAt for each account", () => {
    const threads: OutstandingThread[] = [
      { id: "arc-1", accountId: "acct-1", lastSignalAt: "2024-05-01T00:00:00Z", urgency: "normal", workflow: "conversation" },
      { id: "arc-2", accountId: "acct-1", lastSignalAt: "2024-01-01T00:00:00Z", urgency: "normal", workflow: "conversation" },
      { id: "arc-3", accountId: "acct-1", lastSignalAt: "2024-03-01T00:00:00Z", urgency: "normal", workflow: "conversation" },
    ];
    const reports = buildAccountReports(threads);
    expect(reports[0]!.oldestThreadLastSignalAt).toBe("2024-01-01T00:00:00Z");
  });
});
