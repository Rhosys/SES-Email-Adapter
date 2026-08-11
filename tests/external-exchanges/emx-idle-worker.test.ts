import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "neverthrow";
import { EmxIdleWorker } from "../../src/external-exchanges/emx-idle-worker.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { Logger } from "../../src/logger.js";

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

const mockImapAdapter = {
  idle: vi.fn(),
};

const mockJmapAdapter = {
  poll: vi.fn(),
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
    imapAdapter: mockImapAdapter as never,
    jmapAdapter: mockJmapAdapter as never,
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
  it("happy path: IDLE detects new mail → emx_dispatch enqueued", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange]));
    mockImapAdapter.idle.mockResolvedValue(ok("new_mail" as const));
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockImapAdapter.idle).toHaveBeenCalledWith(imapExchange, 5 * 60 * 1000);
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-imap-1", accountId: "acc-1" });
  });

  it("timeout: IDLE times out → clean exit, no enqueue", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange]));
    mockImapAdapter.idle.mockResolvedValue(ok("timeout" as const));
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });

  it("connection failure → WARN logged, exchange skipped, others continue", async () => {
    const imapExchange2 = { ...imapExchange, id: "emx-imap-2" };
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange, imapExchange2]));

    mockImapAdapter.idle
      .mockResolvedValueOnce(err({ kind: "imap_error", reason: "Authentication failed", cause: new Error("AUTH") }))
      .mockResolvedValueOnce(ok("new_mail" as const));
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("IMAP connection failed"),
      expect.objectContaining({ emxId: "emx-imap-1" }),
    );
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-imap-2", accountId: "acc-1" });
  });

  it("network failure → WARN logged, exchange skipped", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange]));
    mockImapAdapter.idle.mockResolvedValue(err({ kind: "imap_error", reason: "ETIMEDOUT", cause: new Error("ETIMEDOUT") }));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("IMAP connection failed"),
      expect.objectContaining({ emxId: "emx-imap-1" }),
    );
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });

  it("SQS enqueue failure after detecting mail → ERROR logged", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange]));
    mockImapAdapter.idle.mockResolvedValue(ok("new_mail" as const));
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
  it("poll finds messages → emx_dispatch enqueued", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([jmapExchange]));
    mockJmapAdapter.poll.mockResolvedValue(ok("new_mail" as const));
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockJmapAdapter.poll).toHaveBeenCalledWith(jmapExchange, 5, 60_000);
    expect(mockSignalQueue.send).toHaveBeenCalledWith("emx_dispatch", { emxId: "emx-jmap-1", accountId: "acc-1" });
  });

  it("poll times out → clean exit", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([jmapExchange]));
    mockJmapAdapter.poll.mockResolvedValue(ok("timeout" as const));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });

  it("401 response (credentials rotated) → WARN logged, exchange skipped", async () => {
    mockDb.listExternalExchanges.mockResolvedValue(ok([jmapExchange]));
    mockJmapAdapter.poll.mockResolvedValue(err({ kind: "provider_renewal_failed", cause: "invalid credentials" }));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("JMAP authentication failed"),
      expect.objectContaining({ emxId: "emx-jmap-1" }),
    );
    expect(mockSignalQueue.send).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Mixed exchanges
// ===========================================================================

describe("EmxIdleWorker — mixed exchanges", () => {
  it("2 IMAP + 1 JMAP, one fails → partial success logged", async () => {
    const imap2 = { ...imapExchange, id: "emx-imap-2" };
    mockDb.listExternalExchanges.mockResolvedValue(ok([imapExchange, imap2, jmapExchange]));

    mockImapAdapter.idle
      .mockResolvedValueOnce(err({ kind: "imap_error", reason: "DNS failed", cause: new Error("ENOTFOUND") }))
      .mockResolvedValueOnce(ok("new_mail" as const));
    mockJmapAdapter.poll.mockResolvedValue(ok("new_mail" as const));
    mockSignalQueue.send.mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.process({ accountId: "acc-1" });

    expect(result.isOk()).toBe(true);
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
    mockImapAdapter.idle.mockResolvedValue(ok("new_mail" as const));
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
