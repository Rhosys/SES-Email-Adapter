import { describe, it, expect } from "vitest";
import { toApiThread, toApiSignal } from "../../src/api/transform.js";
import { ErrorCode } from "../../src/api/schemas.js";
import type { Thread, AnySignal, EmailSignalData } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers: minimal DB objects for transform inputs
// ---------------------------------------------------------------------------

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thr-abc123",
    accountId: "acct-001",
    workflow: "conversation",
    labels: ["inbox"],
    status: "active",
    summary: "Test thread",
    lastSignalAt: "2024-01-15T10:00:00.000Z",
    createdAt: "2024-01-15T09:00:00.000Z",
    updatedAt: "2024-01-15T10:00:00.000Z",
    senderAddress: "sender@example.com",
    recipientAddress: "recipient@example.com",
    subject: "Hello",
    ...overrides,
  };
}

function makeEmailSignal(overrides: Partial<AnySignal> = {}): AnySignal {
  return {
    id: "sgn-xyz789",
    signalLookupId: "sgn-xyz789",
    accountId: "acct-001",
    source: "system",
    type: "email",
    status: "active",
    labels: [],
    createdAt: "2024-01-15T10:00:00.000Z",
    data: {
      receivedAt: "2024-01-15T10:00:00.000Z",
      summary: "Email signal",
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "recipient@example.com", name: "Recipient" }],
      cc: [],
      subject: "Test email",
      attachments: [],
      recipientAddress: "recipient@example.com",
      workflow: "conversation",
      workflowData: {},
      tags: [],
      s3Key: "raw/test-key",
      headers: {},
    } as unknown as EmailSignalData,
    ...overrides,
  } as AnySignal;
}

// ---------------------------------------------------------------------------
// Invariant 1: Thread-list responses use `threads` envelope with pagination
// ---------------------------------------------------------------------------

describe("Invariant 1: Thread-list responses use `threads` envelope", () => {
  // The page() helper is internal to each API module. We test the shape
  // indirectly by verifying the schema contract: ListThreadsResponse expects
  // { threads: [...], pagination: {...} } — no `arcs` key.
  // We replicate the page() logic here to test the envelope shape directly.
  function page<K extends string, T>(key: K, items: T[], nextCursor?: string): Record<K, T[]> & { pagination: { cursor: string | null } } {
    return { [key]: items, pagination: { cursor: nextCursor ?? null } } as Record<K, T[]> & { pagination: { cursor: string | null } };
  }

  it.each([
    { desc: "empty list", items: [], cursor: undefined },
    { desc: "single thread", items: [makeThread()], cursor: undefined },
    { desc: "multiple threads with cursor", items: [makeThread({ id: "thr-1" }), makeThread({ id: "thr-2" })], cursor: "next-page" },
  ])("$desc — response has `threads` key + `pagination`, no `arcs` key", ({ items, cursor }) => {
    const response = page("threads", items.map(toApiThread), cursor);
    expect(response).toHaveProperty("threads");
    expect(response).toHaveProperty("pagination");
    expect(response).not.toHaveProperty("arcs");
    expect(response.pagination).toHaveProperty("cursor");
  });
});

// ---------------------------------------------------------------------------
// Invariant 2: toApiThread output has `threadId`, no `arcId`
// ---------------------------------------------------------------------------

describe("Invariant 2: toApiThread exposes threadId, never arcId", () => {
  it.each([
    { desc: "basic thread", thread: makeThread() },
    { desc: "archived thread", thread: makeThread({ status: "archived", id: "thr-arch" }) },
    { desc: "thread with urgency", thread: makeThread({ urgency: "high", id: "thr-urg" }) },
    { desc: "thread with followupAt", thread: makeThread({ followupAt: "2024-02-01T00:00:00.000Z", id: "thr-fu" }) },
    { desc: "deleted thread", thread: makeThread({ status: "deleted", deletedAt: "2024-01-20T00:00:00.000Z", id: "thr-del" }) },
  ])("$desc — has threadId, no arcId", ({ thread }) => {
    const result = toApiThread(thread);
    expect(result).toHaveProperty("threadId", thread.id);
    expect(result).not.toHaveProperty("arcId");
  });
});

// ---------------------------------------------------------------------------
// Invariant 3: toApiSignal output has `threadId` (or null), no `arcId`
// ---------------------------------------------------------------------------

describe("Invariant 3: toApiSignal exposes threadId (or null), never arcId", () => {
  it.each([
    { desc: "signal with threadId", signal: makeEmailSignal({ threadId: "thr-abc" }), expectedThreadId: "thr-abc" },
    { desc: "signal without threadId (unassigned)", signal: makeEmailSignal(), expectedThreadId: null },
    { desc: "signal with different threadId", signal: makeEmailSignal({ threadId: "thr-xyz" }), expectedThreadId: "thr-xyz" },
  ])("$desc — has threadId=$expectedThreadId, no arcId", ({ signal, expectedThreadId }) => {
    const result = toApiSignal(signal);
    expect(result).toHaveProperty("threadId", expectedThreadId);
    expect(result).not.toHaveProperty("arcId");
  });
});

// ---------------------------------------------------------------------------
// Invariant 4: Quarantine-approval body has `thread` with threadId, no `arc`
// ---------------------------------------------------------------------------

describe("Invariant 4: Quarantine-approval body uses thread terminology", () => {
  // The quarantine-response handler returns: { thread: toApiThread(thread), signal: toApiSignal(...) }
  // We verify the shape by constructing what the handler would return.
  it.each([
    { desc: "newly created thread", thread: makeThread({ id: "thr-new" }), signal: makeEmailSignal({ threadId: "thr-new" }) },
    { desc: "matched existing thread", thread: makeThread({ id: "thr-exist" }), signal: makeEmailSignal({ threadId: "thr-exist" }) },
  ])("$desc — body has `thread` with threadId, no `arc` key", ({ thread, signal }) => {
    const body = { thread: toApiThread(thread), signal: toApiSignal(signal) };
    expect(body).toHaveProperty("thread");
    expect(body).not.toHaveProperty("arc");
    expect(body.thread).toHaveProperty("threadId", thread.id);
    expect(body.thread).not.toHaveProperty("arcId");
  });
});

// ---------------------------------------------------------------------------
// Invariant 11: No ErrorCode enum value contains substring "ARC"
// ---------------------------------------------------------------------------

describe("Invariant 11: No ErrorCode contains substring ARC", () => {
  it("every ErrorCode enum value is free of the substring ARC", () => {
    const allCodes = ErrorCode.options;
    const arcCodes = allCodes.filter(code => code.includes("ARC"));
    expect(arcCodes).toEqual([]);
  });
});
