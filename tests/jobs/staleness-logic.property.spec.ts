import { describe, it, expect } from "vitest";
import { isOutstandingArc, buildAccountLogEntry, type AccountStalenessReport } from "../../src/jobs/staleness-logic.js";
import type { Arc, ArcStatus, ArcUrgency, Workflow } from "../../src/types/index.js";

function buildArc(status: ArcStatus, urgency: ArcUrgency | undefined, workflow: Workflow, lastSignalAt: string): Arc {
  return {
    id: "arc_test", accountId: "acc_test", workflow, labels: [], status,
    summary: "test arc", lastSignalAt, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z",
    senderAddress: "sender@example.com", recipientAddress: "user@example.com", subject: "Test email",
    ...(urgency !== undefined ? { urgency } : {}),
  };
}

describe("Outstanding arc classification", () => {
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
    const arc = buildArc(status, urgency, "conversation", lastSignalAt);
    expect(isOutstandingArc(arc, CUTOFF)).toBe(true);
  });

  it.each(falseCases)("$label → false", ({ status, urgency, lastSignalAt }) => {
    const arc = buildArc(status, urgency, "conversation", lastSignalAt);
    expect(isOutstandingArc(arc, CUTOFF)).toBe(false);
  });

  it("workflow has no effect on the result", () => {
    const arc1 = buildArc("active", "normal", "conversation", BEFORE_CUTOFF);
    const arc2 = buildArc("active", "normal", "payments", BEFORE_CUTOFF);
    const arc3 = buildArc("active", "normal", "alert", BEFORE_CUTOFF);
    expect(isOutstandingArc(arc1, CUTOFF)).toBe(isOutstandingArc(arc2, CUTOFF));
    expect(isOutstandingArc(arc2, CUTOFF)).toBe(isOutstandingArc(arc3, CUTOFF));
  });

  it("undefined urgency behaves same as normal", () => {
    const arcUndefined = buildArc("active", undefined, "conversation", BEFORE_CUTOFF);
    const arcNormal = buildArc("active", "normal", "conversation", BEFORE_CUTOFF);
    expect(isOutstandingArc(arcUndefined, CUTOFF)).toBe(isOutstandingArc(arcNormal, CUTOFF));
  });
});

describe("TRACK log entry structure", () => {
  it("buildAccountLogEntry produces object with exactly the required fields", () => {
    const report: AccountStalenessReport = {
      accountId: "acct-123",
      outstandingArcCount: 5,
      oldestArcLastSignalAt: "2024-03-15T10:00:00.000Z",
    };
    const timestamp = "2024-06-01T12:00:00.000Z";

    const result = buildAccountLogEntry(report, timestamp) as Record<string, unknown>;
    const keys = Object.keys(result);

    expect(keys).toHaveLength(6);
    expect(keys.sort()).toEqual(["accountId", "level", "message", "oldestArcLastSignalAt", "outstandingArcCount", "timestamp"].sort());
    expect(result.level).toBe("track");
    expect(result.message).toBe("staleness_checker.outstanding_arcs");
    expect(result.accountId).toBe("acct-123");
    expect(result.outstandingArcCount).toBe(5);
    expect(result.oldestArcLastSignalAt).toBe("2024-03-15T10:00:00.000Z");
    expect(result.timestamp).toBe(timestamp);
  });
});
