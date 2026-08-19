import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { Logger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Mock imapflow — must be before ImapAdapter import
// ---------------------------------------------------------------------------

const mockMailbox = { uidValidity: BigInt(123), uidNext: 43, exists: 42 };
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  mailboxOpen: vi.fn().mockResolvedValue(mockMailbox),
  logout: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
  fetchOne: vi.fn().mockResolvedValue(null),
  mailbox: mockMailbox,
};

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => mockClient),
}));

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

const mockEncryptionManager = {
  decrypt: vi.fn().mockResolvedValue(ok("decrypted-password")),
  encrypt: vi.fn().mockResolvedValue(ok("encrypted")),
  hash: vi.fn().mockResolvedValue(ok("hashed")),
  init: vi.fn().mockResolvedValue(undefined),
};

const mockDb = {
  getExternalExchange: vi.fn(),
  updateExternalExchange: vi.fn().mockResolvedValue(ok({} as ExternalMailExchange)),
};

const mockSignalQueue = {
  send: vi.fn().mockResolvedValue(ok(undefined)),
  sendBatch: vi.fn().mockResolvedValue(ok(undefined)),
};

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

// ---------------------------------------------------------------------------
// Import adapter (after mocks)
// ---------------------------------------------------------------------------

import { ImapAdapter } from "../../src/external-exchanges/imap-adapter.js";

function createAdapter(): ImapAdapter {
  return new ImapAdapter({
    encryptionManager: mockEncryptionManager as never,
    db: mockDb as never,
    signalQueue: mockSignalQueue as never,
    logger: mockLogger,
  });
}

function makeEmx(overrides?: Partial<ExternalMailExchange>): ExternalMailExchange {
  return {
    id: "emx_testABC123",
    accountId: "acct-1",
    platform: "imap",
    emailAddress: "user@example.com",
    status: "active",
    imapConfig: {
      host: "imap.example.com",
      tlsConfig: "TLS",
      username: "user@example.com",
      encryptedPassword: "base64-encrypted-blob",
    },
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset mailbox to defaults
  mockMailbox.uidValidity = BigInt(123);
  mockMailbox.uidNext = 43;
  mockMailbox.exists = 42;
  mockClient.connect.mockResolvedValue(undefined);
  mockClient.mailboxOpen.mockResolvedValue(mockMailbox);
  mockClient.logout.mockResolvedValue(undefined);
  mockClient.search.mockResolvedValue([]);
  mockClient.fetchOne.mockResolvedValue(null);
  (mockClient as { mailbox: typeof mockMailbox }).mailbox = mockMailbox;
});

describe("ImapAdapter.activate", () => {
  it("returns syncCursor, expiresAt ~1hr ahead, providerSubscriptionId='poll' on success", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-15T12:00:00.000Z") });
    const adapter = createAdapter();
    const emx = makeEmx();

    const result = await adapter.activate(emx);

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    // syncState = { uidvalidity, lastUid: uidNext - 1 } = { uidvalidity: 123, lastUid: 42 }
    expect(value.syncState).toEqual({ uidvalidity: 123, lastUid: 42 });
    // syncCursor is kept as a human-readable parallel to syncState, not replaced by it
    expect(value.syncCursor).toBe("123:42");
    expect(value.providerSubscriptionId).toBe("poll");
    // Read off imapConfig.username directly — IMAP has no separate identity to verify against.
    expect(value.emailAddress).toBe("user@example.com");
    // expiresAt should be pinned time + 15min polling interval
    expect(value.expiresAt).toBe("2026-06-15T12:15:00.000Z");
    vi.useRealTimers();
  });

  it("returns activation_failed with 'host unreachable' on timeout", async () => {
    const adapter = createAdapter();
    const emx = makeEmx();
    mockClient.connect.mockRejectedValue(new Error("Connection timeout after 10000ms"));

    const result = await adapter.activate(emx);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_activation_failed");
    expect(error.cause).toBe("host unreachable");
  });

  it("returns activation_failed with 'invalid credentials' on auth failure", async () => {
    const adapter = createAdapter();
    const emx = makeEmx();
    const authError = new Error("Authentication failed");
    (authError as unknown as { authenticationFailed: boolean }).authenticationFailed = true;
    mockClient.connect.mockRejectedValue(authError);

    const result = await adapter.activate(emx);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_activation_failed");
    expect(error.cause).toBe("invalid credentials");
  });
});

describe("ImapAdapter.renew", () => {
  it("returns error when UIDVALIDITY mismatches stored cursor (Property 6)", async () => {
    const adapter = createAdapter();
    // Stored cursor has uidvalidity=100, server returns 200. Deliberately uses the legacy
    // colon-delimited syncCursor string (rather than syncState) to also cover the fallback path.
    const emx = makeEmx({ syncCursor: "100:50" });
    mockMailbox.uidValidity = BigInt(200);

    const result = await adapter.renew(emx);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_renewal_failed");
    expect(error.cause).toContain("UIDVALIDITY changed");
  });

  it("enqueues at most 500 messages when server returns more (Property 7)", async () => {
    const adapter = createAdapter();
    const emx = makeEmx({ syncState: { uidvalidity: 123, lastUid: 0 } });
    mockMailbox.uidValidity = BigInt(123);
    // Server returns 600 UIDs (1–600)
    const allUids = Array.from({ length: 600 }, (_, i) => i + 1);
    mockClient.search.mockResolvedValue(allUids);

    const result = await adapter.renew(emx);

    expect(result.isOk()).toBe(true);
    // Only 500 should be enqueued (via single batch call)
    expect(mockSignalQueue.sendBatch).toHaveBeenCalledTimes(1);
    expect(mockSignalQueue.sendBatch.mock.calls[0]![1]).toHaveLength(500);
    // Cursor should advance to the 500th UID -- both representations, kept in sync
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      expect.objectContaining({ syncCursor: "123:500", syncState: { uidvalidity: 123, lastUid: 500 } }),
    );
  });

  it("advances syncCursor and syncState to highest UID enqueued", async () => {
    const adapter = createAdapter();
    const emx = makeEmx({ syncState: { uidvalidity: 123, lastUid: 42 } });
    mockMailbox.uidValidity = BigInt(123);
    mockClient.search.mockResolvedValue([43, 44, 45]);

    const result = await adapter.renew(emx);

    expect(result.isOk()).toBe(true);
    expect(mockSignalQueue.sendBatch).toHaveBeenCalledTimes(1);
    expect(mockSignalQueue.sendBatch.mock.calls[0]![1]).toHaveLength(3);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      expect.objectContaining({ syncCursor: "123:45", syncState: { uidvalidity: 123, lastUid: 45 } }),
    );
  });
});

describe("ImapAdapter.fetchMessage", () => {
  it("returns provider_message_not_found when fetchOne returns null (expunged)", async () => {
    const adapter = createAdapter();
    const emx = makeEmx();
    mockClient.fetchOne.mockResolvedValue(null);

    const result = await adapter.fetchMessage("99", emx);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_message_not_found");
  });
});

describe("ImapAdapter.deactivate", () => {
  it("returns ok(undefined) without any network calls", async () => {
    const adapter = createAdapter();
    const emx = makeEmx();

    const result = await adapter.deactivate(emx);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
    // No ImapFlow methods should be called
    expect(mockClient.connect).not.toHaveBeenCalled();
    expect(mockClient.logout).not.toHaveBeenCalled();
  });
});
