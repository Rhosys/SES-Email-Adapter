import { describe, it, expect } from "vitest";
import { isOutstandingThread, buildAccountLogEntry, type AccountStalenessReport } from "../../src/jobs/staleness-logic.js";
import type { Thread, ThreadStatus, ThreadUrgency, Workflow } from "../../src/types/index.js";

function buildThread(status: ThreadStatus, urgency: ThreadUrgency | undefined, workflow: Workflow, lastSignalAt: string): Thread {
  return {
    id: "arc_test", accountId: "acc_test", workflow, labels: [], status,
    summary: "test arc", lastSignalAt, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
    senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email",
    ...(urgency !== undefined ? { urgency } : {}),
  };
}

describe("Outstanding thread classification", () => {
  const CUTOFF = "2024-06-01T00:00:00.000Z";
  const BEFORE_CUTOFF = "2024-05-01T00:00:00.000Z";
  const AFTER_CUTOFF = "2024-07-01T00:00:00.000Z";

  const trueCases = [
    { label: "active + normal + before cutoff", status: "active" as const, urgency: "normal" as const, lastSignalAt: BEFORE_CUTOFF },
    { label: "active + high + before cutoff", status: "active" as const, urgency: "high" as const, lastSignalAt: BEFORE_CUTOFF },
    { label: "active + critical + before cutoff", status: "active" as const, urgency: "critical" as const, lastSignalAt: BEFORE_CUTOFF },
    { label: "active + low + before cutoff", status: "active" as const, urgency: "low" as const, lastSignalAt: BEFORE_CUTOFF },
    { label: "active + undefined urgency + before cutoff", status: "active" as const, urgency: undefined, lastSignalAt: BEFORE_CUTOFF },
  ];

  const falseCases = [
    { label: "archived status", status: "archived" as const, urgency: "normal" as const, lastSignalAt: BEFORE_CUTOFF },
    { label: "deleted status", status: "deleted" as const, urgency: "normal" as const, lastSignalAt: BEFORE_CUTOFF },
    { label: "silent urgency", status: "active" as const, urgency: "silent" as const, lastSignalAt: BEFORE_CUTOFF },
    { label: "lastSignalAt after cutoff", status: "active" as const, urgency: "normal" as const, lastSignalAt: AFTER_CUTOFF },
    { label: "lastSignalAt equals cutoff (not strictly less)", status: "active" as const, urgency: "normal" as const, lastSignalAt: CUTOFF },
  ];

  it.each(trueCases)("$label → true", ({ status, urgency, lastSignalAt }) => {
    const thread = buildThread(status, urgency, "conversation", lastSignalAt);
    expect(isOutstandingThread(thread, CUTOFF)).toBe(true);
  });

  it.each(falseCases)("$label → false", ({ status, urgency, lastSignalAt }) => {
    const thread = buildThread(status, urgency, "conversation", lastSignalAt);
    expect(isOutstandingThread(thread, CUTOFF)).toBe(false);
  });

  it("workflow has no effect on the result", () => {
    const thread1 = buildThread("active", "normal", "conversation", BEFORE_CUTOFF);
    const thread2 = buildThread("active", "normal", "payments", BEFORE_CUTOFF);
    const thread3 = buildThread("active", "normal", "alert", BEFORE_CUTOFF);
    expect(isOutstandingThread(thread1, CUTOFF)).toBe(isOutstandingThread(thread2, CUTOFF));
    expect(isOutstandingThread(thread2, CUTOFF)).toBe(isOutstandingThread(thread3, CUTOFF));
  });

  it("undefined urgency behaves same as normal", () => {
    const threadUndefined = buildThread("active", undefined, "conversation", BEFORE_CUTOFF);
    const threadNormal = buildThread("active", "normal", "conversation", BEFORE_CUTOFF);
    expect(isOutstandingThread(threadUndefined, CUTOFF)).toBe(isOutstandingThread(threadNormal, CUTOFF));
  });
});

describe("TRACK log entry structure", () => {
  it("buildAccountLogEntry produces object with exactly the required fields", () => {
    const report: AccountStalenessReport = {
      accountId: "acct-123",
      outstandingThreadCount: 5,
      oldestThreadLastSignalAt: "2024-03-15T10:00:00.000Z",
    };
    const timestamp = "2024-06-01T12:00:00.000Z";

    const result = buildAccountLogEntry(report, timestamp) as Record<string, unknown>;
    const keys = Object.keys(result);

    expect(keys).toHaveLength(6);
    expect(keys.sort()).toEqual(["accountId", "level", "message", "oldestThreadLastSignalAt", "outstandingThreadCount", "timestamp"].sort());
    expect(result.level).toBe("track");
    expect(result.message).toBe("staleness_checker.outstanding_threads");
    expect(result.accountId).toBe("acct-123");
    expect(result.outstandingThreadCount).toBe(5);
    expect(result.oldestThreadLastSignalAt).toBe("2024-03-15T10:00:00.000Z");
    expect(result.timestamp).toBe(timestamp);
  });
});
