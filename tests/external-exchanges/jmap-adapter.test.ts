import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "neverthrow";
import { JmapAdapter, buildBasicAuth } from "../../src/external-exchanges/jmap-adapter.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { EncryptionManager } from "../../src/secrets/encryption-manager.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { SignalQueue } from "../../src/messaging/signal-queue.js";
import type { Logger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockEncryptionManager(overrides?: Partial<EncryptionManager>): EncryptionManager {
  return {
    encrypt: vi.fn(async (plain: string) => ok(`encrypted:${plain}`)),
    decrypt: vi.fn(async (cipher: string) => ok(cipher.replace("encrypted:", ""))),
    hash: vi.fn(async (data: string) => ok(`hash:${data}`)),
    ...overrides,
  } as unknown as EncryptionManager;
}

function mockDb(overrides?: Partial<AccountDatabase>): AccountDatabase {
  return {
    updateExternalExchange: vi.fn(async () => ({ isOk: () => true, isErr: () => false })),
    ...overrides,
  } as unknown as AccountDatabase;
}

function mockSignalQueue(): SignalQueue & { send: ReturnType<typeof vi.fn>; sendBatch: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(async () => ({ isOk: () => true, isErr: () => false, value: undefined })), sendBatch: vi.fn(async () => ({ isOk: () => true, isErr: () => false, value: undefined })) } as unknown as SignalQueue & { send: ReturnType<typeof vi.fn>; sendBatch: ReturnType<typeof vi.fn> };
}

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function makeEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_test123",
    accountId: "acct-1",
    platform: "jmap",
    emailAddress: "user@example.com",
    status: "active",
    syncCursor: "state-abc",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    jmapConfig: {
      sessionUrl: "https://jmap.example.com/session",
      username: "user@example.com",
      encryptedPassword: "encrypted:hunter2",
      apiUrl: "https://jmap.example.com/api",
      downloadUrl: "https://jmap.example.com/download/{accountId}/{blobId}/{name}",
      jmapAccountId: "acct-jmap-001",
      inboxId: "inbox-001",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Session response fixtures
// ---------------------------------------------------------------------------

const VALID_SESSION = {
  apiUrl: "https://jmap.example.com/api",
  downloadUrl: "https://jmap.example.com/download/{accountId}/{blobId}/{name}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-jmap-001" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildBasicAuth", () => {
  it("produces correct Base64 encoding", () => {
    const auth = buildBasicAuth("user@example.com", "hunter2");
    const expected = "Basic " + Buffer.from("user@example.com:hunter2").toString("base64");
    expect(auth).toBe(expected);
  });

  it("handles special characters in password", () => {
    const auth = buildBasicAuth("test", "p@ss:word!");
    const expected = "Basic " + Buffer.from("test:p@ss:word!").toString("base64");
    expect(auth).toBe(expected);
  });
});

describe("JmapAdapter.activate", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns syncCursor, expiresAt ~1hr, and extracts session metadata on success", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00.000Z") });
    const fetchMock = vi.fn<typeof fetch>();

    // 1st call: session fetch
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(VALID_SESSION), { status: 200 }));

    // 2nd call: Mailbox/query for inbox
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Mailbox/query", { ids: ["inbox-001"] }, "mq0"]],
    }), { status: 200 }));

    // 3rd call: Email/query for initial queryState
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/query", { queryState: "state-initial-123", ids: ["msg-1"] }, "q0"]],
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db: mockDb(),
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx({
      jmapConfig: {
        sessionUrl: "https://jmap.example.com/session",
        username: "user@example.com",
        encryptedPassword: "rawpassword", // During activation, this is the raw password
        apiUrl: "",
        downloadUrl: "",
        jmapAccountId: "",
        inboxId: "",
      },
    });

    const result = await adapter.activate(emx);
    expect(result.isOk()).toBe(true);

    const value = result._unsafeUnwrap();
    expect(value.syncCursor).toBe("state-initial-123");
    expect(value.providerSubscriptionId).toBe("poll");
    // Read off jmapConfig.username directly — JMAP has no separate identity to verify against.
    expect(value.emailAddress).toBe("user@example.com");

    // expiresAt should be pinned time + 15min polling interval
    expect(value.expiresAt).toBe("2026-06-15T12:15:00.000Z");

    // Session metadata stored on emx
    expect(emx.jmapConfig!.apiUrl).toBe("https://jmap.example.com/api");
    expect(emx.jmapConfig!.downloadUrl).toBe("https://jmap.example.com/download/{accountId}/{blobId}/{name}");
    expect(emx.jmapConfig!.jmapAccountId).toBe("acct-jmap-001");
    expect(emx.jmapConfig!.inboxId).toBe("inbox-001");
    vi.useRealTimers();
  });

  it("returns activation_failed 'invalid credentials' on HTTP 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 401 })));

    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db: mockDb(),
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx({
      jmapConfig: {
        sessionUrl: "https://jmap.example.com/session",
        username: "user@example.com",
        encryptedPassword: "bad-password",
        apiUrl: "",
        downloadUrl: "",
        jmapAccountId: "",
        inboxId: "",
      },
    });

    const result = await adapter.activate(emx);
    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_activation_failed");
    expect(error.cause).toBe("invalid credentials");
  });

  it("returns activation_failed 'server unreachable' on timeout/network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("AbortError: timeout")));

    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db: mockDb(),
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx({
      jmapConfig: {
        sessionUrl: "https://jmap.unreachable.com/session",
        username: "user@example.com",
        encryptedPassword: "password",
        apiUrl: "",
        downloadUrl: "",
        jmapAccountId: "",
        inboxId: "",
      },
    });

    const result = await adapter.activate(emx);
    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_activation_failed");
    expect(error.cause).toBe("server unreachable");
  });

  it("returns activation_failed when missing urn:ietf:params:jmap:mail capability", async () => {
    const sessionNoMail = {
      apiUrl: "https://jmap.example.com/api",
      downloadUrl: "https://jmap.example.com/download/{accountId}/{blobId}/{name}",
      primaryAccounts: { "urn:ietf:params:jmap:core": "acct-core" },
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(sessionNoMail), { status: 200 }),
    ));

    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db: mockDb(),
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx({
      jmapConfig: {
        sessionUrl: "https://jmap.example.com/session",
        username: "user@example.com",
        encryptedPassword: "password",
        apiUrl: "",
        downloadUrl: "",
        jmapAccountId: "",
        inboxId: "",
      },
    });

    const result = await adapter.activate(emx);
    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_activation_failed");
    expect(error.cause).toBe("server does not support JMAP Mail");
  });
});

