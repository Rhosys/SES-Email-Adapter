import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "neverthrow";
import { EmxIdleWorker } from "../../src/external-exchanges/emx-idle-worker.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { Logger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/external-exchanges/imap-adapter.js", () => ({
  ImapConnection: vi.fn(),
}));

vi.mock("../../src/external-exchanges/jmap-adapter.js", () => ({
  buildBasicAuth: vi.fn().mockReturnValue("Basic dGVzdDpwYXNz"),
  fetchSession: vi.fn(),
  jmapCall: vi.fn(),
  JMAP_USING: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
}));

import { ImapConnection } from "../../src/external-exchanges/imap-adapter.js";
import { fetchSession, jmapCall } from "../../src/external-exchanges/jmap-adapter.js";

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockLogger: Logger = {
  startInvocation: vi.fn(),
  getInvocationId: vi.fn().mockReturnValue("test-inv"),
  trackPoint: vi.fn(),
  info: vi.fn(),
  track: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
};

const mockDb = {
  listExternalExchanges: vi.fn(),
};

const mockEncryptionManager = {
  decrypt: vi.fn().mockReturnValue("decrypted-password"),
  encrypt: vi.fn(),
  hash: vi.fn(),
};

const mockSignalQueue = {
  send: vi.fn(),
  sendToLongPoller: vi.fn(),
  sendBatch: vi.fn(),
};

function createWorker(): EmxIdleWorker {
  return new EmxIdleWorker({
    logger: mockLogger,
    db: mockDb as never,
    encryptionManager: mockEncryptionManager as never,
    signalQueue: mockSignalQueue as never,
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const imapExchange: ExternalMailExchange = {
  id: "emx-imap-1",
  accountId: "acc-1",
  platform: "imap",
  emailAddress: "test@example.com",
  status: "active",
  lastSyncAt: "2024-01-01T00:00:00.000Z",
  imapConfig: { host: "mail.example.com", tlsConfig: "TLS", username: "test@example.com", encryptedPassword: "encrypted" },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const jmapExchange: ExternalMailExchange = {
  id: "emx-jmap-1",
  accountId: "acc-1",
  platform: "jmap",
  emailAddress: "test@jmap.example.com",
  status: "active",
  syncCursor: "state-123",
  lastSyncAt: "2024-01-01T00:00:00.000Z",
  jmapConfig: { sessionUrl: "https://jmap.example.com/.well-known/jmap", username: "test", encryptedPassword: "encrypted", inboxId: "inbox-1", apiUrl: "https://jmap.example.com/api", downloadUrl: "https://jmap.example.com/download/{accountId}/{blobId}/{name}", jmapAccountId: "jmap-acc-1" },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Mock IMAP connection factory
// ---------------------------------------------------------------------------

function mockImapInstance(overrides?: { connect?: unknown; idle?: unknown; logout?: unknown }) {
  const instance = {
    connect: vi.fn().mockResolvedValue(ok(undefined)),
    idle: vi.fn().mockResolvedValue(ok("timeout" as const)),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.mocked(ImapConnection).mockImplementation(() => instance as never);
  return instance;
}

// ---------------------------------------------------------------------------
// Mock JMAP session
// ---------------------------------------------------------------------------

const jmapSession = {
  apiUrl: "https://jmap.example.com/api",
  downloadUrl: "https://jmap.example.com/download",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "jmap-acc-1" },
  capabilities: {},
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// IMAP tests
// ===========================================================================

describe("EmxIdleWorker — IMAP", () => {
  it("happy path: connection → IDLE → EXISTS → emx_dispatch enqueued", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange]));
    const conn = mockImapInstance({ idle: vi.fn().mockResolvedValue(ok("new_mail" as const)) });
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(conn.connect).toHaveBeenCalled();
    expect(conn.idle).toHaveBeenCalledWith(5 * 60 * 1000);
    expect(conn.logout).toHaveBeenCalled();
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-imap-1", accountId: "acc-1" });
  });

  it("timeout: connection → IDLE → 5-min timeout → clean exit, no enqueue", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange]));
    mockImapInstance({ idle: vi.fn().mockResolvedValue(ok("timeout" as const)) });
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });

  it("auth failure: connection rejected → WARN logged, exchange skipped, others continue", async () => {
    const imapExchange2 = { ...imapExchange, id: "emx-imap-2" };
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange, imapExchange2]));

    // First exchange: auth failure on connect. Second: happy path.
    let callCount = 0;
    vi.mocked(ImapConnection).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          connect: vi.fn().mockResolvedValue(err({ kind: "imap_error", reason: "Authentication failed", cause: new Error("AUTH") })),
          idle: vi.fn(),
          logout: vi.fn(),
        } as never;
      }
      return {
        connect: vi.fn().mockResolvedValue(ok(undefined)),
        idle: vi.fn().mockResolvedValue(ok("new_mail" as const)),
        logout: vi.fn().mockResolvedValue(undefined),
      } as never;
    });
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("IMAP connection failed"),
      expect.objectContaining({ emxId: "emx-imap-1" }),
    );
    // Second exchange still processed
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-imap-2", accountId: "acc-1" });
  });

  it("network failure: timeout/DNS/TLS error → WARN logged, exchange skipped", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange]));
    mockImapInstance({
      connect: vi.fn().mockResolvedValue(err({ kind: "imap_error", reason: "ETIMEDOUT", cause: new Error("ETIMEDOUT") })),
    });

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("IMAP connection failed"),
      expect.objectContaining({ emxId: "emx-imap-1" }),
    );
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });

  it("server drops connection mid-IDLE → WARN logged, clean exit", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange]));
    mockImapInstance({
      idle: vi.fn().mockResolvedValue(err({ kind: "imap_error", reason: "Connection reset", cause: new Error("ECONNRESET") })),
    });

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("connection dropped during IDLE"),
      expect.objectContaining({ emxId: "emx-imap-1" }),
    );
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });

  it("SQS enqueue failure after detecting mail → ERROR logged, exchange skipped", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange]));
    mockImapInstance({ idle: vi.fn().mockResolvedValue(ok("new_mail" as const)) });
    mockSignalQueue.send.mockResolvedValue(err({ kind: "db_error", message: "SQS failure", cause: new Error("SQS") }));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to enqueue emx_dispatch"),
      expect.objectContaining({ emxId: "emx-imap-1" }),
    );
  });
});

