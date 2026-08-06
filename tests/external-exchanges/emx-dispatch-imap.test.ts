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
  getExternalExchange: vi.fn(),
};

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
// IMAP skips getProviderToken
// ---------------------------------------------------------------------------

describe("IMAP skips getProviderToken", () => {
  it("does not call getProviderToken for IMAP platform", async () => {
    const emx = makeImapEmx();
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(ok(undefined));

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
      userId: "authress-user-9",
      connectionUserId: "google-sub-12345",
      connectionId: "google",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    mockDb.listExpiringExchanges.mockResolvedValue(ok([gmailEmx]));
    mockGetProviderToken.mockResolvedValue("oauth-token");
    vi.mocked(mockGmailAdapter.renew).mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    // Keyed on the Authress user who linked the mailbox — Authress returns no
    // credentials for an accountId, which is not a user at all.
    expect(mockGetProviderToken).toHaveBeenCalledWith("authress-user-9", "google");
  });
});

// ---------------------------------------------------------------------------
// Dispatch worker logs errors from adapters
// ---------------------------------------------------------------------------

describe("dispatch worker logs adapter errors", () => {
  it("logs error when IMAP renewal fails", async () => {
    const emx = makeImapEmx();
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(
      err({ kind: "provider_renewal_failed", cause: "invalid credentials" }),
    );

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "emx_dispatch: renewal failed",
      expect.objectContaining({ code: "emx.dispatch.renewal_failed", emxId: "emx_testABC123", platform: "imap" }),
    );
  });

  it("logs success when IMAP renewal succeeds", async () => {
    const emx = makeImapEmx();
    mockDb.listExpiringExchanges.mockResolvedValue(ok([emx]));
    vi.mocked(mockImapAdapter.renew).mockResolvedValue(ok(undefined));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "emx_dispatch: renewed successfully",
      expect.objectContaining({ code: "emx.dispatch.renewed", emxId: "emx_testABC123", platform: "imap" }),
    );
  });

  it("logs error when getProviderToken throws for Gmail", async () => {
    const gmailEmx: ExternalMailExchange = {
      id: "emx_gmail1",
      accountId: "acct-1",
      platform: "gmail",
      emailAddress: "user@gmail.com",
      status: "active",
      syncCursor: "12345",
      userId: "authress-user-9",
      connectionUserId: "google-sub-12345",
      connectionId: "google",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    mockDb.listExpiringExchanges.mockResolvedValue(ok([gmailEmx]));
    mockGetProviderToken.mockRejectedValue(new Error("token refresh failed"));

    const worker = createWorker();
    const result = await worker.dispatch();

    expect(result.isOk()).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      "emx_dispatch: failed to get provider token",
      expect.objectContaining({ code: "emx.dispatch.token_failed", emxId: "emx_gmail1", platform: "gmail" }),
    );
  });
});