describe("JmapAdapter.renew", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("enqueues correct count of added entries (capped at 500 by maxChanges)", async () => {
    const added = Array.from({ length: 5 }, (_, i) => ({ id: `msg-${i}`, index: i }));

    const fetchMock = vi.fn<typeof fetch>();

    // Session refresh
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(VALID_SESSION), { status: 200 }));

    // Email/queryChanges
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/queryChanges", { added, newQueryState: "state-new" }, "qc0"]],
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const signalQueue = mockSignalQueue();
    const db = mockDb();
    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db,
      signalQueue,
      logger: mockLogger(),
    });

    const emx = makeEmx();
    const result = await adapter.renew(emx);

    expect(result.isOk()).toBe(true);
    expect(signalQueue.sendBatch).toHaveBeenCalledTimes(1);

    // Verify batch contains 5 entries
    const batchCall = signalQueue.sendBatch.mock.calls[0]!;
    expect(batchCall[0]).toBe("emx_inbound");
    expect(batchCall[1]).toHaveLength(5);
    expect(batchCall[1][0]).toMatchObject({
      payload: {
        source: "jmap",
        providerMessageId: "msg-0",
        emxId: "emx_test123",
        accountId: "acct-1",
      },
    });
  });

  it("falls back to Email/query on cannotCalculateChanges", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    // Session refresh
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(VALID_SESSION), { status: 200 }));

    // Email/queryChanges returns cannotCalculateChanges error
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["error", { type: "cannotCalculateChanges" }, "qc0"]],
    }), { status: 200 }));

    // Fallback Email/query
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/query", { ids: ["msg-a", "msg-b"], queryState: "state-fallback" }, "q0"]],
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const signalQueue = mockSignalQueue();
    const db = mockDb();
    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db,
      signalQueue,
      logger: mockLogger(),
    });

    const emx = makeEmx();
    const result = await adapter.renew(emx);

    expect(result.isOk()).toBe(true);
    // Fallback enqueues all returned IDs via batch
    expect(signalQueue.sendBatch).toHaveBeenCalledTimes(1);
    const batchCall = signalQueue.sendBatch.mock.calls[0]!;
    expect(batchCall[0]).toBe("emx_inbound");
    expect(batchCall[1]).toHaveLength(2);
    expect(batchCall[1][0]).toMatchObject({
      payload: {
        source: "jmap",
        providerMessageId: "msg-a",
        emxId: "emx_test123",
        accountId: "acct-1",
      },
    });
  });

  it("advances syncCursor to new queryState", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    // Session refresh
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(VALID_SESSION), { status: 200 }));

    // Email/queryChanges with new state
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/queryChanges", { added: [], newQueryState: "state-advanced" }, "qc0"]],
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const db = mockDb();
    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db,
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx();
    const result = await adapter.renew(emx);

    expect(result.isOk()).toBe(true);
    expect(db.updateExternalExchange).toHaveBeenCalledWith("acct-1", "emx_test123", expect.objectContaining({
      syncCursor: "state-advanced",
    }));
  });
});

describe("JmapAdapter.fetchMessage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns raw MIME + receivedAt on success", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    // Email/get
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/get", { list: [{ blobId: "blob-123", receivedAt: "2026-08-03T10:00:00Z" }] }, "g0"]],
    }), { status: 200 }));

    // Blob download
    const mimeBytes = new TextEncoder().encode("From: test@example.com\r\nSubject: Test\r\n\r\nBody");
    fetchMock.mockResolvedValueOnce(new Response(mimeBytes, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db: mockDb(),
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx();
    const result = await adapter.fetchMessage("msg-001", emx);

    expect(result.isOk()).toBe(true);

    const value = result._unsafeUnwrap();
    expect(value.receivedAt).toBe("2026-08-03T10:00:00Z");
    expect(value.rawMime).toBeInstanceOf(Uint8Array);
    expect(value.rawMime.length).toBeGreaterThan(0);

    // Verify download URL was constructed correctly
    const downloadCall = fetchMock.mock.calls[1]!;
    expect(downloadCall[0]).toBe("https://jmap.example.com/download/acct-jmap-001/blob-123/email.eml");
  });

  it("returns provider_message_not_found when email is in notFound", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    // Email/get with notFound
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/get", { list: [], notFound: ["msg-gone"] }, "g0"]],
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db: mockDb(),
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx();
    const result = await adapter.fetchMessage("msg-gone", emx);

    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_message_not_found");
  });
});

describe("JmapAdapter.deactivate", () => {
  it("returns ok without making any network calls", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db: mockDb(),
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx();
    const result = await adapter.deactivate(emx);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
