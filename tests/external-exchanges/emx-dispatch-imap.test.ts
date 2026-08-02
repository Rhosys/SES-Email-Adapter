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

const mockImapAdapter: ProviderAdapter = {
  activate: vi.fn(),
  renew: vi.fn(),
  deactivate: vi.fn(),
  fetchMessage: vi.fn(),
};

const mockGmailAdapter: ProviderAdapter = {
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
    adapters: { imap: mockImapAdapter, gmail: mockGmailAdapter },
    getProviderToken: mockGetProviderToken,
  });
}

function makeImapEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_testABC123",
    accountId: "acct-1",
    platform: "imap",
    emailAddress: "user@example.com",
    status: "active",
    syncCursor: "123:42",
    imapConfig: {
      host: "imap.example.com",
      tlsConfig: "TLS",
      username: "user@example.com",
      encryptedPassword: "base64-encrypted-blob",
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
// Requirement 9.1: IMAP skips getProviderToken
// ---------------------------------------------------------------------------

describe("IMAP skips getProviderToken", () => {
  it("does not call getProviderToken for IMAP platform", async () => {
    const emx = makeImapEmx();
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(ok({ expiresAt: "2025-07-01T12:00:00Z" }));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockGetProviderToken).not.toHaveBeenCalled();
    expect(mockImapAdapter.renew).toHaveBeenCalledWith("", emx);
  });

  it("calls getProviderToken for gmail platform", async () => {
    const gmailEmx: ExternalMailExchange = {
      id: "emx_gmail1",
      accountId: "acct-1",
      platform: "gmail",
      emailAddress: "user@gmail.com",
      status: "active",
      syncCursor: "12345",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    mockDb.listExpiringExchanges.mockResolvedValue(ok([gmailEmx]));
    mockGetProviderToken.mockResolvedValue("oauth-token");
    vi.mocked(mockGmailAdapter.renew).mockResolvedValue(ok({ expiresAt: "2025-07-01T12:00:00Z" }));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockGetProviderToken).toHaveBeenCalledWith("acct-1", "google");
  });
});

// ---------------------------------------------------------------------------
// Requirement 9.5: Consecutive failure counter increments on auth failure
// ---------------------------------------------------------------------------

describe("consecutiveFailures increment on renewal error", () => {
  it("increments consecutiveFailures by 1 on IMAP renewal failure", async () => {
    const emx = makeImapEmx({ consecutiveFailures: 0 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      { consecutiveFailures: 1 },
    );
  });

  it("increments from existing value (1 → 2)", async () => {
    const emx = makeImapEmx({ consecutiveFailures: 1 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      { consecutiveFailures: 2 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: 3rd consecutive failure transitions to activation_failed
// Validates: Requirements 9.4
// ---------------------------------------------------------------------------

describe("3rd consecutive failure deactivates EMX (Property 5)", () => {
  it("sets status to activation_failed when consecutiveFailures reaches 3", async () => {
    const emx = makeImapEmx({ consecutiveFailures: 2 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      expect.objectContaining({
        status: "activation_failed",
        consecutiveFailures: 3,
        errorReason: "invalid credentials",
      }),
    );
  });

  it("does NOT set activation_failed when failures < 3", async () => {
    const emx = makeImapEmx({ consecutiveFailures: 1 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      { consecutiveFailures: 2 },
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 9.2: Successful sync resets consecutiveFailures to 0
// ---------------------------------------------------------------------------

describe("successful sync resets consecutiveFailures", () => {
  it("sets consecutiveFailures to 0 on renewal success", async () => {
    const emx = makeImapEmx({ consecutiveFailures: 2 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(ok({ expiresAt: "2025-07-01T12:00:00Z" }));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      { expiresAt: "2025-07-01T12:00:00Z", consecutiveFailures: 0 },
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 9.4: GSI1 keys removed on deactivation
// The DB method's logic: when status !== "active", it adds REMOVE gsi1pk, gsi1sk.
// We verify the dispatcher passes status: "activation_failed" — which triggers removal.
// ---------------------------------------------------------------------------

describe("GSI1 keys removed on deactivation", () => {
  it("passes status=activation_failed to updateExternalExchange (triggers GSI1 removal)", async () => {
    const emx = makeImapEmx({ consecutiveFailures: 2 });
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "credentials expired" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      expect.objectContaining({ status: "activation_failed" }),
    );
  });
});