// ===========================================================================
// JMAP tests
// ===========================================================================

describe("EmxIdleWorker — JMAP", () => {
  it("first iteration finds messages → emx_dispatch enqueued, loop exits early", async () => {
    vi.useFakeTimers();
    mockDb.listExternalExchanges.mockResolvedValue(ok([jmapExchange]));
    vi.mocked(fetchSession).mockResolvedValue(ok(jmapSession) as never);
    vi.mocked(jmapCall).mockResolvedValue(ok([["Email/queryChanges", { added: [{ id: "msg-1", index: 0 }], removed: [], newQueryState: "state-124" }, "qc0"]]) as never);
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-jmap-1", accountId: "acc-1" });
    // Should NOT have waited between iterations (exited early on first)
    expect(jmapCall).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("last iteration finds messages → emx_dispatch enqueued", async () => {
    vi.useFakeTimers();
    mockDb.listExternalExchanges.mockResolvedValue(ok([jmapExchange]));
    vi.mocked(fetchSession).mockResolvedValue(ok(jmapSession) as never);

    // First 4 iterations: no changes. 5th iteration: new message.
    let iterationCount = 0;
    vi.mocked(jmapCall).mockImplementation(async () => {
      iterationCount++;
      if (iterationCount < 5) {
        return ok([["Email/queryChanges", { added: [], removed: [], newQueryState: "state-123" }, "qc0"]]) as never;
      }
      return ok([["Email/queryChanges", { added: [{ id: "msg-1", index: 0 }], removed: [], newQueryState: "state-124" }, "qc0"]]) as never;
    });
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const processPromise = worker.process({ accountId: "acc-1" });

    // Advance through the 4 sleep intervals (60s each)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    const result = await processPromise;
    expect(result.isOk()).toBe(true);
    expect(jmapCall).toHaveBeenCalledTimes(5);
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-jmap-1", accountId: "acc-1" });
    vi.useRealTimers();
  });

  it("all 5 iterations empty → clean exit", async () => {
    vi.useFakeTimers();
    mockDb.listExternalExchanges.mockResolvedValue(ok([jmapExchange]));
    vi.mocked(fetchSession).mockResolvedValue(ok(jmapSession) as never);
    vi.mocked(jmapCall).mockResolvedValue(ok([["Email/queryChanges", { added: [], removed: [], newQueryState: "state-123" }, "qc0"]]) as never);
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const processPromise = worker.process({ accountId: "acc-1" });

    // Advance through all sleep intervals
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    const result = await processPromise;
    expect(result.isOk()).toBe(true);
    expect(jmapCall).toHaveBeenCalledTimes(5);
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("HTTP timeout on one iteration → continues to next iteration", async () => {
    vi.useFakeTimers();
    mockDb.listExternalExchanges.mockResolvedValue(ok([jmapExchange]));
    vi.mocked(fetchSession).mockResolvedValue(ok(jmapSession) as never);

    let callNum = 0;
    vi.mocked(jmapCall).mockImplementation(async () => {
      callNum++;
      if (callNum === 1) {
        // First call: network timeout
        return err({ kind: "provider_renewal_failed", cause: "timeout" }) as never;
      }
      // Second call: finds messages
      return ok([["Email/queryChanges", { added: [{ id: "msg-1", index: 0 }], removed: [], newQueryState: "state-124" }, "qc0"]]) as never;
    });
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const processPromise = worker.process({ accountId: "acc-1" });

    // Advance past the sleep after iteration 1
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await processPromise;
    expect(result.isOk()).toBe(true);
    expect(jmapCall).toHaveBeenCalledTimes(2);
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-jmap-1", accountId: "acc-1" });
    vi.useRealTimers();
  });

  it("401 response (credentials rotated) → WARN logged, exchange skipped", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([jmapExchange]));
    vi.mocked(fetchSession).mockResolvedValue(err({ kind: "provider_activation_failed", cause: "invalid credentials" }) as never);

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("JMAP authentication failed"),
      expect.objectContaining({ emxId: "emx-jmap-1" }),
    );
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });

  it("cannotCalculateChanges → treated as new mail, triggers dispatch", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([jmapExchange]));
    vi.mocked(fetchSession).mockResolvedValue(ok(jmapSession) as never);
    vi.mocked(jmapCall).mockResolvedValue(ok([["error", { type: "cannotCalculateChanges" }, "qc0"]]) as never);
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-jmap-1", accountId: "acc-1" });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("cannotCalculateChanges"),
      expect.objectContaining({ emxId: "emx-jmap-1" }),
    );
  });
});

