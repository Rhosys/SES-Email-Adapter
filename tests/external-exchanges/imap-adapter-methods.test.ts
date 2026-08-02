import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok } from "neverthrow";
import { DateTime } from "luxon";
import type { ExternalMailExchange } from "../../src/types/index.js";
import type { Logger } from "../../src/logger.js";

// ---------------------------------------------------------------------------
// Mock imapflow — must be before ImapAdapter import
// ---------------------------------------------------------------------------

const mockMailbox = { uidValidity: BigInt(123), uidNext: 43, exists: 42 };
const mockLock = { release: vi.fn() };
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  getMailboxLock: vi.fn().mockResolvedValue(mockLock),
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
  decrypt: vi.fn().mockReturnValue("decrypted-password"),
  encrypt: vi.fn().mockReturnValue("encrypted"),
  init: vi.fn().mockResolvedValue(undefined),
};

const mockDb = {
  getExternalExchange: vi.fn(),
  updateExternalExchange: vi.fn().mockResolvedValue(ok({} as ExternalMailExchange)),
};

const mockSignalQueue = {
  send: vi.fn().mockResolvedValue(ok(undefined)),
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
    syncCursor: "123:42",
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
  mockClient.getMailboxLock.mockResolvedValue(mockLock);
  mockClient.logout.mockResolvedValue(undefined);
  mockClient.search.mockResolvedValue([]);
  mockClient.fetchOne.mockResolvedValue(null);
  (mockClient as { mailbox: typeof mockMailbox }).mailbox = mockMailbox;
});

describe("ImapAdapter.activate", () => {
  it("returns syncCursor, expiresAt ~1hr ahead, providerSubscriptionId='poll' on success", async () => {
    const adapter = createAdapter();
    const emx = makeEmx();
    const before = DateTime.utc();

    const result = await adapter.activate("", emx);

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    // syncCursor = "{uidvalidity}:{uidNext - 1}" = "123:42"
    expect(value.syncCursor).toBe("123:42");
    expect(value.providerSubscriptionId).toBe("poll");
    // expiresAt should be ~1hr from now
    const expiresAt = DateTime.fromISO(value.expiresAt);
    const diffMinutes = expiresAt.diff(before, "minutes").minutes;
    expect(diffMinutes).toBeGreaterThan(55);
    expect(diffMinutes).toBeLessThan(65);
  });

  it("returns activation_failed with 'host unreachable' on timeout", async () => {
    const adapter = createAdapter();
    const emx = makeEmx();
    mockClient.connect.mockRejectedValue(new Error("Connection timeout after 10000ms"));

    const result = await adapter.activate("", emx);

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

    const result = await adapter.activate("", emx);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_activation_failed");
    expect(error.cause).toBe("invalid credentials");
  });
});

describe("ImapAdapter.renew", () => {
  it("returns error when UIDVALIDITY mismatches stored cursor (Property 6)", async () => {
    const adapter = createAdapter();
    // Stored cursor has uidvalidity=100, server returns 200
    const emx = makeEmx({ syncCursor: "100:50" });
    mockMailbox.uidValidity = BigInt(200);

    const result = await adapter.renew("", emx);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_renewal_failed");
    expect(error.cause).toContain("UIDVALIDITY changed");
  });

  it("enqueues at most 500 messages when server returns more (Property 7)", async () => {
    const adapter = createAdapter();
    const emx = makeEmx({ syncCursor: "123:0" });
    mockMailbox.uidValidity = BigInt(123);
    // Server returns 600 UIDs (1–600)
    const allUids = Array.from({ length: 600 }, (_, i) => i + 1);
    mockClient.search.mockResolvedValue(allUids);

    const result = await adapter.renew("", emx);

    expect(result.isOk()).toBe(true);
    // Only 500 should be enqueued
    expect(mockSignalQueue.send).toHaveBeenCalledTimes(500);
    // Cursor should advance to the 500th UID
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      expect.objectContaining({ syncCursor: "123:500" }),
    );
  });

  it("advances syncCursor to highest UID enqueued", async () => {
    const adapter = createAdapter();
    const emx = makeEmx({ syncCursor: "123:42" });
    mockMailbox.uidValidity = BigInt(123);
    mockClient.search.mockResolvedValue([43, 44, 45]);

    const result = await adapter.renew("", emx);

    expect(result.isOk()).toBe(true);
    expect(mockSignalQueue.send).toHaveBeenCalledTimes(3);
    expect(mockDb.updateExternalExchange).toHaveBeenCalledWith(
      "acct-1",
      "emx_testABC123",
      expect.objectContaining({ syncCursor: "123:45" }),
    );
  });
});

describe("ImapAdapter.fetchMessage", () => {
  it("returns provider_message_not_found when fetchOne returns null (expunged)", async () => {
    const adapter = createAdapter();
    mockDb.getExternalExchange.mockResolvedValue(ok(makeEmx()));
    mockClient.fetchOne.mockResolvedValue(null);

    const result = await adapter.fetchMessage("acct-1", "emx_testABC123:99");

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe("provider_message_not_found");
  });
});

describe("ImapAdapter.deactivate", () => {
  it("returns ok(undefined) without any network calls", async () => {
    const adapter = createAdapter();
    const emx = makeEmx();

    const result = await adapter.deactivate("", emx);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
    // No ImapFlow methods should be called
    expect(mockClient.connect).not.toHaveBeenCalled();
    expect(mockClient.logout).not.toHaveBeenCalled();
  });
});
