import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { EmxDispatchWorker } from "../../src/external-exchanges/emx-dispatch-worker.js";
import type { ProviderAdapter } from "../../src/external-exchanges/provider-adapter.js";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { Logger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockLogger: Logger = {
  startInvocation: vi.fn(),
  getInvocationId: vi.fn().mockReturnValue("test"),
  trackPoint: vi.fn(),
  info: vi.fn(),
  track: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
};

const mockDb = {
  listExpiringExchanges: vi.fn(),
  updateExternalExchange: vi.fn().mockResolvedValue(ok({} as ExternalMailExchange)),
};

const mockSignalQueue = { send: vi.fn().mockResolvedValue(ok(undefined)) };

const mockJmapAdapter: ProviderAdapter = {
  activate: vi.fn(),
  renew: vi.fn(),
  deactivate: vi.fn(),
  fetchMessage: vi.fn(),
};

const mockGetProviderToken = vi.fn();

function createWorker(): EmxDispatchWorker {
  return new EmxDispatchWorker({
    logger: mockLogger,
    db: mockDb as never,
    signalQueue: mockSignalQueue as never,
    adapters: { jmap: mockJmapAdapter },
    getProviderToken: mockGetProviderToken,
  });
}

function makeJmapEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_jmapABC123",
    accountId: "acct-1",
    platform: "jmap",
    emailAddress: "user@fastmail.com",
    status: "active",
    syncCursor: "queryState-abc",
    jmapConfig: {
      sessionUrl: "https://api.fastmail.com/jmap/session",
      username: "user@fastmail.com",
      encryptedPassword: "base64-encrypted-blob",
      apiUrl: "https://api.fastmail.com/jmap/api",
      downloadUrl: "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}",
      jmapAccountId: "u12345",
      inboxId: "inbox-001",
    },
    consecutiveFailures: 0,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// JMAP skips getProviderToken (token = "")
// ---------------------------------------------------------------------------

describe("JMAP skips getProviderToken", () => {
  it("does not call getProviderToken for JMAP platform", async () => {
    const emx = makeJmapEmx();
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockJmapAdapter.renew).mockResolvedValue(ok({ expiresAt: "2025-07-01T12:00:00Z" }));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockGetProviderToken).not.toHaveBeenCalled();
    expect(mockJmapAdapter.renew).toHaveBeenCalledWith("", emx);
  });
});

// ---------------------------------------------------------------------------
// consecutiveFailures increments on failure
// ---------------------------------------------------------------------------

describe("consecutiveFailures increments on JMAP renewal error", () => {
  it("increments consecutiveFailures by 1 on JMAP renewal failure", async () => {
    const emx = makeJmapEmx({ consecutiveFailures: 0 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockJmapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_jmapABC123",
      { consecutiveFailures: 1 },
    );
  });

  it("increments from existing value (1 → 2)", async () => {
    const emx = makeJmapEmx({ consecutiveFailures: 1 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockJmapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_jmapABC123",
      { consecutiveFailures: 2 },
    );
  });
});

// ---------------------------------------------------------------------------
// 3rd failure transitions to activation_failed
// ---------------------------------------------------------------------------

describe("3rd consecutive failure deactivates JMAP EMX", () => {
  it("sets status to activation_failed when consecutiveFailures reaches 3", async () => {
    const emx = makeJmapEmx({ consecutiveFailures: 2 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockJmapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_jmapABC123",
      expect.objectContaining({
        status: "activation_failed",
        consecutiveFailures: 3,
        errorReason: "invalid credentials",
      }),
    );
  });

  it("does NOT set activation_failed when failures < 3", async () => {
    const emx = makeJmapEmx({ consecutiveFailures: 1 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockJmapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_jmapABC123",
      { consecutiveFailures: 2 },
    );
  });
});

// ---------------------------------------------------------------------------
// Success resets consecutiveFailures to 0
// ---------------------------------------------------------------------------

describe("successful JMAP sync resets consecutiveFailures", () => {
  it("sets consecutiveFailures to 0 on renewal success", async () => {
    const emx = makeJmapEmx({ consecutiveFailures: 2 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockJmapAdapter.renew).mockResolvedValue(ok({ expiresAt: "2025-07-01T12:00:00Z" }));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_jmapABC123",
      { expiresAt: "2025-07-01T12:00:00Z", consecutiveFailures: 0 },
    );
  });
});
