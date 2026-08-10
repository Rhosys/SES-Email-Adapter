import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JmapAdapter } from "../../src/external-exchanges/jmap-adapter.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { EncryptionManager } from "../../src/secrets/encryption-manager.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import type { SignalQueue } from "../../src/messaging/signal-queue.js";
import type { Logger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Mocks (mirrors jmap-adapter.test.ts patterns)
// ---------------------------------------------------------------------------

function mockEncryptionManager(): EncryptionManager {
  return {
    encrypt: vi.fn((plain: string) => `encrypted:${plain}`),
    decrypt: vi.fn((cipher: string) => cipher.replace("encrypted:", "")),
    hash: vi.fn((data: string) => `hmac_${data}`),
  } as unknown as EncryptionManager;
}

function mockDb(): AccountDatabase & { updateExternalExchange: ReturnType<typeof vi.fn> } {
  return {
    updateExternalExchange: vi.fn(async () => ({ isOk: () => true, isErr: () => false })),
  } as unknown as AccountDatabase & { updateExternalExchange: ReturnType<typeof vi.fn> };
}

function mockSignalQueue(): SignalQueue & { send: ReturnType<typeof vi.fn>; sendBatch: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async () => ({ isOk: () => true, isErr: () => false, value: undefined })),
    sendBatch: vi.fn(async () => ({ isOk: () => true, isErr: () => false, value: undefined })),
  } as unknown as SignalQueue & { send: ReturnType<typeof vi.fn>; sendBatch: ReturnType<typeof vi.fn> };
}

function mockLogger(): Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function makeEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_jmap1",
    accountId: "acct-1",
    platform: "jmap",
    emailAddress: "user@jmap.example.com",
    status: "active",
    syncCursor: "state-123",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    jmapConfig: {
      sessionUrl: "https://jmap.example.com/session",
      username: "user@jmap.example.com",
      encryptedPassword: "encrypted:hunter2",
      apiUrl: "https://jmap.example.com/api",
      downloadUrl: "https://jmap.example.com/download/{accountId}/{blobId}/{name}",
      jmapAccountId: "acct-jmap-001",
      inboxId: "inbox-001",
    },
    ...overrides,
  };
}

// Session with push capability (urn:ietf:params:jmap:core triggers supportsPush)
const SESSION_WITH_PUSH = {
  apiUrl: "https://jmap.example.com/api",
  downloadUrl: "https://jmap.example.com/download/{accountId}/{blobId}/{name}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-jmap-001" },
  capabilities: {
    "urn:ietf:params:jmap:core": {},
    "urn:ietf:params:jmap:mail": {},
  },
};

// Session without push — no key contains "push" and no "urn:ietf:params:jmap:core"
const SESSION_NO_PUSH = {
  apiUrl: "https://jmap.example.com/api",
  downloadUrl: "https://jmap.example.com/download/{accountId}/{blobId}/{name}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "acct-jmap-001" },
  capabilities: {
    "urn:ietf:params:jmap:mail": {},
  },
};

// ---------------------------------------------------------------------------
// Tests: JMAP Push Subscription registration (R7.36)
// ---------------------------------------------------------------------------

