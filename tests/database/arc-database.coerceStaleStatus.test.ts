import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DateTime } from "luxon";
import { coerceStaleStatus } from "../../src/database/thread-database.js";
import type { Signal, EmailSignalData } from "../../src/types/index.js";

const baseData: EmailSignalData = {
  receivedAt: "2024-01-01T00:00:00.000Z",
  summary: "Test",
  from: { address: "a@b.com", name: "" },
  to: [{ address: "c@d.com", name: "" }],
  cc: [],
  subject: "Test",
  attachments: [],
  headers: {},
  recipientAddress: "c@d.com",
  workflow: "unspecified",
  workflowData: { workflow: "unspecified" },
  tags: [],
  s3Key: "test-key",
};

function makeSignal(overrides: { status?: Signal["status"]; sendInitiatedAt?: string } = {}): Signal<EmailSignalData> {
  return {
    id: "sgn-test",
    signalLookupId: "sgn-test",
    accountId: "acct-1",
    source: "user",
    type: "email",
    status: overrides.status ?? "pending_send",
    labels: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    data: { ...baseData, ...(overrides.sendInitiatedAt !== undefined ? { sendInitiatedAt: overrides.sendInitiatedAt } : {}) },
  };
}

describe("coerceStaleStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pending_send within 4 hours → status unchanged", () => {
    const twoHoursAgo = DateTime.utc().minus({ hours: 2 }).toISO()!;
    const signal = makeSignal({ sendInitiatedAt: twoHoursAgo });

    const result = coerceStaleStatus(signal);

    expect(result.status).toBe("pending_send");
  });

  it("pending_send older than 4 hours → coerced to draft", () => {
    const fiveHoursAgo = DateTime.utc().minus({ hours: 5 }).toISO()!;
    const signal = makeSignal({ sendInitiatedAt: fiveHoursAgo });

    const result = coerceStaleStatus(signal);

    expect(result.status).toBe("draft");
  });

  it("pending_send with no sendInitiatedAt → coerced to draft", () => {
    const signal = makeSignal(); // no sendInitiatedAt in data

    const result = coerceStaleStatus(signal);

    expect(result.status).toBe("draft");
  });

  it("non-pending_send status → unaffected", () => {
    const signal = makeSignal({ status: "active" });

    const result = coerceStaleStatus(signal);

    expect(result.status).toBe("active");
    expect(result).toBe(signal); // same reference — no copy made
  });

  it("coercion does not mutate the original signal", () => {
    const fiveHoursAgo = DateTime.utc().minus({ hours: 5 }).toISO()!;
    const signal = makeSignal({ sendInitiatedAt: fiveHoursAgo });

    const result = coerceStaleStatus(signal);

    expect(result).not.toBe(signal); // new object
    expect(signal.status).toBe("pending_send"); // original unchanged
    expect(result.status).toBe("draft");
  });
});