// ===========================================================================
// Mixed exchanges
// ===========================================================================

describe("EmxIdleWorker — mixed exchanges", () => {
  it("2 IMAP + 1 JMAP, one fails → partial success logged", async () => {
    const imap2 = { ...imapExchange, id: "emx-imap-2" };
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange, imap2, jmapExchange]));

    // IMAP: first fails connect, second detects new mail
    let imapCallCount = 0;
    vi.mocked(ImapConnection).mockImplementation(() => {
      imapCallCount++;
      if (imapCallCount === 1) {
        return {
          connect: vi.fn().mockResolvedValue(err({ kind: "imap_error", reason: "DNS failed", cause: new Error("ENOTFOUND") })),
          idle: vi.fn(),
          logout: vi.fn(),
        } as never;
      }
      return {
        connect: vi.fn().mockResolvedValue(ok(undefined)),
        idle: vi.fn().mockResolvedValue(ok("new_mail" as const)),
        logout: vi.fn().mockResolvedValue(undefined),
      } as never;
    });

    // JMAP: succeeds with new messages on first iteration
    vi.mocked(fetchSession).mockResolvedValue(ok(jmapSession) as never);
    vi.mocked(jmapCall).mockResolvedValue(ok([["Email/queryChanges", { added: [{ id: "msg-1", index: 0 }], removed: [], newQueryState: "state-124" }, "qc0"]]) as never);
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    // emx_dispatch sent for IMAP-2 and JMAP-1 (the two that succeeded)
    expect(mockSignalQueue.send).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("IMAP connection failed"),
      expect.objectContaining({ emxId: "emx-imap-1" }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("completed"),
      expect.objectContaining({ accountId: "acc-1" }),
    );
  });
});

// ===========================================================================
// Deduplication
// ===========================================================================

describe("EmxIdleWorker — deduplication", () => {
  it("lastSyncAt 2 min ago → skipped with INFO", async () => {
    const recentExchange = { ...imapExchange, lastSyncAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() };
    mockDb.listExternalExchanges.mockResolvedValue(ok([recentExchange]));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("skipping recently synced"),
      expect.objectContaining({ emxId: "emx-imap-1" }),
    );
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });

  it("lastSyncAt 6 min ago → processed normally", async () => {
    const oldExchange = { ...imapExchange, lastSyncAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() };
    mockDb.listExternalExchanges.mockResolvedValue(ok([oldExchange]));
    mockImapInstance({ idle: vi.fn().mockResolvedValue(ok("new_mail" as const)) });
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-imap-1", accountId: "acc-1" });
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe("EmxIdleWorker — edge cases", () => {
  it("zero IMAP/JMAP exchanges → immediate clean return", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([]));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("no IMAP/JMAP exchanges"),
      expect.objectContaining({ accountId: "acc-1" }),
    );
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });

  it("all exchanges skipped (all recently synced) → immediate clean return", async () => {
    const recent1 = { ...imapExchange, lastSyncAt: new Date(Date.now() - 60_000).toISOString() };
    const recent2 = { ...jmapExchange, lastSyncAt: new Date(Date.now() - 120_000).toISOString() };
    mockDb.listExternalExchanges.mockResolvedValue(ok([recent1, recent2]));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("all exchanges skipped"),
      expect.objectContaining({ accountId: "acc-1" }),
    );
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });
});