describe("JMAP push subscription registration", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("registration succeeds → pushSubscriptionId stored, nextSyncTime +4d", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    // 1. Session fetch
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(SESSION_WITH_PUSH), { status: 200 }));

    // 2. PushSubscription/set → created
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["PushSubscription/set", { created: { push0: { id: "new-push-id" } } }, "ps0"]],
    }), { status: 200 }));

    // 3. Email/queryChanges (doQueryChangesSync)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/queryChanges", { added: [], newQueryState: "state-456" }, "qc0"]],
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

    // First updateExternalExchange stores pushSubscriptionId + nextSyncTime ~+4d
    const firstUpdate = db.updateExternalExchange.mock.calls[0]!;
    expect(firstUpdate[0]).toBe("acct-1");
    expect(firstUpdate[1]).toBe("emx_jmap1");
    expect(firstUpdate[2]).toMatchObject({ pushSubscriptionId: "new-push-id" });

    const nextSyncTime = new Date(firstUpdate[2].nextSyncTime).getTime();
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    expect(nextSyncTime).toBeGreaterThan(now + fourDaysMs - 10_000);
    expect(nextSyncTime).toBeLessThan(now + fourDaysMs + 10_000);
  });

  it("registration fails (HTTP error) → fall through to 15-min polling, WARN logged", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    // 1. Session fetch
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(SESSION_WITH_PUSH), { status: 200 }));

    // 2. PushSubscription/set → network failure
    fetchMock.mockRejectedValueOnce(new Error("connection reset"));

    // 3. Email/queryChanges (normal polling path after fallthrough)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/queryChanges", { added: [], newQueryState: "state-789" }, "qc0"]],
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const db = mockDb();
    const logger = mockLogger();
    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db,
      signalQueue: mockSignalQueue(),
      logger,
    });

    const emx = makeEmx();
    const result = await adapter.renew(emx);

    expect(result.isOk()).toBe(true);

    // WARN logged about push registration failure
    expect(logger.warn).toHaveBeenCalledWith(
      "JMAP push registration failed",
      expect.objectContaining({ code: "jmap.push.registration_failed", emxId: "emx_jmap1" }),
    );

    // Polling path updates syncCursor with 15-min nextSyncTime
    const pollingUpdate = db.updateExternalExchange.mock.calls.find((call: unknown[]) => {
      const fields = call[2] as Record<string, unknown>;
      return fields.syncCursor !== undefined;
    });
    expect(pollingUpdate).toBeDefined();

    const pollingNextSync = new Date((pollingUpdate![2] as Record<string, string>).nextSyncTime!).getTime();
    const fifteenMinMs = 15 * 60 * 1000;
    const now = Date.now();
    expect(pollingNextSync).toBeGreaterThan(now + fifteenMinMs - 10_000);
    expect(pollingNextSync).toBeLessThan(now + fifteenMinMs + 10_000);
  });

  it("server does not support push → no registration, 15-min polling", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    // 1. Session fetch — capabilities lack push indicators
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(SESSION_NO_PUSH), { status: 200 }));

    // 2. Email/queryChanges (goes straight to polling — no push attempt)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/queryChanges", { added: [], newQueryState: "state-no-push" }, "qc0"]],
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

    // Only 2 fetch calls: session + queryChanges (no PushSubscription/set)
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // db updated with 15-min nextSyncTime
    expect(db.updateExternalExchange).toHaveBeenCalledWith("acct-1", "emx_jmap1", expect.objectContaining({
      syncCursor: "state-no-push",
    }));

    const fields = db.updateExternalExchange.mock.calls[0]![2] as Record<string, string>;
    const nextSync = new Date(fields.nextSyncTime!).getTime();
    const fifteenMinMs = 15 * 60 * 1000;
    const now = Date.now();
    expect(nextSync).toBeGreaterThan(now + fifteenMinMs - 10_000);
    expect(nextSync).toBeLessThan(now + fifteenMinMs + 10_000);
  });

  it("existing pushSubscriptionId still active → renewed, nextSyncTime +4d", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    // 1. Session fetch
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(SESSION_WITH_PUSH), { status: 200 }));

    // 2. PushSubscription/get → subscription found (not in notFound)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["PushSubscription/get", { list: [{ id: "existing-push-id" }], notFound: [] }, "pg0"]],
    }), { status: 200 }));

    // 3. Email/queryChanges (doQueryChangesSync)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/queryChanges", { added: [], newQueryState: "state-renewed" }, "qc0"]],
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const db = mockDb();
    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db,
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx({ pushSubscriptionId: "existing-push-id" });
    const result = await adapter.renew(emx);

    expect(result.isOk()).toBe(true);

    // First updateExternalExchange renews nextSyncTime to +4d
    const firstUpdate = db.updateExternalExchange.mock.calls[0]!;
    expect(firstUpdate[0]).toBe("acct-1");
    expect(firstUpdate[1]).toBe("emx_jmap1");
    expect(firstUpdate[2]).toMatchObject({ consecutiveFailures: 0 });

    const nextSyncTime = new Date(firstUpdate[2].nextSyncTime).getTime();
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    expect(nextSyncTime).toBeGreaterThan(now + fourDaysMs - 10_000);
    expect(nextSyncTime).toBeLessThan(now + fourDaysMs + 10_000);
  });

  it("existing pushSubscriptionId gone (server forgot) → cleared, falls through to polling", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    // 1. Session fetch
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(SESSION_WITH_PUSH), { status: 200 }));

    // 2. PushSubscription/get → notFound
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["PushSubscription/get", { list: [], notFound: ["old-push-id"] }, "pg0"]],
    }), { status: 200 }));

    // 3. Email/queryChanges (polling fallthrough)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      methodResponses: [["Email/queryChanges", { added: [], newQueryState: "state-after-clear" }, "qc0"]],
    }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const db = mockDb();
    const adapter = new JmapAdapter({
      encryptionManager: mockEncryptionManager(),
      db,
      signalQueue: mockSignalQueue(),
      logger: mockLogger(),
    });

    const emx = makeEmx({ pushSubscriptionId: "old-push-id" });
    const result = await adapter.renew(emx);

    expect(result.isOk()).toBe(true);

    // First db call clears pushSubscriptionId
    const clearCall = db.updateExternalExchange.mock.calls[0]!;
    expect(clearCall[2]).toMatchObject({ pushSubscriptionId: undefined });

    // Second db call is normal polling sync with 15-min nextSyncTime
    const pollingCall = db.updateExternalExchange.mock.calls[1]!;
    expect(pollingCall[2]).toMatchObject({ syncCursor: "state-after-clear" });

    const nextSync = new Date(pollingCall[2].nextSyncTime).getTime();
    const fifteenMinMs = 15 * 60 * 1000;
    const now = Date.now();
    expect(nextSync).toBeGreaterThan(now + fifteenMinMs - 10_000);
    expect(nextSync).toBeLessThan(now + fifteenMinMs + 10_000);
  });
});
